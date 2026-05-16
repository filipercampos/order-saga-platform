import { randomUUID } from 'node:crypto';
import { PublishCommand } from '@aws-sdk/client-sns';
import { GetQueueAttributesCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import { createEnvelope } from '@saga/contracts';
import { Queues, Topics, physicalName, redriveDlq } from '@saga/messaging';
import { Client } from 'pg';
import {
  HISTORY_COLLECTION,
  OrderHistoryDocument,
  project,
} from '../apps/order/src/history/order-history.projector';
import { replayProjection } from '../apps/order/src/history/replay';
import {
  Platform,
  isTerminal,
  placeOrder,
  product,
  seedCustomer,
  seedProduct,
  startPlatform,
  waitFor,
  waitForOrder,
} from './support/platform';

jest.setTimeout(180_000);

describe('delivery guarantees: duplicates, poison messages, replay', () => {
  let platform: Platform;

  beforeAll(async () => {
    platform = await startPlatform();
  });

  afterAll(async () => {
    await platform?.stop();
  });

  async function query<T>(database: string, text: string, params: unknown[] = []): Promise<T[]> {
    const client = new Client({ connectionString: platform.pgUrl(database) });
    await client.connect();
    try {
      return (await client.query(text, params)).rows as T[];
    } finally {
      await client.end();
    }
  }

  async function depth(queueUrl: string): Promise<number> {
    const out = await platform.aws.sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
      }),
    );
    return (
      Number(out.Attributes?.ApproximateNumberOfMessages ?? 0) +
      Number(out.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0)
    );
  }

  const topicArn = (topic: string) =>
    `arn:aws:sns:us-east-1:000000000000:${physicalName(platform.namespace, topic)}`;

  it('applies a command delivered twice exactly once (inbox)', async () => {
    await seedProduct(platform, 'SKU-DUP', 10);
    const orderId = randomUUID();
    const command = createEnvelope({
      type: 'inventory.ReserveStock',
      payload: { orderId, items: [{ sku: 'SKU-DUP', quantity: 2 }] },
      producer: 'order-service',
      correlationId: orderId,
    });

    // Same envelope, two SNS publishes with different deduplication ids: this is what an
    // outbox relay crash after publish (but before marking the row) looks like.
    for (let i = 0; i < 2; i += 1) {
      await platform.aws.sns.send(
        new PublishCommand({
          TopicArn: topicArn(Topics.sagaCommands),
          Message: JSON.stringify(command),
          MessageGroupId: orderId,
          MessageDeduplicationId: randomUUID(),
          MessageAttributes: {
            target: { DataType: 'String', StringValue: 'inventory' },
            type: { DataType: 'String', StringValue: command.type },
          },
        }),
      );
    }

    const queueUrl = platform.topology.queueUrls[Queues.inventoryCommands] ?? '';
    await waitFor(async () => (await product(platform, 'SKU-DUP')).reserved > 0);
    await waitFor(
      async () => (await depth(queueUrl)) === 0,
      30_000,
      () => 'queue drained',
    );

    expect(await product(platform, 'SKU-DUP')).toMatchObject({ available: 8, reserved: 2 });
    const inbox = await query('inventory', 'SELECT 1 FROM inbox WHERE event_id = $1', [
      command.eventId,
    ]);
    expect(inbox).toHaveLength(1);
    const replies = await query(
      'inventory',
      `SELECT 1 FROM outbox WHERE body->>'correlationId' = $1 AND message_type = 'inventory.StockReserved'`,
      [orderId],
    );
    expect(replies).toHaveLength(1);
  });

  it('ignores a duplicated reply at the orchestrator', async () => {
    await seedProduct(platform, 'SKU-REPLY', 10);
    const customer = await seedCustomer(platform, 100_000n);
    const orderId = await placeOrder(platform, customer, [{ sku: 'SKU-REPLY', quantity: 1 }]);
    await waitForOrder(platform, customer, orderId, isTerminal);

    const [reserved] = await query<{ body: unknown }>(
      'inventory',
      `SELECT body FROM outbox WHERE body->>'correlationId' = $1 AND message_type = 'inventory.StockReserved'`,
      [orderId],
    );
    await platform.aws.sns.send(
      new PublishCommand({
        TopicArn: topicArn(Topics.inventoryEvents),
        Message: JSON.stringify(reserved?.body),
        MessageAttributes: {
          type: { DataType: 'String', StringValue: 'inventory.StockReserved' },
        },
      }),
    );
    const repliesQueue = platform.topology.queueUrls[Queues.orderSagaReplies] ?? '';
    await waitFor(
      async () => (await depth(repliesQueue)) === 0,
      30_000,
      () => 'replies drained',
    );

    const transitions = await query(
      'orders',
      'SELECT 1 FROM saga_transitions WHERE order_id = $1',
      [orderId],
    );
    expect(transitions).toHaveLength(3);
    expect(
      platform.ledger.transactions.filter((t) => t.reference === `order-${orderId}`),
    ).toHaveLength(1);
  });

  it('moves a poison message to the DLQ quickly and keeps consuming', async () => {
    const queueUrl = platform.topology.queueUrls[Queues.inventoryCommands] ?? '';
    const dlqUrl = platform.topology.dlqUrls[Queues.inventoryCommands] ?? '';
    await platform.aws.sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: '{"this is": "not an envelope"',
        MessageGroupId: 'poison-group',
        MessageDeduplicationId: randomUUID(),
      }),
    );

    const started = Date.now();
    await waitFor(
      async () => (await depth(dlqUrl)) === 1,
      60_000,
      () => 'message in DLQ',
    );
    // maxReceiveCount=3 with visibility 0 on poison: seconds, not minutes.
    expect(Date.now() - started).toBeLessThan(30_000);

    // Other orders (other message groups) are unaffected.
    await seedProduct(platform, 'SKU-AFTER-POISON', 3);
    const customer = await seedCustomer(platform, 100_000n);
    const orderId = await placeOrder(platform, customer, [
      { sku: 'SKU-AFTER-POISON', quantity: 1 },
    ]);
    expect(await waitForOrder(platform, customer, orderId, isTerminal)).toMatchObject({
      status: 'CONFIRMED',
    });

    // Redrive tool moves it back; still poison, so it returns to the DLQ.
    const moved = await redriveDlq(platform.aws.sqs, {
      dlqUrl,
      targetUrl: queueUrl,
      fifo: true,
      limit: 10,
    });
    expect(moved).toBe(1);
    await waitFor(
      async () => (await depth(dlqUrl)) === 1,
      60_000,
      () => 'back in DLQ',
    );
  });

  it('rebuilds the read model from the event archive with identical results', async () => {
    const db = platform.mongo.db('order_history');
    const history = db.collection<OrderHistoryDocument>(HISTORY_COLLECTION);
    await waitFor(async () => (await history.countDocuments({ status: 'CONFIRMED' })) >= 2);
    // Let in-flight events settle so before/after compare the same input.
    const queueUrl = platform.topology.queueUrls[Queues.orderHistory] ?? '';
    await waitFor(
      async () => (await depth(queueUrl)) === 0,
      30_000,
      () => 'projection drained',
    );

    const normalize = (docs: OrderHistoryDocument[]) =>
      docs
        .map((doc) => ({
          ...doc,
          timeline: doc.timeline.map((e) => e.eventId).sort(),
        }))
        .sort((a, b) => a._id.localeCompare(b._id));
    const before = normalize(await history.find({}).toArray());

    const result = await replayProjection(db);
    const after = normalize(await history.find({}).toArray());

    expect(result.orders).toBe(before.length);
    expect(after).toEqual(before);
  });

  it('projects out-of-order status events by orderVersion', async () => {
    const db = platform.mongo.db('order_history_unit');
    const collection = db.collection<OrderHistoryDocument>(HISTORY_COLLECTION);
    const orderId = randomUUID();
    const status = (version: number, sagaState: string, s: 'PENDING' | 'CONFIRMED') =>
      createEnvelope({
        type: 'order.OrderStatusChanged',
        payload: { orderId, customerId: 'c', status: s, sagaState, orderVersion: version },
        producer: 'order-service',
        correlationId: orderId,
      });

    const newer = status(3, 'CONFIRMED', 'CONFIRMED');
    await project(collection, newer);
    await project(collection, status(2, 'CHARGING_PAYMENT', 'PENDING'));
    await project(collection, newer); // duplicate

    const doc = await collection.findOne({ _id: orderId });
    expect(doc).toMatchObject({ status: 'CONFIRMED', version: 3 });
    expect(doc?.timeline).toHaveLength(2);
  });
});

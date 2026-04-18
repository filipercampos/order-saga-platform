import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { createEnvelope } from '@saga/contracts';
import { randomUUID } from 'node:crypto';
import { PoisonMessageError, ReceivedMessage, SqsConsumer, envelopeHandler } from './sqs-consumer';

type Sent = ReceiveMessageCommand | DeleteMessageCommand | ChangeMessageVisibilityCommand;

function fakeSqs(bodies: { body: string; receiveCount?: number }[]) {
  const sent: Sent[] = [];
  let delivered = false;
  const sqs = {
    send: jest.fn((command: Sent) => {
      sent.push(command);
      if (command instanceof ReceiveMessageCommand) {
        if (delivered) return new Promise((resolve) => setTimeout(() => resolve({}), 20));
        delivered = true;
        return Promise.resolve({
          Messages: bodies.map((b, i) => ({
            MessageId: `m${i}`,
            ReceiptHandle: `r${i}`,
            Body: b.body,
            Attributes: { ApproximateReceiveCount: String(b.receiveCount ?? 1) },
            MessageAttributes: { correlationId: { DataType: 'String', StringValue: 'order-1' } },
          })),
        });
      }
      return Promise.resolve({});
    }),
  } as unknown as SQSClient;
  return { sqs, sent };
}

async function runOnce(
  bodies: { body: string; receiveCount?: number }[],
  handler: (m: ReceivedMessage) => Promise<void>,
) {
  const { sqs, sent } = fakeSqs(bodies);
  const outcomes: string[] = [];
  const consumer = new SqsConsumer({
    name: 'test',
    sqs,
    queueUrl: () => Promise.resolve('http://queue'),
    fifo: true,
    handler,
    visibilityTimeoutSeconds: 30,
    retryBaseSeconds: 2,
    onOutcome: (outcome) => outcomes.push(outcome),
  });
  consumer.start();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await consumer.stop();
  return { sent, outcomes };
}

const valid = JSON.stringify(
  createEnvelope({
    type: 'inventory.CommitStock',
    payload: { orderId: randomUUID() },
    producer: 'test',
    correlationId: 'order-1',
  }),
);

describe('SqsConsumer', () => {
  it('deletes a message after the handler succeeds', async () => {
    const handled: string[] = [];
    const { sent, outcomes } = await runOnce(
      [{ body: valid }],
      envelopeHandler((envelope) => {
        handled.push(envelope.type);
        return Promise.resolve();
      }),
    );
    expect(handled).toEqual(['inventory.CommitStock']);
    expect(outcomes).toEqual(['processed']);
    const deleted = sent.find((c) => c instanceof DeleteMessageCommand);
    expect(deleted?.input).toMatchObject({ ReceiptHandle: 'r0' });
  });

  it('sends malformed messages back with visibility 0 so redrive moves them to the DLQ', async () => {
    const { sent, outcomes } = await runOnce(
      [{ body: '{not json' }],
      envelopeHandler(() => Promise.resolve()),
    );
    expect(outcomes).toEqual(['poison']);
    expect(sent.some((c) => c instanceof DeleteMessageCommand)).toBe(false);
    const visibility = sent.find((c) => c instanceof ChangeMessageVisibilityCommand);
    expect(visibility?.input).toMatchObject({ ReceiptHandle: 'r0', VisibilityTimeout: 0 });
  });

  it('treats PoisonMessageError from a handler the same way', async () => {
    const { outcomes } = await runOnce([{ body: valid }], () =>
      Promise.reject(new PoisonMessageError('business rule says never')),
    );
    expect(outcomes).toEqual(['poison']);
  });

  it('backs off transient failures based on the receive count', async () => {
    const { sent, outcomes } = await runOnce([{ body: valid, receiveCount: 3 }], () =>
      Promise.reject(new Error('db down')),
    );
    expect(outcomes).toEqual(['retry']);
    const visibility = sent.find((c) => c instanceof ChangeMessageVisibilityCommand);
    const seconds = (visibility as ChangeMessageVisibilityCommand).input.VisibilityTimeout ?? 0;
    expect(seconds).toBeGreaterThanOrEqual(1);
    expect(seconds).toBeLessThanOrEqual(16);
  });
});

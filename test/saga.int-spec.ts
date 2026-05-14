import { Client } from 'pg';
import request from 'supertest';
import {
  MERCHANT_ACCOUNT,
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

describe('order saga end to end (Postgres + MongoDB + LocalStack SNS/SQS)', () => {
  let platform: Platform;

  beforeAll(async () => {
    platform = await startPlatform();
  });

  afterAll(async () => {
    await platform?.stop();
  });

  afterEach(() => {
    platform.ledger.mode = { kind: 'ok' };
  });

  async function transitions(orderId: string) {
    const client = new Client({ connectionString: platform.pgUrl('orders') });
    await client.connect();
    try {
      const { rows } = await client.query<{ to_state: string }>(
        'SELECT to_state FROM saga_transitions WHERE order_id = $1 ORDER BY id',
        [orderId],
      );
      return rows.map((row) => row.to_state);
    } finally {
      await client.end();
    }
  }

  it('happy path: reserves stock, charges the ledger once, confirms, notifies and projects', async () => {
    await seedProduct(platform, 'SKU-HAPPY', 10, '1500');
    const customer = await seedCustomer(platform, 100_000n);

    const orderId = await placeOrder(platform, customer, [{ sku: 'SKU-HAPPY', quantity: 2 }]);
    const order = await waitForOrder(platform, customer, orderId, isTerminal);

    expect(order).toMatchObject({ status: 'CONFIRMED', sagaState: 'CONFIRMED', total: '3000' });
    expect(await transitions(orderId)).toEqual([
      'RESERVING_STOCK',
      'CHARGING_PAYMENT',
      'CONFIRMED',
    ]);

    // Money moved exactly once.
    const charges = platform.ledger.transactions.filter((t) => t.reference === `order-${orderId}`);
    expect(charges).toHaveLength(1);
    expect(platform.ledger.balance(`wallet-${customer}`)).toBe(97_000n);
    expect(platform.ledger.balance(MERCHANT_ACCOUNT)).toBeGreaterThanOrEqual(3_000n);

    // Stock committed: no longer available, no longer reserved.
    await waitFor(async () => (await product(platform, 'SKU-HAPPY')).reserved === 0);
    expect(await product(platform, 'SKU-HAPPY')).toMatchObject({ available: 8, reserved: 0 });

    await waitFor(() => platform.notifications.sent.includes(`order-confirmed:${orderId}`));

    // Read model converges: status plus a cross-service timeline.
    let history: { status?: string; timeline: { type: string }[] } | undefined;
    await waitFor(async () => {
      const res = await request(platform.order.getHttpServer())
        .get(`/orders/${orderId}/history`)
        .set('Authorization', `Bearer ${customer}`);
      history = res.status === 200 ? res.body : undefined;
      return history?.status === 'CONFIRMED' && history.timeline.length >= 7;
    });
    expect(history?.timeline.map((e) => e.type)).toEqual(
      expect.arrayContaining([
        'order.OrderPlaced',
        'inventory.StockReserved',
        'payment.PaymentCharged',
        'order.OrderConfirmed',
      ]),
    );
  });

  it('out of stock: cancels without charging anything', async () => {
    await seedProduct(platform, 'SKU-SCARCE', 1);
    const customer = await seedCustomer(platform, 100_000n);

    const orderId = await placeOrder(platform, customer, [{ sku: 'SKU-SCARCE', quantity: 5 }]);
    const order = await waitForOrder(platform, customer, orderId, isTerminal);

    expect(order).toMatchObject({ status: 'CANCELLED', cancelReason: 'stock_out_of_stock' });
    expect(await transitions(orderId)).toEqual(['RESERVING_STOCK', 'CANCELLED']);
    expect(platform.ledger.requests.some((r) => r.key === `charge-${orderId}`)).toBe(false);
    expect(await product(platform, 'SKU-SCARCE')).toMatchObject({ available: 1, reserved: 0 });
    await waitFor(() => platform.notifications.sent.includes(`order-cancelled:${orderId}`));
  });

  it('payment declined: compensates by releasing the reserved stock', async () => {
    await seedProduct(platform, 'SKU-DECLINE', 5, '2500');
    const customer = await seedCustomer(platform, 1_000n); // cannot afford 2500

    const orderId = await placeOrder(platform, customer, [{ sku: 'SKU-DECLINE', quantity: 1 }]);
    const order = await waitForOrder(platform, customer, orderId, isTerminal);

    expect(order).toMatchObject({
      status: 'CANCELLED',
      cancelReason: 'payment_insufficient_funds',
    });
    expect(await transitions(orderId)).toEqual([
      'RESERVING_STOCK',
      'CHARGING_PAYMENT',
      'RELEASING_STOCK',
      'CANCELLED',
    ]);
    expect(await product(platform, 'SKU-DECLINE')).toMatchObject({ available: 5, reserved: 0 });
    expect(platform.ledger.balance(`wallet-${customer}`)).toBe(1_000n);
  });

  it('payment timeout: refunds the charge that did happen, then releases stock', async () => {
    await seedProduct(platform, 'SKU-SLOW', 5, '4000');
    const customer = await seedCustomer(platform, 50_000n);

    // The ledger commits but answers after the client timeout: the charge happened,
    // the payment service never learns it, and the saga deadline expires.
    platform.ledger.mode = { kind: 'slow', delayMs: 2_000 };
    const orderId = await placeOrder(platform, customer, [{ sku: 'SKU-SLOW', quantity: 1 }]);

    await waitForOrder(platform, customer, orderId, (o) => o.sagaState === 'REFUNDING_PAYMENT');
    // Ledger recovers; the refund resolves the unknown charge and reverses it.
    platform.ledger.mode = { kind: 'ok' };
    const order = await waitForOrder(platform, customer, orderId, isTerminal, 60_000);

    expect(order).toMatchObject({ status: 'CANCELLED', cancelReason: 'payment_timeout' });
    expect(await transitions(orderId)).toEqual([
      'RESERVING_STOCK',
      'CHARGING_PAYMENT',
      'REFUNDING_PAYMENT',
      'RELEASING_STOCK',
      'CANCELLED',
    ]);

    const charge = platform.ledger.transactions.filter((t) => t.reference === `order-${orderId}`);
    expect(charge).toHaveLength(1);
    const reversals = platform.ledger.transactions.filter((t) => t.reversalOf === charge[0]?.id);
    expect(reversals).toHaveLength(1);
    // Net effect on the customer is zero, and the stock is back.
    expect(platform.ledger.balance(`wallet-${customer}`)).toBe(50_000n);
    expect(await product(platform, 'SKU-SLOW')).toMatchObject({ available: 5, reserved: 0 });
  });

  it('rejects a reused Idempotency-Key with a different body and replays the same one', async () => {
    await seedProduct(platform, 'SKU-IDEM', 5);
    const customer = await seedCustomer(platform, 100_000n);
    const server = platform.order.getHttpServer();
    const send = (quantity: number) =>
      request(server)
        .post('/orders')
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', 'same-key-123')
        .send({ items: [{ sku: 'SKU-IDEM', quantity }] });

    const first = await send(1).expect(202);
    const replay = await send(1).expect(202);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.orderId).toBe(first.body.orderId);
    await send(2).expect(422);
  });
});

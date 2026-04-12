import { randomUUID } from 'node:crypto';
import { createEnvelope, MessagePayload } from '@saga/contracts';
import {
  SagaReply,
  SagaSnapshot,
  SagaState,
  SagaTimeouts,
  TransitionResult,
  startSaga,
  statusOf,
  transition,
} from './saga-machine';

const timeouts: SagaTimeouts = {
  reserveMs: 30_000,
  chargeMs: 60_000,
  compensationMs: 10_000,
  maxCompensationAttempts: 3,
};
const t0 = new Date('2026-04-12T12:00:00Z');
const orderId = randomUUID();

function reply<T extends SagaReply['type']>(type: T, payload: MessagePayload<T>): SagaReply {
  return createEnvelope({ type, payload, producer: 'test', correlationId: orderId }) as SagaReply;
}

function snapshot(state: SagaState, patch: Partial<SagaSnapshot> = {}): SagaSnapshot {
  return {
    ...startSaga({ orderId, customerId: 'c-1', items: [{ sku: 'A', quantity: 1 }] }, t0, timeouts)
      .snapshot,
    state,
    ...patch,
  };
}

function expectTransition(result: TransitionResult) {
  if (result.kind !== 'transition') throw new Error(`ignored: ${result.reason}`);
  return result;
}

const reserved = reply('inventory.StockReserved', {
  orderId,
  lines: [{ sku: 'A', quantity: 1, unitPrice: '1500' }],
  total: '1500',
  currency: 'BRL',
});

describe('order saga', () => {
  it('starts by reserving stock with a deadline', () => {
    const { snapshot: saga, commands } = startSaga(
      { orderId, customerId: 'c-1', items: [{ sku: 'A', quantity: 1 }] },
      t0,
      timeouts,
    );
    expect(saga.state).toBe('RESERVING_STOCK');
    expect(saga.deadlineAt).toEqual(new Date(t0.getTime() + 30_000));
    expect(commands.map((c) => c.type)).toEqual(['inventory.ReserveStock']);
  });

  describe('happy path', () => {
    it('charges the reserved total, then confirms and commits stock', () => {
      const charging = expectTransition(
        transition(snapshot('RESERVING_STOCK'), { kind: 'reply', reply: reserved }, t0, timeouts),
      );
      expect(charging.next).toMatchObject({ state: 'CHARGING_PAYMENT', total: '1500', version: 2 });
      expect(charging.commands).toEqual([
        {
          type: 'payment.ChargePayment',
          payload: { orderId, customerId: 'c-1', amount: '1500', currency: 'BRL' },
        },
      ]);

      const confirmed = expectTransition(
        transition(
          charging.next,
          {
            kind: 'reply',
            reply: reply('payment.PaymentCharged', {
              orderId,
              ledgerTransactionId: 'tx-1',
              amount: '1500',
              currency: 'BRL',
            }),
          },
          t0,
          timeouts,
        ),
      );
      expect(confirmed.next).toMatchObject({ state: 'CONFIRMED', deadlineAt: null, version: 3 });
      expect(confirmed.commands.map((c) => c.type)).toEqual(['inventory.CommitStock']);
    });
  });

  describe('compensations', () => {
    it('cancels without compensation when stock is rejected', () => {
      const result = expectTransition(
        transition(
          snapshot('RESERVING_STOCK'),
          {
            kind: 'reply',
            reply: reply('inventory.StockReservationRejected', { orderId, reason: 'out_of_stock' }),
          },
          t0,
          timeouts,
        ),
      );
      expect(result.next).toMatchObject({ state: 'CANCELLED', cancelReason: 'stock_out_of_stock' });
      expect(result.commands).toEqual([]);
    });

    it('releases stock when payment is declined', () => {
      const result = expectTransition(
        transition(
          snapshot('CHARGING_PAYMENT'),
          {
            kind: 'reply',
            reply: reply('payment.PaymentDeclined', { orderId, reason: 'insufficient_funds' }),
          },
          t0,
          timeouts,
        ),
      );
      expect(result.next).toMatchObject({
        state: 'RELEASING_STOCK',
        cancelReason: 'payment_insufficient_funds',
      });
      expect(result.commands[0]?.type).toBe('inventory.ReleaseStock');
    });

    it('refunds then releases when the payment step times out', () => {
      const late = new Date(t0.getTime() + 61_000);
      const charging = snapshot('CHARGING_PAYMENT', {
        deadlineAt: new Date(t0.getTime() + 60_000),
      });
      const refunding = expectTransition(transition(charging, { kind: 'timeout' }, late, timeouts));
      expect(refunding.next).toMatchObject({
        state: 'REFUNDING_PAYMENT',
        cancelReason: 'payment_timeout',
      });
      expect(refunding.commands[0]?.type).toBe('payment.RefundPayment');

      const releasing = expectTransition(
        transition(
          refunding.next,
          { kind: 'reply', reply: reply('payment.PaymentRefunded', { orderId, refunded: true }) },
          late,
          timeouts,
        ),
      );
      expect(releasing.next.state).toBe('RELEASING_STOCK');

      const cancelled = expectTransition(
        transition(
          releasing.next,
          { kind: 'reply', reply: reply('inventory.StockReleased', { orderId, restocked: true }) },
          late,
          timeouts,
        ),
      );
      expect(cancelled.next).toMatchObject({ state: 'CANCELLED', cancelReason: 'payment_timeout' });
    });

    it('releases stock when the reservation step times out', () => {
      const late = new Date(t0.getTime() + 31_000);
      const result = expectTransition(
        transition(snapshot('RESERVING_STOCK'), { kind: 'timeout' }, late, timeouts),
      );
      expect(result.next).toMatchObject({
        state: 'RELEASING_STOCK',
        cancelReason: 'stock_timeout',
      });
    });
  });

  describe('timeouts and retries', () => {
    it('ignores a timeout before the deadline', () => {
      expect(transition(snapshot('RESERVING_STOCK'), { kind: 'timeout' }, t0, timeouts).kind).toBe(
        'ignored',
      );
    });

    it('retries a compensation with backoff, then fails and can be resumed by an operator', () => {
      let saga = snapshot('RELEASING_STOCK', { attempts: 1, deadlineAt: t0, cancelReason: 'x' });
      let now = t0;
      const delays: number[] = [];
      while (saga.state === 'RELEASING_STOCK') {
        const result = expectTransition(transition(saga, { kind: 'timeout' }, now, timeouts));
        if (result.next.deadlineAt) delays.push(result.next.deadlineAt.getTime() - now.getTime());
        saga = result.next;
        now = saga.deadlineAt ?? now;
      }
      expect(delays).toEqual([20_000, 40_000]);
      expect(saga).toMatchObject({ state: 'FAILED', resumeState: 'RELEASING_STOCK' });
      expect(statusOf(saga.state)).toBe('FAILED');

      const resumed = expectTransition(transition(saga, { kind: 'operator_retry' }, now, timeouts));
      expect(resumed.next).toMatchObject({ state: 'RELEASING_STOCK', attempts: 1 });
      expect(resumed.commands[0]?.type).toBe('inventory.ReleaseStock');
    });
  });

  describe('duplicates and out-of-order replies', () => {
    const cases: [SagaState, SagaReply][] = [
      ['CHARGING_PAYMENT', reserved],
      ['CONFIRMED', reserved],
      ['CANCELLED', reply('inventory.StockReleased', { orderId, restocked: true })],
      [
        'REFUNDING_PAYMENT',
        reply('payment.PaymentCharged', {
          orderId,
          ledgerTransactionId: 'tx',
          amount: '1',
          currency: 'BRL',
        }),
      ],
      ['RELEASING_STOCK', reserved],
    ];
    it.each(cases)('ignores in %s: %s', (state, message) => {
      expect(
        transition(snapshot(state), { kind: 'reply', reply: message }, t0, timeouts).kind,
      ).toBe('ignored');
    });
  });
});

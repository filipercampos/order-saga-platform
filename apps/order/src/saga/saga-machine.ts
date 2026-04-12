import type { LineItem, MessagePayload, TypedEnvelope } from '@saga/contracts';

/**
 * The order saga as a pure function. No I/O, no clock: callers pass `now` and persist
 * whatever comes out. See ADR 0002 for the state diagram.
 */
export type SagaState =
  | 'RESERVING_STOCK'
  | 'CHARGING_PAYMENT'
  | 'CONFIRMED'
  | 'REFUNDING_PAYMENT'
  | 'RELEASING_STOCK'
  | 'CANCELLED'
  | 'FAILED';

export type OrderStatus = 'PENDING' | 'CONFIRMED' | 'CANCELLING' | 'CANCELLED' | 'FAILED';

export const TERMINAL_STATES: readonly SagaState[] = ['CONFIRMED', 'CANCELLED'];

export function statusOf(state: SagaState): OrderStatus {
  switch (state) {
    case 'RESERVING_STOCK':
    case 'CHARGING_PAYMENT':
      return 'PENDING';
    case 'REFUNDING_PAYMENT':
    case 'RELEASING_STOCK':
      return 'CANCELLING';
    case 'CONFIRMED':
    case 'CANCELLED':
    case 'FAILED':
      return state;
  }
}

export interface SagaSnapshot {
  orderId: string;
  customerId: string;
  items: LineItem[];
  state: SagaState;
  /** Incremented on every transition; optimistic version and read-model ordering key. */
  version: number;
  /** Attempts of the current step (compensation retries). */
  attempts: number;
  deadlineAt: Date | null;
  cancelReason: string | null;
  total: string | null;
  currency: string | null;
  /** Compensation step to resume when an operator retries a FAILED saga. */
  resumeState: SagaState | null;
}

export interface SagaTimeouts {
  reserveMs: number;
  chargeMs: number;
  compensationMs: number;
  maxCompensationAttempts: number;
}

type CommandType =
  | 'inventory.ReserveStock'
  | 'inventory.ReleaseStock'
  | 'inventory.CommitStock'
  | 'payment.ChargePayment'
  | 'payment.RefundPayment';

export type SagaCommand = {
  [T in CommandType]: { type: T; payload: MessagePayload<T> };
}[CommandType];

type ReplyType =
  | 'inventory.StockReserved'
  | 'inventory.StockReservationRejected'
  | 'inventory.StockReleased'
  | 'payment.PaymentCharged'
  | 'payment.PaymentDeclined'
  | 'payment.PaymentRefunded';

export type SagaReply = Extract<TypedEnvelope, { type: ReplyType }>;

export const REPLY_TYPES: readonly string[] = [
  'inventory.StockReserved',
  'inventory.StockReservationRejected',
  'inventory.StockReleased',
  'payment.PaymentCharged',
  'payment.PaymentDeclined',
  'payment.PaymentRefunded',
] satisfies ReplyType[];

export function isSagaReply(envelope: TypedEnvelope): envelope is SagaReply {
  return REPLY_TYPES.includes(envelope.type);
}

export type SagaInput =
  | { kind: 'reply'; reply: SagaReply }
  | { kind: 'timeout' }
  | { kind: 'operator_retry' };

export type TransitionResult =
  | { kind: 'transition'; next: SagaSnapshot; commands: SagaCommand[]; trigger: string }
  | { kind: 'ignored'; reason: string };

export interface NewOrder {
  orderId: string;
  customerId: string;
  items: LineItem[];
}

export function startSaga(
  order: NewOrder,
  now: Date,
  timeouts: SagaTimeouts,
): { snapshot: SagaSnapshot; commands: SagaCommand[] } {
  return {
    snapshot: {
      ...order,
      state: 'RESERVING_STOCK',
      version: 1,
      attempts: 1,
      deadlineAt: after(now, timeouts.reserveMs),
      cancelReason: null,
      total: null,
      currency: null,
      resumeState: null,
    },
    commands: [
      { type: 'inventory.ReserveStock', payload: { orderId: order.orderId, items: order.items } },
    ],
  };
}

export function transition(
  saga: SagaSnapshot,
  input: SagaInput,
  now: Date,
  timeouts: SagaTimeouts,
): TransitionResult {
  if (input.kind === 'operator_retry') return operatorRetry(saga, now, timeouts);
  if (input.kind === 'timeout') return onTimeout(saga, now, timeouts);
  return onReply(saga, input.reply, now, timeouts);
}

function onReply(
  saga: SagaSnapshot,
  reply: SagaReply,
  now: Date,
  timeouts: SagaTimeouts,
): TransitionResult {
  const trigger = reply.type;
  const ignore = (): TransitionResult => ({
    kind: 'ignored',
    reason: `${reply.type} not expected in ${saga.state}`,
  });

  switch (saga.state) {
    case 'RESERVING_STOCK':
      if (reply.type === 'inventory.StockReserved') {
        const { total, currency } = reply.payload;
        return move(saga, 'CHARGING_PAYMENT', now, timeouts.chargeMs, trigger, {
          patch: { total, currency },
          commands: [
            {
              type: 'payment.ChargePayment',
              payload: {
                orderId: saga.orderId,
                customerId: saga.customerId,
                amount: total,
                currency,
              },
            },
          ],
        });
      }
      if (reply.type === 'inventory.StockReservationRejected') {
        // Nothing was reserved, so there is nothing to compensate.
        return move(saga, 'CANCELLED', now, null, trigger, {
          patch: { cancelReason: `stock_${reply.payload.reason}` },
        });
      }
      return ignore();

    case 'CHARGING_PAYMENT':
      if (reply.type === 'payment.PaymentCharged') {
        return move(saga, 'CONFIRMED', now, null, trigger, {
          commands: [{ type: 'inventory.CommitStock', payload: { orderId: saga.orderId } }],
        });
      }
      if (reply.type === 'payment.PaymentDeclined') {
        return releaseStock(saga, now, timeouts, trigger, `payment_${reply.payload.reason}`);
      }
      return ignore();

    case 'REFUNDING_PAYMENT':
      // A late PaymentCharged is expected here: the refund is already queued behind it.
      if (reply.type === 'payment.PaymentRefunded') {
        return releaseStock(saga, now, timeouts, trigger, saga.cancelReason ?? 'refunded');
      }
      return ignore();

    case 'RELEASING_STOCK':
      if (reply.type === 'inventory.StockReleased') {
        return move(saga, 'CANCELLED', now, null, trigger);
      }
      return ignore();

    case 'CONFIRMED':
    case 'CANCELLED':
    case 'FAILED':
      return ignore();
  }
}

function onTimeout(saga: SagaSnapshot, now: Date, timeouts: SagaTimeouts): TransitionResult {
  if (!saga.deadlineAt || saga.deadlineAt.getTime() > now.getTime()) {
    return { kind: 'ignored', reason: 'deadline not reached' };
  }
  switch (saga.state) {
    case 'RESERVING_STOCK':
      // The reservation may or may not have happened: release is idempotent and leaves a tombstone.
      return releaseStock(saga, now, timeouts, 'timeout', 'stock_timeout');
    case 'CHARGING_PAYMENT':
      // The charge may or may not have happened: refund resolves it (ADR 0006).
      return move(saga, 'REFUNDING_PAYMENT', now, timeouts.compensationMs, 'timeout', {
        patch: { cancelReason: 'payment_timeout' },
        commands: [refund(saga, 'payment_timeout')],
      });
    case 'REFUNDING_PAYMENT':
    case 'RELEASING_STOCK':
      return retryCompensation(saga, now, timeouts);
    case 'CONFIRMED':
    case 'CANCELLED':
    case 'FAILED':
      return { kind: 'ignored', reason: `no deadline in ${saga.state}` };
  }
}

function retryCompensation(
  saga: SagaSnapshot,
  now: Date,
  timeouts: SagaTimeouts,
): TransitionResult {
  if (saga.attempts >= timeouts.maxCompensationAttempts) {
    return move(saga, 'FAILED', now, null, 'timeout', { patch: { resumeState: saga.state } });
  }
  const attempts = saga.attempts + 1;
  // Exponential backoff between compensation retries, capped at 16x.
  const delay = timeouts.compensationMs * Math.min(2 ** (attempts - 1), 16);
  const command = compensationCommand(saga);
  return {
    kind: 'transition',
    trigger: 'timeout',
    commands: [command],
    next: { ...saga, version: saga.version + 1, attempts, deadlineAt: after(now, delay) },
  };
}

function operatorRetry(saga: SagaSnapshot, now: Date, timeouts: SagaTimeouts): TransitionResult {
  if (saga.state !== 'FAILED' || !saga.resumeState) {
    return { kind: 'ignored', reason: `operator retry only applies to FAILED sagas` };
  }
  const resumed: SagaSnapshot = { ...saga, state: saga.resumeState };
  return move(resumed, saga.resumeState, now, timeouts.compensationMs, 'operator_retry', {
    patch: { resumeState: null },
    commands: [compensationCommand(resumed)],
  });
}

function compensationCommand(saga: SagaSnapshot): SagaCommand {
  const reason = saga.cancelReason ?? 'cancelled';
  return saga.state === 'REFUNDING_PAYMENT'
    ? refund(saga, reason)
    : { type: 'inventory.ReleaseStock', payload: { orderId: saga.orderId, reason } };
}

function refund(saga: SagaSnapshot, reason: string): SagaCommand {
  return { type: 'payment.RefundPayment', payload: { orderId: saga.orderId, reason } };
}

function releaseStock(
  saga: SagaSnapshot,
  now: Date,
  timeouts: SagaTimeouts,
  trigger: string,
  reason: string,
): TransitionResult {
  return move(saga, 'RELEASING_STOCK', now, timeouts.compensationMs, trigger, {
    patch: { cancelReason: reason },
    commands: [{ type: 'inventory.ReleaseStock', payload: { orderId: saga.orderId, reason } }],
  });
}

function move(
  saga: SagaSnapshot,
  state: SagaState,
  now: Date,
  timeoutMs: number | null,
  trigger: string,
  options: { patch?: Partial<SagaSnapshot>; commands?: SagaCommand[] } = {},
): TransitionResult {
  return {
    kind: 'transition',
    trigger,
    commands: options.commands ?? [],
    next: {
      ...saga,
      ...options.patch,
      state,
      version: saga.version + 1,
      attempts: timeoutMs === null ? 0 : 1,
      deadlineAt: timeoutMs === null ? null : after(now, timeoutMs),
    },
  };
}

function after(now: Date, ms: number): Date {
  return new Date(now.getTime() + ms);
}

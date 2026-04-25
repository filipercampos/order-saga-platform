import { Inject, Injectable, Logger } from '@nestjs/common';
import { ServiceName, createEnvelope } from '@saga/contracts';
import { Topics } from '@saga/messaging';
import { METRICS, Metrics } from '@saga/observability';
import { PendingMessage, enqueue, processOnce } from '@saga/outbox';
import { DATABASE } from '@saga/platform';
import { Kysely, Transaction, sql } from 'kysely';
import { ORDER_ENV, OrderEnv } from '../config';
import type { OrderDatabase } from '../database/schema';
import {
  NewOrder,
  SagaCommand,
  SagaReply,
  SagaSnapshot,
  SagaState,
  SagaTimeouts,
  TERMINAL_STATES,
  TransitionResult,
  startSaga,
  statusOf,
  transition,
} from './saga-machine';

type Trx = Transaction<OrderDatabase>;

export const SAGA_INBOX = 'order-saga';

/**
 * Persistence around the pure state machine: load with FOR UPDATE, apply, write the
 * new state, the audit row, and outgoing commands/events (outbox) in one transaction.
 */
@Injectable()
export class SagaService {
  private readonly logger = new Logger(SagaService.name);
  readonly timeouts: SagaTimeouts;

  constructor(
    @Inject(DATABASE) private readonly db: Kysely<OrderDatabase>,
    @Inject(ORDER_ENV) env: OrderEnv,
    @Inject(METRICS) private readonly metrics: Metrics,
  ) {
    this.timeouts = {
      reserveMs: env.SAGA_RESERVE_TIMEOUT_MS,
      chargeMs: env.SAGA_CHARGE_TIMEOUT_MS,
      compensationMs: env.SAGA_COMPENSATION_TIMEOUT_MS,
      maxCompensationAttempts: env.SAGA_MAX_COMPENSATION_ATTEMPTS,
    };
  }

  /** Called inside the transaction that inserts the order. */
  async start(trx: Trx, order: NewOrder, now = new Date()): Promise<SagaSnapshot> {
    const { snapshot, commands } = startSaga(order, now, this.timeouts);
    await trx
      .insertInto('sagas')
      .values({
        order_id: order.orderId,
        state: snapshot.state,
        version: snapshot.version,
        attempts: snapshot.attempts,
        deadline_at: snapshot.deadlineAt,
        resume_state: null,
      })
      .execute();
    await this.audit(trx, order.orderId, null, snapshot.state, 'OrderPlaced', null);
    await enqueue(trx, [
      this.event(snapshot, 'order.OrderPlaced', {
        orderId: order.orderId,
        customerId: order.customerId,
        items: order.items,
        orderVersion: snapshot.version,
        placedAt: now.toISOString(),
      }),
      this.statusEvent(snapshot),
      ...commands.map((command) => this.command(snapshot, command)),
    ]);
    this.metrics.count('SagaTransition', 1, { To: snapshot.state });
    return snapshot;
  }

  /** Applies a participant reply exactly once (inbox) and atomically with its effects. */
  async handleReply(reply: SagaReply): Promise<'applied' | 'ignored' | 'duplicate' | 'unknown'> {
    const outcome = await processOnce(
      this.db,
      { consumer: SAGA_INBOX, eventId: reply.eventId, messageType: reply.type },
      async (trx) => {
        const saga = await this.lock(trx, reply.payload.orderId);
        if (!saga) return 'unknown' as const;
        const result = transition(saga, { kind: 'reply', reply }, new Date(), this.timeouts);
        return this.persist(trx, saga, result, reply.eventId);
      },
    );
    if (outcome.duplicate) return 'duplicate';
    if (outcome.result === 'unknown') {
      // Replies for orders we never created cannot become valid later.
      this.logger.warn(
        { orderId: reply.payload.orderId, type: reply.type },
        'reply for unknown saga',
      );
    }
    return outcome.result;
  }

  /**
   * Feeds `timeout` into sagas whose deadline passed. SKIP LOCKED lets every replica scan
   * concurrently without double-processing, and never blocks on a saga that is currently
   * handling a reply.
   */
  async processDueTimeouts(limit: number, now = new Date()): Promise<number> {
    return this.db.transaction().execute(async (trx) => {
      const due = await trx
        .selectFrom('sagas')
        .select('order_id')
        .where('deadline_at', '<=', now)
        .orderBy('deadline_at')
        .limit(limit)
        .forUpdate()
        .skipLocked()
        .execute();
      let applied = 0;
      for (const { order_id } of due) {
        const saga = await this.lock(trx, order_id);
        if (!saga) continue;
        const result = transition(saga, { kind: 'timeout' }, now, this.timeouts);
        if ((await this.persist(trx, saga, result, null)) === 'applied') applied += 1;
      }
      return applied;
    });
  }

  async operatorRetry(orderId: string): Promise<TransitionResult['kind'] | 'unknown'> {
    return this.db.transaction().execute(async (trx) => {
      const saga = await this.lock(trx, orderId);
      if (!saga) return 'unknown';
      const result = transition(saga, { kind: 'operator_retry' }, new Date(), this.timeouts);
      await this.persist(trx, saga, result, null);
      return result.kind;
    });
  }

  async transitions(orderId: string) {
    return this.db
      .selectFrom('saga_transitions')
      .select(['from_state', 'to_state', 'trigger', 'event_id', 'at'])
      .where('order_id', '=', orderId)
      .orderBy('id')
      .execute();
  }

  async load(orderId: string): Promise<SagaSnapshot | undefined> {
    return this.lock(this.db, orderId, false);
  }

  private async lock(
    db: Kysely<OrderDatabase>,
    orderId: string,
    forUpdate = true,
  ): Promise<SagaSnapshot | undefined> {
    const row = await db
      .selectFrom('sagas')
      .innerJoin('orders', 'orders.id', 'sagas.order_id')
      .select([
        'sagas.order_id',
        'sagas.state',
        'sagas.version',
        'sagas.attempts',
        'sagas.deadline_at',
        'sagas.resume_state',
        'orders.customer_id',
        'orders.items',
        'orders.total_minor',
        'orders.currency',
        'orders.cancel_reason',
      ])
      .where('sagas.order_id', '=', orderId)
      .$if(forUpdate, (qb) => qb.forUpdate())
      .executeTakeFirst();
    if (!row) return undefined;
    return {
      orderId: row.order_id,
      customerId: row.customer_id,
      items: row.items,
      state: row.state,
      version: row.version,
      attempts: row.attempts,
      deadlineAt: row.deadline_at,
      cancelReason: row.cancel_reason,
      total: row.total_minor,
      currency: row.currency,
      resumeState: row.resume_state,
    };
  }

  private async persist(
    trx: Kysely<OrderDatabase>,
    before: SagaSnapshot,
    result: TransitionResult,
    eventId: string | null,
  ): Promise<'applied' | 'ignored'> {
    if (result.kind === 'ignored') {
      this.logger.log(
        { orderId: before.orderId, state: before.state, reason: result.reason },
        'saga input ignored',
      );
      return 'ignored';
    }
    const { next } = result;
    const updated = await trx
      .updateTable('sagas')
      .set({
        state: next.state,
        version: next.version,
        attempts: next.attempts,
        deadline_at: next.deadlineAt,
        resume_state: next.resumeState,
        updated_at: sql`now()`,
      })
      .where('order_id', '=', next.orderId)
      .where('version', '=', before.version)
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows) !== 1) {
      // Cannot happen while the row is locked; fail loudly rather than fork the saga.
      throw new Error(`saga ${next.orderId} version conflict at ${before.version}`);
    }
    await trx
      .updateTable('orders')
      .set({
        status: statusOf(next.state),
        total_minor: next.total,
        currency: next.currency,
        cancel_reason: next.cancelReason,
        updated_at: sql`now()`,
      })
      .where('id', '=', next.orderId)
      .execute();
    await this.audit(trx, next.orderId, before.state, next.state, result.trigger, eventId);

    const messages: PendingMessage[] = result.commands.map((c) => this.command(next, c, eventId));
    if (next.state !== before.state) messages.push(this.statusEvent(next, eventId));
    messages.push(...this.terminalEvents(before.state, next, eventId));
    await enqueue(trx, messages);

    this.metrics.count('SagaTransition', 1, { To: next.state });
    if (next.state === 'FAILED') {
      this.logger.error(
        { orderId: next.orderId, resumeState: next.resumeState },
        'saga failed, needs operator',
      );
    }
    return 'applied';
  }

  private terminalEvents(from: SagaState, next: SagaSnapshot, causationId: string | null) {
    if (from === next.state || !TERMINAL_STATES.includes(next.state)) return [];
    if (next.state === 'CONFIRMED') {
      return [
        this.event(
          next,
          'order.OrderConfirmed',
          {
            orderId: next.orderId,
            customerId: next.customerId,
            total: next.total ?? '0',
            currency: next.currency ?? 'XXX',
            orderVersion: next.version,
          },
          causationId,
        ),
      ];
    }
    return [
      this.event(
        next,
        'order.OrderCancelled',
        {
          orderId: next.orderId,
          customerId: next.customerId,
          reason: next.cancelReason ?? 'cancelled',
          orderVersion: next.version,
        },
        causationId,
      ),
    ];
  }

  private statusEvent(saga: SagaSnapshot, causationId: string | null = null): PendingMessage {
    return this.event(
      saga,
      'order.OrderStatusChanged',
      {
        orderId: saga.orderId,
        customerId: saga.customerId,
        status: statusOf(saga.state),
        sagaState: saga.state,
        orderVersion: saga.version,
        total: saga.total ?? undefined,
        currency: saga.currency ?? undefined,
        reason: saga.cancelReason ?? undefined,
      },
      causationId,
    );
  }

  private event(
    saga: SagaSnapshot,
    type: string,
    payload: unknown,
    causationId: string | null = null,
  ): PendingMessage {
    return {
      topic: Topics.orderEvents,
      envelope: createEnvelope({
        type,
        payload,
        producer: ServiceName.order,
        correlationId: saga.orderId,
        causationId: causationId ?? undefined,
      }),
    };
  }

  private command(
    saga: SagaSnapshot,
    command: SagaCommand,
    causationId: string | null = null,
  ): PendingMessage {
    const target = command.type.split('.')[0] ?? 'unknown';
    return {
      topic: Topics.sagaCommands,
      groupId: saga.orderId,
      attributes: { target },
      envelope: createEnvelope({
        type: command.type,
        payload: command.payload,
        producer: ServiceName.order,
        correlationId: saga.orderId,
        causationId: causationId ?? undefined,
      }),
    };
  }

  private async audit(
    trx: Kysely<OrderDatabase>,
    orderId: string,
    from: SagaState | null,
    to: SagaState,
    trigger: string,
    eventId: string | null,
  ) {
    await trx
      .insertInto('saga_transitions')
      .values({ order_id: orderId, from_state: from, to_state: to, trigger, event_id: eventId })
      .execute();
  }
}

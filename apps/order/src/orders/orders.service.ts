import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable, UnprocessableEntityException } from '@nestjs/common';
import type { LineItem } from '@saga/contracts';
import { DATABASE } from '@saga/platform';
import { Kysely } from 'kysely';
import type { OrderDatabase } from '../database/schema';
import { SagaService } from '../saga/saga.service';

export interface PlaceOrderInput {
  customerId: string;
  idempotencyKey: string;
  items: LineItem[];
}

export type OrderView = Awaited<ReturnType<OrdersService['find']>>;

const UNIQUE_VIOLATION = '23505';

@Injectable()
export class OrdersService {
  constructor(
    @Inject(DATABASE) private readonly db: Kysely<OrderDatabase>,
    private readonly sagas: SagaService,
  ) {}

  /**
   * Creates the order and starts its saga in one transaction (the saga's first command
   * goes to the outbox in the same commit). Retries with the same Idempotency-Key replay
   * the original order instead of creating a second one.
   */
  async place(input: PlaceOrderInput): Promise<{ orderId: string; replayed: boolean }> {
    const hash = createHash('sha256').update(JSON.stringify(input.items)).digest('hex');
    const existing = await this.byIdempotencyKey(input.customerId, input.idempotencyKey);
    if (existing) return this.replay(existing, hash);

    const orderId = randomUUID();
    try {
      await this.db.transaction().execute(async (trx) => {
        await trx
          .insertInto('orders')
          .values({
            id: orderId,
            customer_id: input.customerId,
            status: 'PENDING',
            items: JSON.stringify(input.items),
            total_minor: null,
            currency: null,
            cancel_reason: null,
            idempotency_key: input.idempotencyKey,
            request_hash: hash,
          })
          .execute();
        await this.sagas.start(trx, { orderId, customerId: input.customerId, items: input.items });
      });
    } catch (error) {
      // Lost a race with a concurrent request carrying the same key.
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
        const winner = await this.byIdempotencyKey(input.customerId, input.idempotencyKey);
        if (winner) return this.replay(winner, hash);
      }
      throw error;
    }
    return { orderId, replayed: false };
  }

  /** Strongly consistent read from the write model (Postgres). */
  async find(orderId: string, customerId: string | null) {
    const row = await this.db
      .selectFrom('orders')
      .innerJoin('sagas', 'sagas.order_id', 'orders.id')
      .select([
        'orders.id',
        'orders.customer_id',
        'orders.status',
        'orders.items',
        'orders.total_minor',
        'orders.currency',
        'orders.cancel_reason',
        'orders.created_at',
        'orders.updated_at',
        'sagas.state',
        'sagas.version',
      ])
      .where('orders.id', '=', orderId)
      .$if(customerId !== null, (qb) => qb.where('orders.customer_id', '=', customerId ?? ''))
      .executeTakeFirst();
    if (!row) return undefined;
    return {
      id: row.id,
      customerId: row.customer_id,
      status: row.status,
      sagaState: row.state,
      version: row.version,
      items: row.items,
      total: row.total_minor,
      currency: row.currency,
      cancelReason: row.cancel_reason,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  private byIdempotencyKey(customerId: string, key: string) {
    return this.db
      .selectFrom('orders')
      .select(['id', 'request_hash'])
      .where('customer_id', '=', customerId)
      .where('idempotency_key', '=', key)
      .executeTakeFirst();
  }

  private replay(existing: { id: string; request_hash: string }, hash: string) {
    if (existing.request_hash !== hash) {
      throw new UnprocessableEntityException({
        type: 'idempotency_key_reused',
        detail: 'Idempotency-Key was already used with a different request',
      });
    }
    return { orderId: existing.id, replayed: true };
  }
}

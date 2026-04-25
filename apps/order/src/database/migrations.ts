import { outboxInboxMigration } from '@saga/outbox';
import { Kysely, Migration, sql } from 'kysely';

const orders: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await sql`
      CREATE TABLE orders (
        id              uuid PRIMARY KEY,
        customer_id     text NOT NULL,
        status          text NOT NULL,
        items           jsonb NOT NULL,
        total_minor     bigint CHECK (total_minor >= 0),
        currency        char(3),
        cancel_reason   text,
        idempotency_key text NOT NULL,
        request_hash    text NOT NULL,
        created_at      timestamptz NOT NULL DEFAULT now(),
        updated_at      timestamptz NOT NULL DEFAULT now(),
        UNIQUE (customer_id, idempotency_key)
      )`.execute(db);
    await sql`CREATE INDEX orders_customer ON orders (customer_id, created_at DESC)`.execute(db);

    await sql`
      CREATE TABLE sagas (
        order_id     uuid PRIMARY KEY REFERENCES orders (id),
        state        text NOT NULL,
        version      integer NOT NULL,
        attempts     integer NOT NULL DEFAULT 0,
        deadline_at  timestamptz,
        resume_state text,
        started_at   timestamptz NOT NULL DEFAULT now(),
        updated_at   timestamptz NOT NULL DEFAULT now()
      )`.execute(db);
    // The timeout scanner only looks at sagas that are waiting for something.
    await sql`CREATE INDEX sagas_deadline ON sagas (deadline_at) WHERE deadline_at IS NOT NULL`.execute(
      db,
    );

    await sql`
      CREATE TABLE saga_transitions (
        id         bigserial PRIMARY KEY,
        order_id   uuid NOT NULL REFERENCES orders (id),
        from_state text,
        to_state   text NOT NULL,
        trigger    text NOT NULL,
        event_id   uuid,
        at         timestamptz NOT NULL DEFAULT now()
      )`.execute(db);
    await sql`CREATE INDEX saga_transitions_order ON saga_transitions (order_id, id)`.execute(db);
  },
};

export const orderMigrations: Record<string, Migration> = {
  '2026_04_25_0001_orders_and_sagas': orders,
  '2026_04_25_0002_outbox_inbox': outboxInboxMigration,
};

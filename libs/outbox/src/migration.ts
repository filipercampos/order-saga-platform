import { Kysely, Migration, sql } from 'kysely';

/**
 * Outbox and inbox tables. Every service includes this migration in its own database;
 * the tables are never shared between services.
 */
export const outboxInboxMigration: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await sql`
      CREATE TABLE outbox (
        seq             bigserial PRIMARY KEY,
        event_id        uuid NOT NULL UNIQUE,
        topic           text NOT NULL,
        group_id        text,
        message_type    text NOT NULL,
        body            jsonb NOT NULL,
        attributes      jsonb NOT NULL DEFAULT '{}',
        created_at      timestamptz NOT NULL DEFAULT now(),
        published_at    timestamptz,
        attempts        integer NOT NULL DEFAULT 0,
        next_attempt_at timestamptz NOT NULL DEFAULT now(),
        last_error      text
      )`.execute(db);
    // The relay only ever scans unpublished rows; keep that index tiny.
    await sql`CREATE INDEX outbox_pending ON outbox (seq) WHERE published_at IS NULL`.execute(db);
    await sql`CREATE INDEX outbox_pending_group ON outbox (group_id, seq) WHERE published_at IS NULL`.execute(
      db,
    );

    await sql`
      CREATE TABLE inbox (
        consumer     text NOT NULL,
        event_id     uuid NOT NULL,
        message_type text NOT NULL,
        processed_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (consumer, event_id)
      )`.execute(db);
    await sql`CREATE INDEX inbox_processed_at ON inbox (processed_at)`.execute(db);
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await sql`DROP TABLE inbox`.execute(db);
    await sql`DROP TABLE outbox`.execute(db);
  },
};

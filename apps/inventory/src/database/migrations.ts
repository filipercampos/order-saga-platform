import { outboxInboxMigration } from '@saga/outbox';
import { Kysely, Migration, sql } from 'kysely';

const stock: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await sql`
      CREATE TABLE products (
        sku        text PRIMARY KEY,
        name       text NOT NULL,
        unit_price bigint NOT NULL CHECK (unit_price >= 0),
        currency   char(3) NOT NULL,
        -- The database, not the code, is the last line of defence against overselling.
        available  integer NOT NULL CHECK (available >= 0),
        reserved   integer NOT NULL DEFAULT 0 CHECK (reserved >= 0),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`.execute(db);

    // One row per order. A RELEASED row without lines is a tombstone: the release
    // arrived first, so a late reserve for the same order must be rejected.
    await sql`
      CREATE TABLE reservations (
        order_id   uuid PRIMARY KEY,
        status     text NOT NULL CHECK (status IN ('RESERVED', 'COMMITTED', 'RELEASED', 'REJECTED')),
        lines      jsonb NOT NULL,
        total      bigint NOT NULL DEFAULT 0,
        currency   char(3),
        reason     text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`.execute(db);
  },
};

export const inventoryMigrations: Record<string, Migration> = {
  '2026_04_28_0001_stock': stock,
  '2026_04_28_0002_outbox_inbox': outboxInboxMigration,
};

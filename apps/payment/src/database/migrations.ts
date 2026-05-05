import { outboxInboxMigration } from '@saga/outbox';
import { Kysely, Migration, sql } from 'kysely';

const payments: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await sql`
      CREATE TABLE wallets (
        customer_id       text PRIMARY KEY,
        ledger_account_id text NOT NULL,
        created_at        timestamptz NOT NULL DEFAULT now()
      )`.execute(db);

    await sql`
      CREATE TABLE payments (
        order_id                uuid PRIMARY KEY,
        customer_id             text,
        status                  text NOT NULL
          CHECK (status IN ('CHARGING', 'CHARGED', 'DECLINED', 'REFUNDED', 'CANCELLED')),
        amount                  bigint NOT NULL DEFAULT 0 CHECK (amount >= 0),
        currency                char(3),
        ledger_account_id       text,
        ledger_transaction_id   text,
        reversal_transaction_id text,
        decline_reason          text,
        created_at              timestamptz NOT NULL DEFAULT now(),
        updated_at              timestamptz NOT NULL DEFAULT now()
      )`.execute(db);
    // Reconciliation and the stuck-payment alarm look for charges with unknown outcome.
    await sql`CREATE INDEX payments_charging ON payments (updated_at) WHERE status = 'CHARGING'`.execute(
      db,
    );
  },
};

export const paymentMigrations: Record<string, Migration> = {
  '2026_05_04_0001_payments': payments,
  '2026_05_04_0002_outbox_inbox': outboxInboxMigration,
};

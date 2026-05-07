import { outboxInboxMigration } from '@saga/outbox';
import type { Generated } from 'kysely';
import { Kysely, Migration, sql } from 'kysely';

export interface NotificationsTable {
  id: Generated<string>;
  order_id: string;
  customer_id: string;
  template: string;
  status: 'PENDING' | 'SENT';
  created_at: Generated<Date>;
  sent_at: Date | null;
}

export interface NotificationDatabase {
  notifications: NotificationsTable;
}

const notifications: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await sql`
      CREATE TABLE notifications (
        id          bigserial PRIMARY KEY,
        order_id    uuid NOT NULL,
        customer_id text NOT NULL,
        template    text NOT NULL,
        status      text NOT NULL CHECK (status IN ('PENDING', 'SENT')),
        created_at  timestamptz NOT NULL DEFAULT now(),
        sent_at     timestamptz,
        -- Business-level dedup on top of the inbox: one email per order outcome, even if
        -- the same outcome were ever published twice with different event ids.
        UNIQUE (order_id, template)
      )`.execute(db);
  },
};

export const notificationMigrations: Record<string, Migration> = {
  '2026_05_07_0001_notifications': notifications,
  // The outbox is unused for now (notification produces no events) but keeps the
  // inbox/outbox schema identical across services.
  '2026_05_07_0002_outbox_inbox': outboxInboxMigration,
};

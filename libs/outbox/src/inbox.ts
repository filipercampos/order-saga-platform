import { Kysely, Transaction, sql } from 'kysely';

export interface InboxKey {
  consumer: string;
  eventId: string;
  messageType: string;
}

export type InboxOutcome<T> = { duplicate: true } | { duplicate: false; result: T };

/**
 * Exactly-once *effect* over at-least-once delivery: the inbox row, the business change
 * and any outgoing messages (outbox) are committed in one transaction. A redelivered
 * message hits the primary key and its handler is skipped.
 *
 * The insert happens first, so a concurrent duplicate blocks on the row lock until the
 * first transaction commits (then sees the conflict) or rolls back (then proceeds).
 */
export async function processOnce<DB, T>(
  db: Kysely<DB>,
  key: InboxKey,
  handler: (trx: Transaction<DB>) => Promise<T>,
): Promise<InboxOutcome<T>> {
  return db.transaction().execute(async (trx) => {
    const inserted = await sql`
      INSERT INTO inbox (consumer, event_id, message_type)
      VALUES (${key.consumer}, ${key.eventId}::uuid, ${key.messageType})
      ON CONFLICT DO NOTHING`.execute(trx);
    if (Number(inserted.numAffectedRows ?? 0) === 0) return { duplicate: true } as const;
    const result = await handler(trx);
    return { duplicate: false, result } as const;
  });
}

/**
 * Inbox retention must exceed the longest possible redelivery horizon:
 * SQS retention (4 days) + DLQ retention (14 days) + time to redrive.
 */
export async function purgeInbox<DB>(db: Kysely<DB>, olderThanDays: number): Promise<number> {
  const result = await sql`
    DELETE FROM inbox WHERE processed_at < now() - make_interval(days => ${olderThanDays})`.execute(
    db,
  );
  return Number(result.numAffectedRows ?? 0);
}

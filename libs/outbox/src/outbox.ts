import { context, propagation } from '@opentelemetry/api';
import type { Envelope } from '@saga/contracts';
import { Kysely, sql } from 'kysely';

export interface PendingMessage {
  /** Logical topic name (resolved to an ARN by the publisher). */
  topic: string;
  /** FIFO message group (the order id for saga commands); null for standard topics. */
  groupId?: string;
  envelope: Envelope;
  /** Extra SNS message attributes used by subscription filter policies. */
  attributes?: Record<string, string>;
}

export interface OutboundMessage {
  seq: string;
  eventId: string;
  topic: string;
  groupId: string | null;
  type: string;
  body: string;
  attributes: Record<string, string>;
}

export interface PublishResult {
  /** eventId -> error message for entries the broker rejected. */
  failed: Map<string, string>;
}

export interface MessagePublisher {
  publish(messages: OutboundMessage[]): Promise<PublishResult>;
}

/**
 * Writes messages to the outbox. Must be called with the transaction that performs the
 * business change, so either both commit or neither does.
 */
export async function enqueue<DB>(trx: Kysely<DB>, messages: PendingMessage[]): Promise<void> {
  if (messages.length === 0) return;
  // Capture the caller's trace context so the consumer span links back to this request.
  const trace: Record<string, string> = {};
  propagation.inject(context.active(), trace);

  const rows = messages.map((message) => {
    const attributes: Record<string, string> = {
      type: message.envelope.type,
      correlationId: message.envelope.correlationId,
      ...trace,
      ...message.attributes,
    };
    return sql`(${message.envelope.eventId}, ${message.topic}, ${message.groupId ?? null},
      ${message.envelope.type}, ${JSON.stringify(message.envelope)}::jsonb,
      ${JSON.stringify(attributes)}::jsonb)`;
  });
  await sql`
    INSERT INTO outbox (event_id, topic, group_id, message_type, body, attributes)
    VALUES ${sql.join(rows)}`.execute(trx);
}

interface OutboxRow {
  seq: string;
  event_id: string;
  topic: string;
  group_id: string | null;
  message_type: string;
  body: unknown;
  attributes: Record<string, string>;
}

export interface RelayOptions {
  batchSize: number;
  maxAttempts: number;
  /** Base delay before a failed row becomes eligible again (doubles per attempt). */
  retryBaseMs: number;
}

export interface RelayResult {
  published: number;
  failed: number;
}

/**
 * Publishes one batch. Rows are claimed with FOR UPDATE SKIP LOCKED, so N replicas can
 * relay concurrently. A row is only eligible when no earlier unpublished row exists in
 * the same message group: per-order ordering of saga commands survives relay retries
 * and multiple replicas (ADR 0004).
 */
export async function relayBatch<DB>(
  db: Kysely<DB>,
  publisher: MessagePublisher,
  options: RelayOptions,
): Promise<RelayResult> {
  return db.transaction().execute(async (trx) => {
    const { rows } = await sql<OutboxRow>`
      SELECT o.seq, o.event_id, o.topic, o.group_id, o.message_type, o.body, o.attributes
        FROM outbox o
       WHERE o.published_at IS NULL
         AND o.attempts < ${options.maxAttempts}
         AND o.next_attempt_at <= now()
         AND NOT EXISTS (
               SELECT 1 FROM outbox p
                WHERE p.group_id = o.group_id
                  AND p.published_at IS NULL
                  AND p.seq < o.seq)
       ORDER BY o.seq
       LIMIT ${options.batchSize}
         FOR UPDATE SKIP LOCKED`.execute(trx);
    if (rows.length === 0) return { published: 0, failed: 0 };

    const messages: OutboundMessage[] = rows.map((row) => ({
      seq: row.seq,
      eventId: row.event_id,
      topic: row.topic,
      groupId: row.group_id,
      type: row.message_type,
      body: JSON.stringify(row.body),
      attributes: row.attributes,
    }));

    let failed: Map<string, string>;
    try {
      ({ failed } = await publisher.publish(messages));
    } catch (error) {
      failed = new Map(messages.map((m) => [m.eventId, errorMessage(error)]));
    }

    const publishedIds = messages.map((m) => m.eventId).filter((id) => !failed.has(id));
    if (publishedIds.length > 0) {
      await sql`UPDATE outbox SET published_at = now()
                 WHERE event_id = ANY(${publishedIds}::uuid[])`.execute(trx);
    }
    for (const [eventId, error] of failed) {
      await sql`
        UPDATE outbox
           SET attempts = attempts + 1,
               last_error = ${error.slice(0, 1000)},
               next_attempt_at = now() + make_interval(secs => ${options.retryBaseMs / 1000} * power(2, LEAST(attempts, 10)))
         WHERE event_id = ${eventId}::uuid`.execute(trx);
    }
    return { published: publishedIds.length, failed: failed.size };
  });
}

/** Age of the oldest unpublished row in seconds (0 when the outbox is drained). */
export async function oldestPendingAgeSeconds<DB>(db: Kysely<DB>): Promise<number> {
  const { rows } = await sql<{ age: string | null }>`
    SELECT EXTRACT(EPOCH FROM now() - min(created_at))::text AS age
      FROM outbox WHERE published_at IS NULL`.execute(db);
  return Number(rows[0]?.age ?? 0);
}

/** Retention: published rows are kept for debugging/replay, then removed. */
export async function purgePublished<DB>(db: Kysely<DB>, olderThanDays: number): Promise<number> {
  const result = await sql`
    DELETE FROM outbox
     WHERE published_at < now() - make_interval(days => ${olderThanDays})`.execute(db);
  return Number(result.numAffectedRows ?? 0);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

import type { TypedEnvelope } from '@saga/contracts';
import { Collection, Db, MongoServerError } from 'mongodb';

/**
 * CQRS read model: one document per order with its current status and a timeline of
 * everything that happened to it across order, inventory and payment.
 *
 * DocumentDB 5.0 compatibility (ADR 0005): only single-document updates with $set,
 * $setOnInsert and $push, equality/range filters, a compound index and
 * renameCollection. No multi-document transactions, no $lookup, no change streams, no
 * retryable writes.
 */
export interface TimelineEntry {
  eventId: string;
  type: string;
  at: Date;
  producer: string;
  detail: Record<string, unknown>;
}

export interface OrderHistoryDocument {
  _id: string;
  customerId?: string;
  status?: string;
  sagaState?: string;
  version?: number;
  items?: { sku: string; quantity: number }[];
  total?: string;
  currency?: string;
  cancelReason?: string;
  placedAt?: Date;
  updatedAt?: Date;
  timeline: TimelineEntry[];
}

export interface ArchivedEvent {
  _id: string;
  orderId: string;
  type: string;
  occurredAt: Date;
  envelope: TypedEnvelope;
}

export const HISTORY_COLLECTION = 'order_history';
export const ARCHIVE_COLLECTION = 'event_archive';

const DUPLICATE_KEY = 11000;

export async function ensureHistoryIndexes(db: Db, collection = HISTORY_COLLECTION) {
  await db.collection(collection).createIndex({ customerId: 1, placedAt: -1 });
  await db.collection(ARCHIVE_COLLECTION).createIndex({ occurredAt: 1, _id: 1 });
  await db.collection(ARCHIVE_COLLECTION).createIndex({ orderId: 1 });
}

/**
 * Archives the raw event (the replay source), then applies it. Both steps are idempotent,
 * so redelivery at any point converges to the same document.
 */
export async function archiveAndProject(db: Db, envelope: TypedEnvelope): Promise<void> {
  const orderId = orderIdOf(envelope);
  try {
    await db.collection<ArchivedEvent>(ARCHIVE_COLLECTION).insertOne({
      _id: envelope.eventId,
      orderId,
      type: envelope.type,
      occurredAt: new Date(envelope.occurredAt),
      envelope,
    });
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
  }
  await project(db.collection<OrderHistoryDocument>(HISTORY_COLLECTION), envelope);
}

export async function project(
  history: Collection<OrderHistoryDocument>,
  envelope: TypedEnvelope,
): Promise<void> {
  const orderId = orderIdOf(envelope);

  // 1. Timeline entry, at most once per eventId.
  await ignoreDuplicate(
    history.updateOne(
      { _id: orderId, 'timeline.eventId': { $ne: envelope.eventId } },
      {
        $push: {
          timeline: {
            eventId: envelope.eventId,
            type: envelope.type,
            at: new Date(envelope.occurredAt),
            producer: envelope.producer,
            detail: detailOf(envelope),
          },
        },
      },
      { upsert: true },
    ),
  );

  // 2. Current state. Events from different topics arrive in any order, so state only
  //    moves forward: an update applies only if its orderVersion is newer.
  if (envelope.type === 'order.OrderPlaced') {
    const { customerId, items, placedAt } = envelope.payload;
    await history.updateOne(
      { _id: orderId },
      { $set: { customerId, items, placedAt: new Date(placedAt) } },
      { upsert: true },
    );
  }
  if (envelope.type === 'order.OrderStatusChanged') {
    const p = envelope.payload;
    await ignoreDuplicate(
      history.updateOne(
        {
          _id: orderId,
          $or: [{ version: { $lt: p.orderVersion } }, { version: { $exists: false } }],
        },
        {
          $set: {
            customerId: p.customerId,
            status: p.status,
            sagaState: p.sagaState,
            version: p.orderVersion,
            ...(p.total ? { total: p.total, currency: p.currency } : {}),
            ...(p.reason ? { cancelReason: p.reason } : {}),
            updatedAt: new Date(envelope.occurredAt),
          },
        },
        { upsert: true },
      ),
    );
  }
}

function orderIdOf(envelope: TypedEnvelope): string {
  return envelope.payload.orderId;
}

/** A compact, PII-free summary for the timeline. */
function detailOf(envelope: TypedEnvelope): Record<string, unknown> {
  const detail: Record<string, unknown> = { ...envelope.payload };
  for (const key of ['orderId', 'customerId', 'items', 'lines']) delete detail[key];
  return detail;
}

/**
 * Upsert + a filter that no longer matches (event already applied, or a newer version
 * present) makes MongoDB try to insert an existing _id: that is the "already done" case.
 */
async function ignoreDuplicate(operation: Promise<unknown>): Promise<void> {
  try {
    await operation;
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
  }
}

function isDuplicateKey(error: unknown): boolean {
  return error instanceof MongoServerError && error.code === DUPLICATE_KEY;
}

import { Db } from 'mongodb';
import {
  ARCHIVE_COLLECTION,
  ArchivedEvent,
  HISTORY_COLLECTION,
  OrderHistoryDocument,
  ensureHistoryIndexes,
  project,
} from './order-history.projector';

export interface ReplayResult {
  events: number;
  orders: number;
  durationMs: number;
}

/**
 * Rebuilds the read model from the event archive into a side collection and swaps it in
 * with renameCollection(dropTarget). Readers see either the old or the new collection,
 * never a half-built one. Events consumed while the rebuild runs are archived too; run
 * the replay again (it is idempotent) if the swap must include them, or pause the
 * projector during the swap (runbook).
 */
export async function replayProjection(db: Db, batchSize = 500): Promise<ReplayResult> {
  const started = Date.now();
  const rebuildName = `${HISTORY_COLLECTION}_rebuild`;
  await db
    .collection(rebuildName)
    .drop()
    .catch(() => undefined);
  const rebuild = db.collection<OrderHistoryDocument>(rebuildName);

  let events = 0;
  const cursor = db
    .collection<ArchivedEvent>(ARCHIVE_COLLECTION)
    .find({})
    .sort({ occurredAt: 1, _id: 1 })
    .batchSize(batchSize);
  for await (const archived of cursor) {
    await project(rebuild, archived.envelope);
    events += 1;
  }
  await ensureHistoryIndexes(db, rebuildName);
  const orders = await rebuild.countDocuments();
  if (orders > 0) {
    await db.renameCollection(rebuildName, HISTORY_COLLECTION, { dropTarget: true });
  } else {
    await db.collection(HISTORY_COLLECTION).deleteMany({});
  }
  return { events, orders, durationMs: Date.now() - started };
}

/**
 * Rebuilds the order-history read model from the event archive.
 * Usage: npm run projection:replay
 */
import { createMongoClient } from './mongo';
import { replayProjection } from './replay';

async function main(): Promise<void> {
  const url = process.env.MONGO_URL ?? 'mongodb://localhost:27018/?directConnection=true';
  const client = await createMongoClient(url).connect();
  try {
    const result = await replayProjection(client.db(process.env.MONGO_DB ?? 'order_history'));
    console.log(JSON.stringify({ msg: 'projection rebuilt', ...result }));
  } finally {
    await client.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

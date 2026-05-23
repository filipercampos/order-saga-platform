/**
 * Applies one service's migrations to its own database.
 * Usage: node dist/tools/migrate.js <order|inventory|payment|notification>
 * Runs as a Helm pre-install/pre-upgrade Job in EKS (DATABASE_URL or DB_* from the
 * service's secret), and is what MIGRATE_ON_START does locally.
 */
import { createDatabase, migrateToLatest, parseEnv } from '@saga/platform';
import type { Migration } from 'kysely';
import { inventoryMigrations } from '../apps/inventory/src/database/migrations';
import { notificationMigrations } from '../apps/notification/src/database/migrations';
import { orderMigrations } from '../apps/order/src/database/migrations';
import { paymentMigrations } from '../apps/payment/src/database/migrations';

const migrationsByService: Record<string, Record<string, Migration>> = {
  order: orderMigrations,
  inventory: inventoryMigrations,
  payment: paymentMigrations,
  notification: notificationMigrations,
};

async function main(): Promise<void> {
  const service = process.argv[2] ?? '';
  const migrations = migrationsByService[service];
  if (!migrations)
    throw new Error(`usage: migrate <${Object.keys(migrationsByService).join('|')}>`);
  // Auth settings are irrelevant for migrations; only the database URL is needed.
  const env = parseEnv({}, { AUTH_MODE: 'disabled', ...process.env, NODE_ENV: 'test' });
  const db = createDatabase<unknown>({
    connectionString: env.DATABASE_URL,
    poolMax: 1,
    applicationName: `${service}-migrations`,
  });
  try {
    const applied = await migrateToLatest(db, migrations);
    console.log(JSON.stringify({ msg: 'migrations applied', service, applied }));
  } finally {
    await db.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

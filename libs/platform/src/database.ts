import { Kysely, Migration, MigrationProvider, Migrator, PostgresDialect } from 'kysely';
import { Pool } from 'pg';

export interface DatabaseOptions {
  connectionString: string;
  poolMax: number;
  applicationName: string;
}

/**
 * One pool per service, one database per service. int8 columns stay strings (pg default):
 * amounts travel as strings end to end, so they never pass through a JS number.
 */
export function createDatabase<DB>(options: DatabaseOptions): Kysely<DB> {
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.poolMax,
    application_name: options.applicationName,
    // Fail fast instead of queueing forever when the pool is exhausted.
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 10_000,
  });
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
}

/** Migrations are registered in code (not discovered on disk) so they survive bundling. */
export async function migrateToLatest<DB>(
  db: Kysely<DB>,
  migrations: Record<string, Migration>,
): Promise<string[]> {
  const provider: MigrationProvider = { getMigrations: () => Promise.resolve(migrations) };
  const migrator = new Migrator({ db, provider });
  const { error, results } = await migrator.migrateToLatest();
  if (error) {
    const failed = results?.find((result) => result.status === 'Error')?.migrationName;
    throw new Error(
      `migration ${failed ?? '?'} failed: ${error instanceof Error ? error.message : JSON.stringify(error)}`,
      { cause: error },
    );
  }
  return (results ?? []).map((result) => result.migrationName);
}

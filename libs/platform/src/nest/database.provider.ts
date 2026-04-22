import { Inject, Injectable, OnApplicationShutdown, Provider } from '@nestjs/common';
import { Kysely, Migration, sql } from 'kysely';
import { createDatabase, migrateToLatest } from '../database';

export const DATABASE = Symbol('DATABASE');

export interface DatabaseProviderOptions {
  url: string;
  poolMax: number;
  applicationName: string;
  migrations: Record<string, Migration>;
  migrateOnStart: boolean;
}

/**
 * Kysely instance for the service's own database. Migrations run on start only when
 * MIGRATE_ON_START=true (local, tests); in EKS they run as a Helm pre-upgrade Job.
 */
export function databaseProvider(options: DatabaseProviderOptions): Provider {
  return {
    provide: DATABASE,
    useFactory: async () => {
      const db = createDatabase<unknown>({ ...options, connectionString: options.url });
      if (options.migrateOnStart) await migrateToLatest(db, options.migrations);
      return db;
    },
  };
}

@Injectable()
export class DatabaseLifecycle implements OnApplicationShutdown {
  constructor(@Inject(DATABASE) private readonly db: Kysely<unknown>) {}

  async onApplicationShutdown(): Promise<void> {
    await this.db.destroy();
  }
}

export function databaseHealthCheck(db: Kysely<unknown>) {
  return { name: 'postgres', check: async () => void (await sql`SELECT 1`.execute(db)) };
}

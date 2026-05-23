import { DynamicModule, Logger, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ServiceName } from '@saga/contracts';
import {
  MESSAGING,
  MessagingRuntime,
  Queues,
  createOutboxRelay,
  createQueueConsumer,
  envelopeHandler,
  messagingProvider,
} from '@saga/messaging';
import {
  HEALTH_CHECKS,
  HealthController,
  METRICS,
  Metrics,
  loggerModule,
} from '@saga/observability';
import {
  DATABASE,
  DatabaseLifecycle,
  ProblemDetailsFilter,
  WORKERS,
  WorkerHost,
  authProviders,
  databaseHealthCheck,
  databaseProvider,
} from '@saga/platform';
import type { Kysely } from 'kysely';
import { InventoryEnv, InventoryScopes } from './config';
import { inventoryMigrations } from './database/migrations';
import type { InventoryDatabase } from './database/schema';
import { ProductsController } from './stock/products.controller';
import { StockService } from './stock/stock.service';

@Module({})
export class InventoryModule {
  static forRoot(env: InventoryEnv): DynamicModule {
    const metrics = new Metrics(ServiceName.inventory, undefined, env.METRICS_ENABLED);
    const logger = new Logger('InventoryCommands');
    return {
      module: InventoryModule,
      imports: [
        loggerModule({
          serviceName: ServiceName.inventory,
          level: env.LOG_LEVEL,
          pretty: env.LOG_PRETTY,
        }),
      ],
      controllers: [ProductsController, HealthController],
      providers: [
        databaseProvider({
          url: env.DATABASE_URL,
          poolMax: env.DATABASE_POOL_MAX,
          applicationName: ServiceName.inventory,
          migrations: inventoryMigrations,
          migrateOnStart: env.MIGRATE_ON_START,
        }),
        DatabaseLifecycle,
        messagingProvider(env),
        { provide: METRICS, useValue: metrics },
        ...authProviders(env, Object.values(InventoryScopes)),
        { provide: APP_FILTER, useClass: ProblemDetailsFilter },
        StockService,
        {
          provide: WORKERS,
          inject: [DATABASE, MESSAGING, StockService],
          useFactory: (
            db: Kysely<InventoryDatabase>,
            messaging: MessagingRuntime,
            stock: StockService,
          ) => [
            createOutboxRelay(db, messaging, env),
            createQueueConsumer(
              messaging,
              env,
              Queues.inventoryCommands,
              envelopeHandler(async (command) => {
                const outcome = await stock.handle(command);
                logger.log({ type: command.type, outcome }, 'command handled');
              }),
              (outcome) => metrics.count('MessagesConsumed', 1, { Outcome: outcome }),
            ),
          ],
        },
        WorkerHost,
        {
          provide: HEALTH_CHECKS,
          inject: [DATABASE],
          useFactory: (db: Kysely<unknown>) => [databaseHealthCheck(db)],
        },
      ],
    };
  }
}

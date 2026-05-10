import { DynamicModule, Inject, Injectable, Module, OnApplicationShutdown } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
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
import { ServiceName } from '@saga/contracts';
import type { Kysely } from 'kysely';
import type { Db, MongoClient } from 'mongodb';
import { ORDER_ENV, OrderEnv, OrderScopes } from './config';
import { orderMigrations } from './database/migrations';
import type { OrderDatabase } from './database/schema';
import { MONGO_CLIENT, MONGO_DB, createMongoClient } from './history/mongo';
import { OrderHistoryController } from './history/order-history.controller';
import { archiveAndProject, ensureHistoryIndexes } from './history/order-history.projector';
import { OrdersController } from './orders/orders.controller';
import { OrdersService } from './orders/orders.service';
import { SagaAdminController } from './saga/saga-admin.controller';
import { SagaTimeoutScanner, sagaReplyHandler } from './saga/saga-workers';
import { SagaService } from './saga/saga.service';

@Injectable()
class MongoLifecycle implements OnApplicationShutdown {
  constructor(@Inject(MONGO_CLIENT) private readonly client: MongoClient) {}

  async onApplicationShutdown(): Promise<void> {
    await this.client.close();
  }
}

@Module({})
export class OrderModule {
  static forRoot(env: OrderEnv): DynamicModule {
    return {
      module: OrderModule,
      imports: [
        loggerModule({
          serviceName: ServiceName.order,
          level: env.LOG_LEVEL,
          pretty: env.NODE_ENV === 'development',
        }),
      ],
      controllers: [
        OrdersController,
        OrderHistoryController,
        SagaAdminController,
        HealthController,
      ],
      providers: [
        { provide: ORDER_ENV, useValue: env },
        databaseProvider({
          url: env.DATABASE_URL,
          poolMax: env.DATABASE_POOL_MAX,
          applicationName: ServiceName.order,
          migrations: orderMigrations,
          migrateOnStart: env.MIGRATE_ON_START,
        }),
        DatabaseLifecycle,
        {
          provide: MONGO_CLIENT,
          useFactory: async () => {
            const client = await createMongoClient(env.MONGO_URL).connect();
            await ensureHistoryIndexes(client.db(env.MONGO_DB));
            return client;
          },
        },
        {
          provide: MONGO_DB,
          inject: [MONGO_CLIENT],
          useFactory: (client: MongoClient) => client.db(env.MONGO_DB),
        },
        MongoLifecycle,
        messagingProvider(env),
        {
          provide: METRICS,
          useValue: new Metrics(ServiceName.order, undefined, env.METRICS_ENABLED),
        },
        ...authProviders(env, Object.values(OrderScopes)),
        { provide: APP_FILTER, useClass: ProblemDetailsFilter },
        SagaService,
        OrdersService,
        {
          provide: WORKERS,
          inject: [DATABASE, MESSAGING, SagaService, MONGO_DB],
          useFactory: (
            db: Kysely<OrderDatabase>,
            messaging: MessagingRuntime,
            sagas: SagaService,
            mongo: Db,
          ) => [
            createOutboxRelay(db, messaging, env),
            ...(env.SAGA_WORKERS_ENABLED
              ? [
                  createQueueConsumer(
                    messaging,
                    env,
                    Queues.orderSagaReplies,
                    envelopeHandler(sagaReplyHandler(sagas)),
                  ),
                  new SagaTimeoutScanner(sagas, env.SAGA_SCAN_INTERVAL_MS),
                ]
              : []),
            ...(env.PROJECTOR_ENABLED
              ? [
                  createQueueConsumer(
                    messaging,
                    env,
                    Queues.orderHistory,
                    envelopeHandler((event) => archiveAndProject(mongo, event)),
                  ),
                ]
              : []),
          ],
        },
        WorkerHost,
        {
          provide: HEALTH_CHECKS,
          inject: [DATABASE, MONGO_DB],
          useFactory: (db: Kysely<unknown>, mongo: Db) => [
            databaseHealthCheck(db),
            { name: 'mongo', check: async () => void (await mongo.command({ ping: 1 })) },
          ],
        },
      ],
    };
  }
}

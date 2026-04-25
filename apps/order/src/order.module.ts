import { DynamicModule, Module } from '@nestjs/common';
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
import { ORDER_ENV, OrderEnv, OrderScopes } from './config';
import { orderMigrations } from './database/migrations';
import type { OrderDatabase } from './database/schema';
import { OrdersController } from './orders/orders.controller';
import { OrdersService } from './orders/orders.service';
import { SagaAdminController } from './saga/saga-admin.controller';
import { SagaTimeoutScanner, sagaReplyHandler } from './saga/saga-workers';
import { SagaService } from './saga/saga.service';

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
      controllers: [OrdersController, SagaAdminController, HealthController],
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
          inject: [DATABASE, MESSAGING, SagaService],
          useFactory: (
            db: Kysely<OrderDatabase>,
            messaging: MessagingRuntime,
            sagas: SagaService,
          ) => [
            createOutboxRelay(db, messaging, env),
            createQueueConsumer(
              messaging,
              env,
              Queues.orderSagaReplies,
              envelopeHandler(sagaReplyHandler(sagas)),
            ),
            new SagaTimeoutScanner(sagas, env.SAGA_SCAN_INTERVAL_MS),
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

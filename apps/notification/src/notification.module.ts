import { DynamicModule, Logger, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ServiceName } from '@saga/contracts';
import {
  MESSAGING,
  MessagingRuntime,
  Queues,
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
  parseEnv,
} from '@saga/platform';
import type { Kysely } from 'kysely';
import { notificationMigrations } from './database/migrations';
import {
  LogNotificationSender,
  NOTIFICATION_SENDER,
  NotificationService,
} from './notifications/notification.service';

export type NotificationEnv = ReturnType<typeof loadNotificationEnv>;

export function loadNotificationEnv(source: NodeJS.ProcessEnv = process.env) {
  return parseEnv({}, source);
}

@Module({})
export class NotificationModule {
  static forRoot(env: NotificationEnv, sender = new LogNotificationSender()): DynamicModule {
    const metrics = new Metrics(ServiceName.notification, undefined, env.METRICS_ENABLED);
    const logger = new Logger('NotificationEvents');
    return {
      module: NotificationModule,
      imports: [
        loggerModule({
          serviceName: ServiceName.notification,
          level: env.LOG_LEVEL,
          pretty: env.NODE_ENV === 'development',
        }),
      ],
      controllers: [HealthController],
      providers: [
        databaseProvider({
          url: env.DATABASE_URL,
          poolMax: env.DATABASE_POOL_MAX,
          applicationName: ServiceName.notification,
          migrations: notificationMigrations,
          migrateOnStart: env.MIGRATE_ON_START,
        }),
        DatabaseLifecycle,
        messagingProvider(env),
        { provide: METRICS, useValue: metrics },
        { provide: NOTIFICATION_SENDER, useValue: sender },
        ...authProviders(env, []),
        { provide: APP_FILTER, useClass: ProblemDetailsFilter },
        NotificationService,
        {
          provide: WORKERS,
          inject: [MESSAGING, NotificationService],
          useFactory: (messaging: MessagingRuntime, notifications: NotificationService) => [
            createQueueConsumer(
              messaging,
              env,
              Queues.notificationOrderEvents,
              envelopeHandler(async (event) => {
                const outcome = await notifications.handle(event);
                logger.log({ type: event.type, outcome }, 'event handled');
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

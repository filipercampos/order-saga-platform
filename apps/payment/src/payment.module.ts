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
  ClientCredentialsTokenProvider,
  DATABASE,
  DatabaseLifecycle,
  ProblemDetailsFilter,
  StaticTokenProvider,
  WORKERS,
  WorkerHost,
  authProviders,
  databaseHealthCheck,
  databaseProvider,
} from '@saga/platform';
import { CircuitBreaker } from '@saga/resilience';
import type { Kysely } from 'kysely';
import { LEDGER_CLIENT, PAYMENT_ENV, PaymentEnv, PaymentScopes } from './config';
import { paymentMigrations } from './database/migrations';
import type { PaymentDatabase } from './database/schema';
import { LedgerClient } from './ledger/ledger-client';
import { PaymentService } from './payments/payment.service';
import { WalletsController } from './payments/wallets.controller';

function ledgerClient(env: PaymentEnv, metrics: Metrics): LedgerClient {
  const logger = new Logger('LedgerCircuit');
  const tokens =
    env.LEDGER_AUTH_MODE === 'static'
      ? new StaticTokenProvider(env.LEDGER_STATIC_TOKEN)
      : new ClientCredentialsTokenProvider({
          tokenUrl: env.LEDGER_TOKEN_URL ?? '',
          clientId: env.LEDGER_CLIENT_ID ?? '',
          clientSecret: env.LEDGER_CLIENT_SECRET ?? '',
          scopes: env.LEDGER_SCOPES,
        });
  return new LedgerClient({
    baseUrl: env.LEDGER_BASE_URL,
    timeoutMs: env.LEDGER_TIMEOUT_MS,
    maxAttempts: env.LEDGER_MAX_ATTEMPTS,
    backoffBaseMs: env.LEDGER_BACKOFF_BASE_MS,
    backoffCapMs: env.LEDGER_BACKOFF_CAP_MS,
    tokens,
    breaker: new CircuitBreaker({
      failureThreshold: env.LEDGER_BREAKER_THRESHOLD,
      resetTimeoutMs: env.LEDGER_BREAKER_RESET_MS,
      onStateChange: (from, to) => {
        logger.warn({ from, to }, 'ledger circuit state changed');
        metrics.count('LedgerCircuitTransition', 1, { To: to });
      },
    }),
  });
}

@Module({})
export class PaymentModule {
  static forRoot(env: PaymentEnv): DynamicModule {
    const metrics = new Metrics(ServiceName.payment, undefined, env.METRICS_ENABLED);
    const logger = new Logger('PaymentCommands');
    return {
      module: PaymentModule,
      imports: [
        loggerModule({
          serviceName: ServiceName.payment,
          level: env.LOG_LEVEL,
          pretty: env.LOG_PRETTY,
        }),
      ],
      controllers: [WalletsController, HealthController],
      providers: [
        { provide: PAYMENT_ENV, useValue: env },
        { provide: LEDGER_CLIENT, useValue: ledgerClient(env, metrics) },
        databaseProvider({
          url: env.DATABASE_URL,
          poolMax: env.DATABASE_POOL_MAX,
          applicationName: ServiceName.payment,
          migrations: paymentMigrations,
          migrateOnStart: env.MIGRATE_ON_START,
        }),
        DatabaseLifecycle,
        messagingProvider(env),
        { provide: METRICS, useValue: metrics },
        ...authProviders(env, Object.values(PaymentScopes)),
        { provide: APP_FILTER, useClass: ProblemDetailsFilter },
        PaymentService,
        {
          provide: WORKERS,
          inject: [DATABASE, MESSAGING, PaymentService],
          useFactory: (
            db: Kysely<PaymentDatabase>,
            messaging: MessagingRuntime,
            payments: PaymentService,
          ) => [
            createOutboxRelay(db, messaging, env),
            createQueueConsumer(
              messaging,
              env,
              Queues.paymentCommands,
              envelopeHandler(async (command) => {
                const outcome = await payments.handle(command);
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
          // The ledger is deliberately not a readiness dependency: an outage there must
          // not take payment pods out of the Service (commands just wait in SQS).
          useFactory: (db: Kysely<unknown>) => [databaseHealthCheck(db)],
        },
      ],
    };
  }
}

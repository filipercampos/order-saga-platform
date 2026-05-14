import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { LocalstackContainer, StartedLocalStackContainer } from '@testcontainers/localstack';
import { MongoDBContainer, StartedMongoDBContainer } from '@testcontainers/mongodb';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { MongoClient } from 'mongodb';
import request from 'supertest';
import { LedgerStub } from '../../apps/ledger-stub/src/ledger-stub';
import { loadInventoryEnv } from '../../apps/inventory/src/config';
import { InventoryModule } from '../../apps/inventory/src/inventory.module';
import {
  NotificationModule,
  loadNotificationEnv,
} from '../../apps/notification/src/notification.module';
import { LogNotificationSender } from '../../apps/notification/src/notifications/notification.service';
import { loadOrderEnv } from '../../apps/order/src/config';
import { OrderModule } from '../../apps/order/src/order.module';
import { loadPaymentEnv } from '../../apps/payment/src/config';
import { PaymentModule } from '../../apps/payment/src/payment.module';
import {
  ProvisionResult,
  QueueOverrides,
  Queues,
  createAwsClients,
  defaultTopology,
  provisionTopology,
} from '@saga/messaging';
import { createServiceApp } from '@saga/platform';

export const MERCHANT_ACCOUNT = 'merchant-revenue';
const SERVICE_TOKEN = 'Bearer svc-test-operator';

/** Faster redelivery in tests than in production (ADR 0003 has the real numbers). */
const testQueueOverrides: QueueOverrides = {
  [Queues.inventoryCommands]: { maxReceiveCount: 3 },
  [Queues.paymentCommands]: { maxReceiveCount: 4 },
};

export interface Platform {
  order: INestApplication;
  inventory: INestApplication;
  payment: INestApplication;
  notification: INestApplication;
  ledger: LedgerStub;
  notifications: LogNotificationSender;
  mongo: MongoClient;
  pgUrl: (database: string) => string;
  aws: ReturnType<typeof createAwsClients>;
  topology: ProvisionResult;
  namespace: string;
  stop(): Promise<void>;
}

export interface PlatformOptions {
  chargeTimeoutMs?: number;
}

/**
 * Starts Postgres, MongoDB 5.0 and LocalStack in containers (random host ports), the
 * ledger stub, and all four services in-process with their real modules, real SQS
 * consumers and real outbox relays.
 */
export async function startPlatform(options: PlatformOptions = {}): Promise<Platform> {
  process.env.AWS_ACCESS_KEY_ID ??= 'test';
  process.env.AWS_SECRET_ACCESS_KEY ??= 'test';

  const [postgres, mongoContainer, localstack]: [
    StartedPostgreSqlContainer,
    StartedMongoDBContainer,
    StartedLocalStackContainer,
  ] = await Promise.all([
    new PostgreSqlContainer('postgres:16-alpine').start(),
    new MongoDBContainer('mongo:5.0').start(),
    new LocalstackContainer('localstack/localstack:3.8')
      .withEnvironment({ SERVICES: 'sns,sqs' })
      .start(),
  ]);

  const admin = new Client({ connectionString: postgres.getConnectionUri() });
  await admin.connect();
  for (const db of ['orders', 'inventory', 'payments', 'notifications']) {
    await admin.query(`CREATE DATABASE ${db}`);
  }
  await admin.end();
  const pgUrl = (database: string) => {
    const url = new URL(postgres.getConnectionUri());
    url.pathname = `/${database}`;
    return url.toString();
  };

  const endpoint = localstack.getConnectionUri();
  const namespace = `it-${randomUUID().slice(0, 8)}`;
  const aws = createAwsClients({ region: 'us-east-1', endpoint });
  const topology = await provisionTopology(aws, namespace, defaultTopology(testQueueOverrides));

  const ledger = new LedgerStub(0n);
  const ledgerUrl = await ledger.listen();
  const mongoUrl = `${mongoContainer.getConnectionString()}?directConnection=true`;

  const common = {
    NODE_ENV: 'test',
    LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? 'silent',
    MIGRATE_ON_START: 'true',
    AUTH_MODE: 'disabled',
    AWS_REGION: 'us-east-1',
    AWS_ENDPOINT_URL: endpoint,
    MESSAGING_NAMESPACE: namespace,
    SQS_WAIT_TIME_SECONDS: '1',
    SQS_RETRY_BASE_SECONDS: '1',
    OUTBOX_POLL_INTERVAL_MS: '100',
    METRICS_ENABLED: 'false',
  };

  const notifications = new LogNotificationSender();
  const apps = await Promise.all([
    createServiceApp(
      OrderModule.forRoot(
        loadOrderEnv({
          ...common,
          DATABASE_URL: pgUrl('orders'),
          MONGO_URL: mongoUrl,
          SAGA_RESERVE_TIMEOUT_MS: '20000',
          SAGA_CHARGE_TIMEOUT_MS: String(options.chargeTimeoutMs ?? 6_000),
          SAGA_COMPENSATION_TIMEOUT_MS: '5000',
          SAGA_SCAN_INTERVAL_MS: '200',
        }),
      ),
    ),
    createServiceApp(
      InventoryModule.forRoot(loadInventoryEnv({ ...common, DATABASE_URL: pgUrl('inventory') })),
    ),
    createServiceApp(
      PaymentModule.forRoot(
        loadPaymentEnv({
          ...common,
          DATABASE_URL: pgUrl('payments'),
          LEDGER_BASE_URL: ledgerUrl,
          LEDGER_MERCHANT_ACCOUNT_ID: MERCHANT_ACCOUNT,
          LEDGER_AUTH_MODE: 'static',
          LEDGER_TIMEOUT_MS: '300',
          LEDGER_MAX_ATTEMPTS: '2',
          LEDGER_BACKOFF_BASE_MS: '50',
          LEDGER_BACKOFF_CAP_MS: '200',
          LEDGER_BREAKER_RESET_MS: '1000',
        }),
      ),
    ),
    createServiceApp(
      NotificationModule.forRoot(
        loadNotificationEnv({ ...common, DATABASE_URL: pgUrl('notifications') }),
        notifications,
      ),
    ),
  ]);
  for (const app of apps) await app.init();
  const [order, inventory, payment, notification] = apps;

  const mongo = await new MongoClient(mongoUrl).connect();

  return {
    order,
    inventory,
    payment,
    notification,
    ledger,
    notifications,
    mongo,
    pgUrl,
    aws,
    topology,
    namespace,
    async stop() {
      await Promise.all(apps.map((app) => app.close()));
      await mongo.close();
      await ledger.close();
      await Promise.all([postgres.stop(), mongoContainer.stop(), localstack.stop()]);
    },
  };
}

export async function seedProduct(
  platform: Platform,
  sku: string,
  available: number,
  unitPrice = '1500',
): Promise<void> {
  await request(platform.inventory.getHttpServer())
    .put(`/internal/products/${sku}`)
    .set('Authorization', SERVICE_TOKEN)
    .send({ name: sku, unitPrice, currency: 'BRL', available })
    .expect(200);
}

export async function product(platform: Platform, sku: string) {
  const res = await request(platform.inventory.getHttpServer())
    .get(`/internal/products/${sku}`)
    .set('Authorization', SERVICE_TOKEN)
    .expect(200);
  return res.body as { available: number; reserved: number };
}

/** Creates a customer with a funded ledger wallet. */
export async function seedCustomer(platform: Platform, balance: bigint): Promise<string> {
  const customerId = `cust-${randomUUID().slice(0, 8)}`;
  const walletId = `wallet-${customerId}`;
  platform.ledger.setBalance(walletId, balance);
  await request(platform.payment.getHttpServer())
    .put(`/internal/wallets/${customerId}`)
    .set('Authorization', SERVICE_TOKEN)
    .send({ ledgerAccountId: walletId })
    .expect(200);
  return customerId;
}

export async function placeOrder(
  platform: Platform,
  customerId: string,
  items: { sku: string; quantity: number }[],
): Promise<string> {
  const res = await request(platform.order.getHttpServer())
    .post('/orders')
    .set('Authorization', `Bearer ${customerId}`)
    .set('Idempotency-Key', `key-${randomUUID()}`)
    .send({ items })
    .expect(202);
  return (res.body as { orderId: string }).orderId;
}

export interface OrderView {
  status: string;
  sagaState: string;
  cancelReason: string | null;
  total: string | null;
}

export async function getOrder(platform: Platform, customerId: string, orderId: string) {
  const res = await request(platform.order.getHttpServer())
    .get(`/orders/${orderId}`)
    .set('Authorization', `Bearer ${customerId}`)
    .expect(200);
  return res.body as OrderView;
}

export async function waitForOrder(
  platform: Platform,
  customerId: string,
  orderId: string,
  predicate: (order: OrderView) => boolean,
  timeoutMs = 30_000,
): Promise<OrderView> {
  let last: OrderView | undefined;
  await waitFor(
    async () => {
      last = await getOrder(platform, customerId, orderId);
      return predicate(last);
    },
    timeoutMs,
    () => `order ${orderId} stuck at ${JSON.stringify(last)}`,
  );
  return last as OrderView;
}

export async function waitFor(
  condition: () => Promise<boolean> | boolean,
  timeoutMs = 30_000,
  describe: () => string = () => 'condition',
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out waiting for ${describe()}`);
}

export const isTerminal = (order: OrderView) =>
  order.status === 'CONFIRMED' || order.status === 'CANCELLED' || order.status === 'FAILED';

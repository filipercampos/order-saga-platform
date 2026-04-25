import { Provider } from '@nestjs/common';
import { OutboxRelay } from '@saga/outbox';
import type { BaseEnv } from '@saga/platform';
import type { Kysely } from 'kysely';
import { AwsClients, MessagingAddresses, createAwsClients } from './aws';
import { SnsPublisher } from './sns-publisher';
import { MessageOutcome, ReceivedMessage, SqsConsumer } from './sqs-consumer';
import { QueueName, defaultTopology, isFifo } from './topology';

export const MESSAGING = Symbol('MESSAGING');

export interface MessagingRuntime {
  clients: AwsClients;
  addresses: MessagingAddresses;
  publisher: SnsPublisher;
}

export function messagingProvider(env: BaseEnv): Provider {
  return {
    provide: MESSAGING,
    useFactory: (): MessagingRuntime => {
      const config = {
        region: env.AWS_REGION,
        endpoint: env.AWS_ENDPOINT_URL,
        accountId: env.AWS_ACCOUNT_ID,
        namespace: env.MESSAGING_NAMESPACE,
      };
      const clients = createAwsClients(config);
      const addresses = new MessagingAddresses(config, clients.sqs);
      return { clients, addresses, publisher: new SnsPublisher(clients.sns, addresses) };
    },
  };
}

export function createOutboxRelay<DB>(
  db: Kysely<DB>,
  messaging: MessagingRuntime,
  env: BaseEnv,
  onBatch?: (result: { published: number; failed: number }) => void,
): OutboxRelay<DB> {
  return new OutboxRelay(db, messaging.publisher, {
    batchSize: env.OUTBOX_BATCH_SIZE,
    maxAttempts: env.OUTBOX_MAX_ATTEMPTS,
    retryBaseMs: 1_000,
    pollIntervalMs: env.OUTBOX_POLL_INTERVAL_MS,
    onBatch,
  });
}

export function createQueueConsumer(
  messaging: MessagingRuntime,
  env: BaseEnv,
  queue: QueueName,
  handler: (message: ReceivedMessage) => Promise<void>,
  onOutcome?: (outcome: MessageOutcome, message: ReceivedMessage) => void,
): SqsConsumer {
  const spec = defaultTopology().queues.find((q) => q.name === queue);
  return new SqsConsumer({
    name: queue,
    sqs: messaging.clients.sqs,
    queueUrl: () => messaging.addresses.queueUrl(queue),
    fifo: isFifo(queue),
    handler,
    visibilityTimeoutSeconds: spec?.visibilityTimeoutSeconds ?? 30,
    waitTimeSeconds: env.SQS_WAIT_TIME_SECONDS,
    retryBaseSeconds: env.SQS_RETRY_BASE_SECONDS,
    onOutcome,
  });
}

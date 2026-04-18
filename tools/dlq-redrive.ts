/**
 * Redrives messages from a queue's DLQ back to the queue.
 * Usage: npm run dlq:redrive -- <logical-queue-name> [limit] [--dry-run]
 * Example: npm run dlq:redrive -- payment-commands.fifo 10
 */
import {
  MessagingAddresses,
  createAwsClients,
  dlqNameOf,
  isFifo,
  redriveDlq,
} from '@saga/messaging';

async function main(): Promise<void> {
  const [queue, limitArg] = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
  if (!queue) throw new Error('usage: dlq-redrive <logical-queue-name> [limit] [--dry-run]');
  const config = {
    region: process.env.AWS_REGION ?? 'us-east-1',
    endpoint: process.env.AWS_ENDPOINT_URL,
    accountId: process.env.AWS_ACCOUNT_ID ?? '000000000000',
    namespace: process.env.MESSAGING_NAMESPACE ?? 'saga-local',
  };
  const { sqs } = createAwsClients(config);
  const addresses = new MessagingAddresses(config, sqs);
  const moved = await redriveDlq(sqs, {
    dlqUrl: await addresses.queueUrl(dlqNameOf(queue)),
    targetUrl: await addresses.queueUrl(queue),
    fifo: isFifo(queue),
    limit: Number(limitArg ?? 10),
    dryRun: process.argv.includes('--dry-run'),
  });
  console.log(`${process.argv.includes('--dry-run') ? 'would move' : 'moved'} ${moved} message(s)`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

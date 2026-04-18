/**
 * Creates the SNS/SQS topology on LocalStack (or any endpoint in AWS_ENDPOINT_URL).
 * Usage: npm run provision:local
 */
import { createAwsClients, defaultTopology, provisionTopology } from '@saga/messaging';

async function main(): Promise<void> {
  const namespace = process.env.MESSAGING_NAMESPACE ?? 'saga-local';
  const clients = createAwsClients({
    region: process.env.AWS_REGION ?? 'us-east-1',
    endpoint: process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4567',
  });
  const result = await provisionTopology(clients, namespace, defaultTopology());
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

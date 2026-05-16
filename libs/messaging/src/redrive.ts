import {
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SQSClient,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { randomUUID } from 'node:crypto';

export interface RedriveOptions {
  dlqUrl: string;
  targetUrl: string;
  fifo: boolean;
  /** Stop after this many messages (redrive in small steps while watching the consumer). */
  limit: number;
  dryRun?: boolean;
}

/**
 * Moves messages from a DLQ back to its source queue, preserving body, attributes and
 * (for FIFO) the message group. Works on LocalStack and on queues where the console's
 * "Start DLQ redrive" (StartMessageMoveTask) is not available or not wanted.
 * Consumers are idempotent (inbox), so redriving an already-processed message is safe.
 */
export async function redriveDlq(sqs: SQSClient, options: RedriveOptions): Promise<number> {
  // Bound the run by the depth at start: a message that fails again and is dead-lettered
  // during the redrive must not be picked up a second time (that would loop forever).
  const attributes = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: options.dlqUrl,
      AttributeNames: ['ApproximateNumberOfMessages'],
    }),
  );
  const limit = Math.min(
    options.limit,
    Number(attributes.Attributes?.ApproximateNumberOfMessages ?? 0),
  );
  let moved = 0;
  while (moved < limit) {
    const out = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: options.dlqUrl,
        MaxNumberOfMessages: Math.min(10, limit - moved),
        WaitTimeSeconds: 1,
        VisibilityTimeout: 60,
        MessageAttributeNames: ['All'],
        MessageSystemAttributeNames: ['MessageGroupId'],
      }),
    );
    const messages = out.Messages ?? [];
    if (messages.length === 0) break;
    for (const message of messages) {
      if (!options.dryRun) {
        await sqs.send(
          new SendMessageCommand({
            QueueUrl: options.targetUrl,
            MessageBody: message.Body ?? '',
            MessageAttributes: message.MessageAttributes,
            ...(options.fifo
              ? {
                  MessageGroupId: message.Attributes?.MessageGroupId ?? 'redrive',
                  MessageDeduplicationId: randomUUID(),
                }
              : {}),
          }),
        );
        await sqs.send(
          new DeleteMessageCommand({
            QueueUrl: options.dlqUrl,
            ReceiptHandle: message.ReceiptHandle,
          }),
        );
      }
      moved += 1;
    }
    if (options.dryRun) break;
  }
  return moved;
}

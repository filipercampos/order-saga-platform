import { CreateTopicCommand, SNSClient, SubscribeCommand } from '@aws-sdk/client-sns';
import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  QueueAttributeName,
  SQSClient,
  SetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';
import { Topology, dlqNameOf, isFifo, physicalName } from './topology';

/** DLQ retention: the maximum, so there is time to investigate and redrive. */
const DLQ_RETENTION_SECONDS = 14 * 24 * 3600;

export interface ProvisionResult {
  topicArns: Record<string, string>;
  queueUrls: Record<string, string>;
  dlqUrls: Record<string, string>;
}

/**
 * Idempotently creates topics, queues, DLQs and subscriptions. Used against LocalStack
 * (docker compose, integration tests). In AWS the same topology comes from
 * infra/messaging.yaml.
 */
export async function provisionTopology(
  clients: { sns: SNSClient; sqs: SQSClient },
  namespace: string,
  topology: Topology,
): Promise<ProvisionResult> {
  const { sns, sqs } = clients;
  const result: ProvisionResult = { topicArns: {}, queueUrls: {}, dlqUrls: {} };

  for (const topic of topology.topics) {
    const fifo = isFifo(topic);
    const out = await sns.send(
      new CreateTopicCommand({
        Name: physicalName(namespace, topic),
        Attributes: fifo ? { FifoTopic: 'true', ContentBasedDeduplication: 'false' } : {},
      }),
    );
    result.topicArns[topic] = required(out.TopicArn, topic);
  }

  for (const queue of topology.queues) {
    const fifo = isFifo(queue.name);
    const fifoAttributes: Partial<Record<QueueAttributeName, string>> = fifo
      ? { FifoQueue: 'true', ContentBasedDeduplication: 'false' }
      : {};

    const dlq = await sqs.send(
      new CreateQueueCommand({
        QueueName: physicalName(namespace, dlqNameOf(queue.name)),
        Attributes: { ...fifoAttributes, MessageRetentionPeriod: String(DLQ_RETENTION_SECONDS) },
      }),
    );
    const dlqUrl = required(dlq.QueueUrl, queue.name);
    const dlqArn = await queueArn(sqs, dlqUrl);

    const created = await sqs.send(
      new CreateQueueCommand({
        QueueName: physicalName(namespace, queue.name),
        Attributes: { ...fifoAttributes, ReceiveMessageWaitTimeSeconds: '20' },
      }),
    );
    const queueUrl = required(created.QueueUrl, queue.name);
    const arn = await queueArn(sqs, queueUrl);
    const topicArns = queue.subscriptions.map((s) => result.topicArns[s.topic] ?? '');

    // Set mutable attributes separately so re-running provisioning applies changes.
    await sqs.send(
      new SetQueueAttributesCommand({
        QueueUrl: queueUrl,
        Attributes: {
          VisibilityTimeout: String(queue.visibilityTimeoutSeconds),
          RedrivePolicy: JSON.stringify({
            deadLetterTargetArn: dlqArn,
            maxReceiveCount: queue.maxReceiveCount,
          }),
          Policy: JSON.stringify({
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Principal: { Service: 'sns.amazonaws.com' },
                Action: 'sqs:SendMessage',
                Resource: arn,
                Condition: { ArnEquals: { 'aws:SourceArn': topicArns } },
              },
            ],
          }),
        },
      }),
    );
    await sqs.send(
      new SetQueueAttributesCommand({
        QueueUrl: dlqUrl,
        Attributes: {
          RedriveAllowPolicy: JSON.stringify({
            redrivePermission: 'byQueue',
            sourceQueueArns: [arn],
          }),
        },
      }),
    );

    for (const subscription of queue.subscriptions) {
      await sns.send(
        new SubscribeCommand({
          TopicArn: result.topicArns[subscription.topic],
          Protocol: 'sqs',
          Endpoint: arn,
          Attributes: {
            // The SQS body is our envelope, not an SNS notification wrapper.
            RawMessageDelivery: 'true',
            ...(subscription.filterPolicy
              ? { FilterPolicy: JSON.stringify(subscription.filterPolicy) }
              : {}),
          },
        }),
      );
    }
    result.queueUrls[queue.name] = queueUrl;
    result.dlqUrls[queue.name] = dlqUrl;
  }
  return result;
}

async function queueArn(sqs: SQSClient, queueUrl: string): Promise<string> {
  const out = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['QueueArn'] }),
  );
  return required(out.Attributes?.QueueArn, queueUrl);
}

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`provisioning returned no value for ${what}`);
  return value;
}

import {
  MessageAttributeValue,
  PublishBatchCommand,
  PublishBatchRequestEntry,
  SNSClient,
} from '@aws-sdk/client-sns';
import type { MessagePublisher, OutboundMessage, PublishResult } from '@saga/outbox';
import { MessagingAddresses } from './aws';
import { isFifo } from './topology';

const SNS_BATCH_LIMIT = 10;

/** Outbox publisher backed by SNS PublishBatch. */
export class SnsPublisher implements MessagePublisher {
  constructor(
    private readonly sns: SNSClient,
    private readonly addresses: MessagingAddresses,
  ) {}

  async publish(messages: OutboundMessage[]): Promise<PublishResult> {
    const failed = new Map<string, string>();
    const byTopic = new Map<string, OutboundMessage[]>();
    for (const message of messages) {
      byTopic.set(message.topic, [...(byTopic.get(message.topic) ?? []), message]);
    }

    for (const [topic, topicMessages] of byTopic) {
      const fifo = isFifo(topic);
      // Batches are sent sequentially: SNS FIFO keeps per-group order within a batch,
      // and sequential batches keep it across batches.
      for (let i = 0; i < topicMessages.length; i += SNS_BATCH_LIMIT) {
        const chunk = topicMessages.slice(i, i + SNS_BATCH_LIMIT);
        try {
          const out = await this.sns.send(
            new PublishBatchCommand({
              TopicArn: this.addresses.topicArn(topic),
              PublishBatchRequestEntries: chunk.map((m) => toEntry(m, fifo)),
            }),
          );
          for (const failure of out.Failed ?? []) {
            if (failure.Id) failed.set(failure.Id, `${failure.Code}: ${failure.Message ?? ''}`);
          }
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          for (const m of chunk) failed.set(m.eventId, reason);
        }
      }
    }
    return { failed };
  }
}

function toEntry(message: OutboundMessage, fifo: boolean): PublishBatchRequestEntry {
  const attributes: Record<string, MessageAttributeValue> = {};
  for (const [key, value] of Object.entries(message.attributes)) {
    attributes[key] = { DataType: 'String', StringValue: value };
  }
  return {
    Id: message.eventId,
    Message: message.body,
    MessageAttributes: attributes,
    ...(fifo
      ? {
          MessageGroupId: message.groupId ?? message.eventId,
          // Our own id, not content hashing: a re-published outbox row is deduplicated by SNS
          // within the 5-minute window, and by consumer inboxes after that.
          MessageDeduplicationId: message.eventId,
        }
      : {}),
  };
}

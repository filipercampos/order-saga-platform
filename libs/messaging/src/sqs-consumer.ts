import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  Message,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { Logger } from '@nestjs/common';
import { ROOT_CONTEXT, SpanKind, SpanStatusCode, propagation, trace } from '@opentelemetry/api';
import { InvalidMessageError, TypedEnvelope, parseEnvelope } from '@saga/contracts';
import { InterruptibleSleep, Worker, backoffWithJitter, runWithCorrelation } from '@saga/platform';

/** A message that can never be processed (bad schema, unknown type). Goes to the DLQ fast. */
export class PoisonMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PoisonMessageError';
  }
}

export function isPoison(error: unknown): boolean {
  return error instanceof PoisonMessageError || error instanceof InvalidMessageError;
}

export interface ReceivedMessage {
  messageId: string;
  body: string;
  attributes: Record<string, string>;
  receiveCount: number;
  groupId?: string;
}

export type MessageOutcome = 'processed' | 'retry' | 'poison';

export interface SqsConsumerOptions {
  name: string;
  sqs: SQSClient;
  queueUrl: () => Promise<string>;
  fifo: boolean;
  handler: (message: ReceivedMessage) => Promise<void>;
  visibilityTimeoutSeconds: number;
  waitTimeSeconds?: number;
  maxMessages?: number;
  /** Base for the visibility backoff applied after a transient failure. */
  retryBaseSeconds?: number;
  onOutcome?: (outcome: MessageOutcome, message: ReceivedMessage) => void;
}

const MAX_RETRY_DELAY_SECONDS = 900;
const tracer = trace.getTracer('saga-messaging');

/**
 * Long-polling SQS consumer.
 *
 * - success          -> DeleteMessage
 * - transient error  -> leave the message, set visibility to an exponential backoff with
 *                       jitter (by ApproximateReceiveCount); redrive moves it to the DLQ
 *                       after maxReceiveCount
 * - poison message   -> visibility 0: redelivered immediately so it reaches the DLQ in
 *                       seconds instead of blocking its FIFO group for minutes
 *
 * FIFO batches are processed sequentially (SQS returns at most one in-flight batch per
 * group, in order); standard batches concurrently. A heartbeat extends visibility for
 * handlers that run longer than half the timeout.
 */
export class SqsConsumer implements Worker {
  readonly name: string;
  private readonly logger: Logger;
  private readonly sleeper = new InterruptibleSleep();
  private running = false;
  private loop: Promise<void> | undefined;
  private abort = new AbortController();

  constructor(private readonly options: SqsConsumerOptions) {
    this.name = `consumer:${options.name}`;
    this.logger = new Logger(this.name);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.abort = new AbortController();
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abort.abort();
    this.sleeper.wake();
    await this.loop;
  }

  private async run(): Promise<void> {
    let failures = 0;
    while (this.running) {
      try {
        const queueUrl = await this.options.queueUrl();
        const out = await this.options.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: queueUrl,
            MaxNumberOfMessages: this.options.maxMessages ?? 10,
            WaitTimeSeconds: this.options.waitTimeSeconds ?? 20,
            VisibilityTimeout: this.options.visibilityTimeoutSeconds,
            MessageAttributeNames: ['All'],
            MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
          }),
          { abortSignal: this.abort.signal },
        );
        failures = 0;
        const messages = (out.Messages ?? []).map(toReceived);
        if (this.options.fifo) {
          for (const message of messages) await this.handle(queueUrl, message);
        } else {
          await Promise.all(messages.map((message) => this.handle(queueUrl, message)));
        }
      } catch (error) {
        if (!this.running) break;
        failures += 1;
        const delay = backoffWithJitter(failures, 500, 20_000);
        this.logger.error({ err: error, retryInMs: delay }, 'receive failed');
        await this.sleeper.sleep(delay);
      }
    }
  }

  private async handle(queueUrl: string, message: ReceivedMessage): Promise<void> {
    const heartbeat = this.startHeartbeat(queueUrl, message);
    const parent = propagation.extract(ROOT_CONTEXT, message.attributes);
    const correlationId = message.attributes.correlationId ?? message.messageId;
    try {
      await runWithCorrelation({ correlationId, messageType: message.attributes.type }, () =>
        tracer.startActiveSpan(
          `${this.options.name} process`,
          { kind: SpanKind.CONSUMER, attributes: { 'messaging.message.id': message.messageId } },
          parent,
          async (span) => {
            try {
              await this.options.handler(message);
            } catch (error) {
              span.setStatus({ code: SpanStatusCode.ERROR });
              throw error;
            } finally {
              span.end();
            }
          },
        ),
      );
      clearInterval(heartbeat);
      await this.ack(queueUrl, message);
      this.options.onOutcome?.('processed', message);
    } catch (error) {
      clearInterval(heartbeat);
      const poison = isPoison(error);
      const delay = poison ? 0 : this.retryDelaySeconds(message.receiveCount);
      this.logger[poison ? 'error' : 'warn'](
        {
          err: error,
          messageId: message.messageId,
          receiveCount: message.receiveCount,
          retryInSeconds: delay,
          correlationId,
        },
        poison ? 'poison message, fast-tracking to DLQ' : 'handler failed, will retry',
      );
      this.options.onOutcome?.(poison ? 'poison' : 'retry', message);
      await this.setVisibility(queueUrl, message, delay);
    }
  }

  private retryDelaySeconds(receiveCount: number): number {
    const base = this.options.retryBaseSeconds ?? 2;
    const jittered = backoffWithJitter(receiveCount, base * 1000, MAX_RETRY_DELAY_SECONDS * 1000);
    return Math.max(1, Math.round(jittered / 1000));
  }

  private startHeartbeat(queueUrl: string, message: ReceivedMessage): NodeJS.Timeout {
    const timeout = this.options.visibilityTimeoutSeconds;
    const timer = setInterval(
      () => void this.setVisibility(queueUrl, message, timeout),
      (timeout * 1000) / 2,
    );
    timer.unref();
    return timer;
  }

  private async ack(queueUrl: string, message: ReceivedMessage) {
    try {
      await this.options.sqs.send(
        new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receipts.get(message) }),
      );
    } catch (error) {
      // Not fatal: the message will be redelivered and deduplicated by the inbox.
      this.logger.warn({ err: error, messageId: message.messageId }, 'delete failed');
    } finally {
      receipts.delete(message);
    }
  }

  private async setVisibility(queueUrl: string, message: ReceivedMessage, seconds: number) {
    try {
      await this.options.sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: receipts.get(message),
          VisibilityTimeout: seconds,
        }),
      );
    } catch (error) {
      this.logger.warn({ err: error, messageId: message.messageId }, 'visibility change failed');
    }
  }
}

// Receipt handles are kept out of the handler-facing message object.
const receipts = new WeakMap<ReceivedMessage, string | undefined>();

function toReceived(message: Message): ReceivedMessage {
  const attributes: Record<string, string> = {};
  for (const [key, value] of Object.entries(message.MessageAttributes ?? {})) {
    if (value.StringValue !== undefined) attributes[key] = value.StringValue;
  }
  const received: ReceivedMessage = {
    messageId: message.MessageId ?? 'unknown',
    body: message.Body ?? '',
    attributes,
    receiveCount: Number(message.Attributes?.ApproximateReceiveCount ?? 1),
    groupId: message.Attributes?.MessageGroupId,
  };
  receipts.set(received, message.ReceiptHandle);
  return received;
}

/** Adapts an envelope handler: parse/validation failures become poison messages. */
export function envelopeHandler(
  handler: (envelope: TypedEnvelope, message: ReceivedMessage) => Promise<void>,
): (message: ReceivedMessage) => Promise<void> {
  return async (message) => {
    const envelope = parseEnvelope(message.body);
    await handler(envelope, message);
  };
}

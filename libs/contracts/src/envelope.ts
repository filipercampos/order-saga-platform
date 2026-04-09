import { randomUUID } from 'node:crypto';
import { z } from 'zod';

/**
 * Every message on the bus (command or event) travels in this envelope.
 * `eventId` is the deduplication key for inboxes; `correlationId` is the order id,
 * which is also the saga id and the FIFO message group.
 */
export const envelopeSchema = z.object({
  eventId: z.string().uuid(),
  type: z.string().min(1).max(100),
  schemaVersion: z.literal(1),
  occurredAt: z.string().datetime(),
  producer: z.string().min(1),
  correlationId: z.string().min(1).max(100),
  causationId: z.string().uuid().optional(),
  payload: z.unknown(),
});

export type Envelope<TType extends string = string, TPayload = unknown> = Omit<
  z.infer<typeof envelopeSchema>,
  'type' | 'payload'
> & { type: TType; payload: TPayload };

export interface NewEnvelope<TType extends string, TPayload> {
  type: TType;
  payload: TPayload;
  producer: string;
  correlationId: string;
  causationId?: string;
  now?: Date;
}

export function createEnvelope<TType extends string, TPayload>(
  input: NewEnvelope<TType, TPayload>,
): Envelope<TType, TPayload> {
  return {
    eventId: randomUUID(),
    type: input.type,
    schemaVersion: 1,
    occurredAt: (input.now ?? new Date()).toISOString(),
    producer: input.producer,
    correlationId: input.correlationId,
    causationId: input.causationId,
    payload: input.payload,
  };
}

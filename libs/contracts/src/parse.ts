import { Envelope, envelopeSchema } from './envelope';
import { MessagePayload, MessageType, isMessageType, messageSchemas } from './messages';

export type TypedEnvelope = {
  [T in MessageType]: Envelope<T, MessagePayload<T>>;
}[MessageType];

export class InvalidMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMessageError';
  }
}

/**
 * Parses and validates a raw message body. Anything that fails here can never succeed
 * on retry, so callers treat InvalidMessageError as a poison message.
 */
export function parseEnvelope(body: string): TypedEnvelope {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new InvalidMessageError('body is not valid JSON');
  }
  const envelope = envelopeSchema.safeParse(json);
  if (!envelope.success) {
    throw new InvalidMessageError(`invalid envelope: ${envelope.error.issues[0]?.message ?? ''}`);
  }
  const { type } = envelope.data;
  if (!isMessageType(type)) throw new InvalidMessageError(`unknown message type ${type}`);
  const payload = messageSchemas[type].safeParse(envelope.data.payload);
  if (!payload.success) {
    const issue = payload.error.issues[0];
    throw new InvalidMessageError(`invalid ${type} payload at ${issue?.path.join('.') ?? '?'}`);
  }
  return { ...envelope.data, type, payload: payload.data } as TypedEnvelope;
}

/** Narrows a parsed envelope to one message type. */
export function isType<T extends MessageType>(
  envelope: TypedEnvelope,
  type: T,
): envelope is Extract<TypedEnvelope, { type: T }> {
  return envelope.type === type;
}

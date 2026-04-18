import { AsyncLocalStorage } from 'node:async_hooks';

export interface CorrelationContext {
  /** Order id (= saga id) for messages, request id for HTTP. */
  correlationId: string;
  messageType?: string;
  eventId?: string;
}

const storage = new AsyncLocalStorage<CorrelationContext>();

/** Runs `fn` with a correlation context that the logger mixin adds to every log line. */
export function runWithCorrelation<T>(ctx: CorrelationContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function currentCorrelation(): CorrelationContext | undefined {
  return storage.getStore();
}

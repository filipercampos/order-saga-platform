/**
 * A background loop owned by a service process (outbox relay, queue consumer, saga
 * timeout scanner). Started after the HTTP server is ready, stopped before the
 * database pool is closed.
 */
export interface Worker {
  readonly name: string;
  start(): void;
  stop(): Promise<void>;
}

/** Sleep that can be interrupted by `wake()` so shutdown does not wait for a full poll interval. */
export class InterruptibleSleep {
  private wakeUp: (() => void) | undefined;

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.wakeUp = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  wake(): void {
    this.wakeUp?.();
  }
}

/** Full-jitter exponential backoff (AWS Architecture Blog, "Exponential Backoff and Jitter"). */
export function backoffWithJitter(
  attempt: number,
  baseMs: number,
  capMs: number,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(capMs, baseMs * 2 ** attempt);
  return Math.floor(random() * ceiling);
}

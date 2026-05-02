export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  shouldRetry: (error: unknown, attempt: number) => boolean;
  /** Server-provided delay (Retry-After), used as a floor for the next wait. */
  retryAfterMs?: (error: unknown) => number | undefined;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Retries with exponential backoff and full jitter: delay = random(0, min(cap, base * 2^n)).
 * Full jitter spreads retries from many callers so a recovering dependency is not hit by
 * a synchronized wave.
 */
export async function retry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (attempt >= options.maxAttempts || !options.shouldRetry(error, attempt)) throw error;
      const ceiling = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** (attempt - 1));
      const jittered = Math.floor(random() * ceiling);
      const floor = Math.min(options.retryAfterMs?.(error) ?? 0, options.maxDelayMs);
      const delay = Math.max(jittered, floor);
      options.onRetry?.(error, attempt, delay);
      await sleep(delay);
    }
  }
}

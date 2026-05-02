export type BreakerState = 'closed' | 'open' | 'half_open';

export class CircuitOpenError extends Error {
  constructor(readonly retryInMs: number) {
    super(`circuit open, retry in ${retryInMs} ms`);
    this.name = 'CircuitOpenError';
  }
}

export interface CircuitBreakerOptions {
  /** Consecutive failures that open the circuit. */
  failureThreshold: number;
  /** How long the circuit stays open before a single trial call is allowed. */
  resetTimeoutMs: number;
  now?: () => number;
  onStateChange?: (from: BreakerState, to: BreakerState) => void;
}

/**
 * Consecutive-failure circuit breaker.
 *
 * closed --(N failures)--> open --(reset timeout)--> half_open --(success)--> closed
 *                                                         \--(failure)--> open
 *
 * In half_open exactly one trial call is let through; concurrent callers fail fast.
 * Only failures classified by `isFailure` count: a business decline (HTTP 422) is a
 * healthy dependency saying no, not an outage.
 */
export class CircuitBreaker {
  private current: BreakerState = 'closed';
  private failures = 0;
  private openedAt = 0;
  private trialInFlight = false;
  private readonly now: () => number;

  constructor(private readonly options: CircuitBreakerOptions) {
    this.now = options.now ?? Date.now;
  }

  get state(): BreakerState {
    if (this.current === 'open' && this.now() - this.openedAt >= this.options.resetTimeoutMs) {
      this.transition('half_open');
    }
    return this.current;
  }

  async execute<T>(
    fn: () => Promise<T>,
    isFailure: (error: unknown) => boolean = () => true,
  ): Promise<T> {
    const state = this.state;
    if (state === 'open') {
      throw new CircuitOpenError(this.options.resetTimeoutMs - (this.now() - this.openedAt));
    }
    if (state === 'half_open') {
      if (this.trialInFlight) throw new CircuitOpenError(0);
      this.trialInFlight = true;
    }
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      if (isFailure(error)) this.onFailure();
      else this.onSuccess();
      throw error;
    } finally {
      if (state === 'half_open') this.trialInFlight = false;
    }
  }

  private onSuccess(): void {
    this.failures = 0;
    if (this.current !== 'closed') this.transition('closed');
  }

  private onFailure(): void {
    this.failures += 1;
    if (this.current === 'half_open' || this.failures >= this.options.failureThreshold) {
      this.openedAt = this.now();
      if (this.current !== 'open') this.transition('open');
    }
  }

  private transition(to: BreakerState): void {
    const from = this.current;
    this.current = to;
    this.options.onStateChange?.(from, to);
  }
}

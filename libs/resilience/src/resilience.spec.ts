import { BreakerState, CircuitBreaker, CircuitOpenError } from './circuit-breaker';
import { retry } from './retry';

describe('CircuitBreaker', () => {
  let now = 0;
  const transitions: string[] = [];
  const breaker = () =>
    new CircuitBreaker({
      failureThreshold: 3,
      resetTimeoutMs: 1_000,
      now: () => now,
      onStateChange: (from: BreakerState, to: BreakerState) => transitions.push(`${from}->${to}`),
    });
  const fail = () => Promise.reject(new Error('boom'));

  beforeEach(() => {
    now = 0;
    transitions.length = 0;
  });

  it('opens after consecutive failures and fails fast without calling the dependency', async () => {
    const cb = breaker();
    for (let i = 0; i < 3; i += 1) await expect(cb.execute(fail)).rejects.toThrow('boom');
    expect(cb.state).toBe('open');
    const fn = jest.fn(() => Promise.resolve('ok'));
    await expect(cb.execute(fn)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(fn).not.toHaveBeenCalled();
  });

  it('lets one trial through after the reset timeout and closes on success', async () => {
    const cb = breaker();
    for (let i = 0; i < 3; i += 1) await expect(cb.execute(fail)).rejects.toThrow();
    now = 1_000;
    let release: (v: string) => void = () => undefined;
    const trial = cb.execute(() => new Promise<string>((resolve) => (release = resolve)));
    await expect(cb.execute(() => Promise.resolve('second'))).rejects.toBeInstanceOf(
      CircuitOpenError,
    );
    release('ok');
    await expect(trial).resolves.toBe('ok');
    expect(cb.state).toBe('closed');
    expect(transitions).toEqual(['closed->open', 'open->half_open', 'half_open->closed']);
  });

  it('re-opens when the trial fails', async () => {
    const cb = breaker();
    for (let i = 0; i < 3; i += 1) await expect(cb.execute(fail)).rejects.toThrow();
    now = 1_500;
    await expect(cb.execute(fail)).rejects.toThrow('boom');
    expect(cb.state).toBe('open');
  });

  it('does not count errors classified as non-failures (business declines)', async () => {
    const cb = breaker();
    for (let i = 0; i < 5; i += 1) {
      await expect(cb.execute(fail, () => false)).rejects.toThrow();
    }
    expect(cb.state).toBe('closed');
  });
});

describe('retry', () => {
  it('retries retryable errors with jittered exponential delays, then gives up', async () => {
    const delays: number[] = [];
    const fn = jest.fn(() => Promise.reject(new Error('503')));
    await expect(
      retry(fn, {
        maxAttempts: 4,
        baseDelayMs: 100,
        maxDelayMs: 250,
        shouldRetry: () => true,
        sleep: (ms) => {
          delays.push(ms);
          return Promise.resolve();
        },
        random: () => 0.5,
      }),
    ).rejects.toThrow('503');
    expect(fn).toHaveBeenCalledTimes(4);
    expect(delays).toEqual([50, 100, 125]);
  });

  it('honours Retry-After as a floor and stops on non-retryable errors', async () => {
    const delays: number[] = [];
    let calls = 0;
    const result = await retry(
      () => (++calls === 1 ? Promise.reject(new Error('429')) : Promise.resolve('ok')),
      {
        maxAttempts: 3,
        baseDelayMs: 10,
        maxDelayMs: 5_000,
        shouldRetry: () => true,
        retryAfterMs: () => 1_000,
        sleep: (ms) => {
          delays.push(ms);
          return Promise.resolve();
        },
      },
    );
    expect(result).toBe('ok');
    expect(delays).toEqual([1_000]);

    const fn = jest.fn(() => Promise.reject(new Error('422')));
    await expect(
      retry(fn, { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 1, shouldRetry: () => false }),
    ).rejects.toThrow('422');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

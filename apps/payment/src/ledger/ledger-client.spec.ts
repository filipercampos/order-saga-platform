import { StaticTokenProvider } from '@saga/platform';
import { CircuitBreaker } from '@saga/resilience';
import {
  LedgerClient,
  LedgerDeclinedError,
  LedgerRejectedError,
  LedgerUnavailableError,
} from './ledger-client';

type Reply = { status: number; body?: unknown; headers?: Record<string, string> } | Error;

function stubFetch(replies: Reply[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = jest.fn((url: string, init: RequestInit) => {
    calls.push({ url, init });
    const reply = replies.shift() ?? { status: 500 };
    if (reply instanceof Error) return Promise.reject(reply);
    return Promise.resolve(
      new Response(JSON.stringify(reply.body ?? {}), {
        status: reply.status,
        headers: { 'content-type': 'application/json', ...reply.headers },
      }),
    );
  });
  return { fetchFn: fetchFn as unknown as typeof fetch, calls };
}

function client(
  fetchFn: typeof fetch,
  breaker = new CircuitBreaker({ failureThreshold: 10, resetTimeoutMs: 30_000 }),
) {
  const sleeps: number[] = [];
  const ledger = new LedgerClient({
    baseUrl: 'http://ledger',
    timeoutMs: 100,
    maxAttempts: 3,
    backoffBaseMs: 200,
    backoffCapMs: 2_000,
    breaker,
    tokens: new StaticTokenProvider('m2m-token'),
    fetch: fetchFn,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });
  return { ledger, sleeps };
}

const request = {
  reference: 'order-1',
  entries: [
    { accountId: 'wallet', amount: '-1500', currency: 'BRL' },
    { accountId: 'merchant', amount: '1500', currency: 'BRL' },
  ],
};

describe('LedgerClient', () => {
  it('posts with bearer token and Idempotency-Key', async () => {
    const { fetchFn, calls } = stubFetch([
      { status: 201, body: { id: 'tx-1', reference: 'order-1' } },
    ]);
    await expect(
      client(fetchFn).ledger.postTransaction('charge-1', request),
    ).resolves.toMatchObject({
      id: 'tx-1',
    });
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(calls[0]?.url).toBe('http://ledger/transactions');
    expect(headers).toMatchObject({
      authorization: 'Bearer m2m-token',
      'idempotency-key': 'charge-1',
    });
  });

  it('retries 5xx, timeouts and in-progress conflicts with the same key', async () => {
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    const { fetchFn, calls } = stubFetch([
      { status: 503 },
      timeout,
      { status: 201, body: { id: 'tx-1', reference: 'order-1' } },
    ]);
    const { ledger, sleeps } = client(fetchFn);
    await expect(ledger.postTransaction('charge-1', request)).resolves.toMatchObject({
      id: 'tx-1',
    });
    expect(calls).toHaveLength(3);
    expect(
      new Set(calls.map((c) => (c.init.headers as Record<string, string>)['idempotency-key'])),
    ).toEqual(new Set(['charge-1']));
    expect(sleeps).toHaveLength(2);
    expect(sleeps.every((ms) => ms >= 0 && ms <= 2_000)).toBe(true);
  });

  it('honours Retry-After on 409 request_in_progress', async () => {
    const { fetchFn } = stubFetch([
      { status: 409, body: { type: 'request_in_progress' }, headers: { 'retry-after': '1' } },
      { status: 201, body: { id: 'tx-1', reference: 'order-1' } },
    ]);
    const { ledger, sleeps } = client(fetchFn);
    await ledger.postTransaction('charge-1', request);
    expect(sleeps).toEqual([1_000]);
  });

  it('does not retry a business decline', async () => {
    const { fetchFn, calls } = stubFetch([{ status: 422, body: { type: 'insufficient_funds' } }]);
    await expect(client(fetchFn).ledger.postTransaction('k', request)).rejects.toEqual(
      new LedgerDeclinedError('insufficient_funds'),
    );
    expect(calls).toHaveLength(1);
  });

  it('does not retry other 4xx', async () => {
    const { fetchFn, calls } = stubFetch([{ status: 409, body: { type: 'duplicate_reference' } }]);
    await expect(client(fetchFn).ledger.postTransaction('k', request)).rejects.toBeInstanceOf(
      LedgerRejectedError,
    );
    expect(calls).toHaveLength(1);
  });

  it('gives up with LedgerUnavailableError after the retry budget', async () => {
    const { fetchFn, calls } = stubFetch([{ status: 502 }, { status: 502 }, { status: 502 }]);
    await expect(client(fetchFn).ledger.postTransaction('k', request)).rejects.toBeInstanceOf(
      LedgerUnavailableError,
    );
    expect(calls).toHaveLength(3);
  });

  it('opens the circuit and then fails fast without touching the network', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 30_000 });
    const { fetchFn, calls } = stubFetch([{ status: 503 }, { status: 503 }, { status: 503 }]);
    const { ledger } = client(fetchFn, breaker);
    await expect(ledger.postTransaction('k', request)).rejects.toBeInstanceOf(
      LedgerUnavailableError,
    );
    expect(ledger.breakerState).toBe('open');

    await expect(ledger.postTransaction('k2', request)).rejects.toThrow('ledger circuit open');
    expect(calls).toHaveLength(3);
  });

  it('declines do not open the circuit', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 30_000 });
    const declines: Reply[] = Array.from({ length: 5 }, () => ({
      status: 422,
      body: { type: 'insufficient_funds' },
    }));
    const { fetchFn } = stubFetch(declines);
    const { ledger } = client(fetchFn, breaker);
    for (let i = 0; i < 5; i += 1) {
      await expect(ledger.postTransaction(`k${i}`, request)).rejects.toBeInstanceOf(
        LedgerDeclinedError,
      );
    }
    expect(ledger.breakerState).toBe('closed');
  });
});

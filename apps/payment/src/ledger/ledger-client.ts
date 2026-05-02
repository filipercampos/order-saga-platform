import { Logger } from '@nestjs/common';
import type { TokenProvider } from '@saga/platform';
import { CircuitBreaker, CircuitOpenError, retry } from '@saga/resilience';

/**
 * Client for the ledger-service API (POST /transactions, POST /transactions/:id/reversals,
 * both requiring Idempotency-Key). Every call is safe to repeat: the same key always
 * yields the same transaction, so timeouts and retries can never double-charge.
 */
export interface LedgerEntry {
  accountId: string;
  /** Signed integer minor units as a string. */
  amount: string;
  currency: string;
}

export interface PostTransactionRequest {
  reference: string;
  description?: string;
  metadata?: Record<string, string>;
  entries: LedgerEntry[];
}

export interface LedgerTransaction {
  id: string;
  reference: string;
}

/** The ledger answered and said no (422: insufficient funds, closed account...). */
export class LedgerDeclinedError extends Error {
  constructor(readonly code: string) {
    super(`ledger declined: ${code}`);
    this.name = 'LedgerDeclinedError';
  }
}

/** A 4xx that retrying will not fix (bad request, wrong scope, duplicate reference). */
export class LedgerRejectedError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`ledger rejected request: ${status} ${code}`);
    this.name = 'LedgerRejectedError';
  }
}

/** Transient failure after retries, or circuit open. The caller should try again later. */
export class LedgerUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'LedgerUnavailableError';
  }
}

class RetryableHttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs: number | undefined,
  ) {
    super(`ledger responded ${status}`);
    this.name = 'RetryableHttpError';
  }
}

export interface LedgerClientOptions {
  baseUrl: string;
  /** Per-attempt timeout. */
  timeoutMs: number;
  maxAttempts: number;
  backoffBaseMs: number;
  backoffCapMs: number;
  breaker: CircuitBreaker;
  tokens: TokenProvider;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export class LedgerClient {
  private readonly logger = new Logger(LedgerClient.name);
  private readonly fetchFn: typeof fetch;

  constructor(private readonly options: LedgerClientOptions) {
    this.fetchFn = options.fetch ?? fetch;
  }

  postTransaction(
    idempotencyKey: string,
    body: PostTransactionRequest,
  ): Promise<LedgerTransaction> {
    return this.call('POST', '/transactions', idempotencyKey, body);
  }

  reverseTransaction(idempotencyKey: string, transactionId: string, reason: string) {
    return this.call<LedgerTransaction>(
      'POST',
      `/transactions/${encodeURIComponent(transactionId)}/reversals`,
      idempotencyKey,
      { reason },
    );
  }

  get breakerState() {
    return this.options.breaker.state;
  }

  private async call<T>(method: string, path: string, key: string, body: unknown): Promise<T> {
    try {
      return await retry(
        () =>
          this.options.breaker.execute(() => this.attempt<T>(method, path, key, body), isTransient),
        {
          maxAttempts: this.options.maxAttempts,
          baseDelayMs: this.options.backoffBaseMs,
          maxDelayMs: this.options.backoffCapMs,
          // Circuit open: fail fast, do not burn the retry budget waiting.
          shouldRetry: (error) => isTransient(error),
          retryAfterMs: (error) =>
            error instanceof RetryableHttpError ? error.retryAfterMs : undefined,
          onRetry: (error, attempt, delayMs) =>
            this.logger.warn(
              { err: error, attempt, delayMs, path },
              'ledger call failed, retrying',
            ),
          sleep: this.options.sleep,
        },
      );
    } catch (error) {
      if (error instanceof CircuitOpenError) {
        throw new LedgerUnavailableError('ledger circuit open', { cause: error });
      }
      if (isTransient(error)) {
        throw new LedgerUnavailableError(`ledger unavailable after retries: ${String(error)}`, {
          cause: error,
        });
      }
      throw error;
    }
  }

  private async attempt<T>(method: string, path: string, key: string, body: unknown): Promise<T> {
    const token = await this.options.tokens.token();
    const response = await this.fetchFn(`${this.options.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'idempotency-key': key,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.options.timeoutMs),
    });
    if (response.ok) return (await response.json()) as T;

    const problem = (await response.json().catch(() => ({}))) as { type?: string };
    const code = problem.type ?? `http_${response.status}`;
    if (response.status === 401) {
      // Expired or rotated token: refresh once on the next attempt.
      this.options.tokens.invalidate();
      throw new RetryableHttpError(401, undefined);
    }
    if (
      response.status >= 500 ||
      response.status === 429 ||
      (response.status === 409 && code === 'request_in_progress')
    ) {
      throw new RetryableHttpError(
        response.status,
        retryAfter(response.headers.get('retry-after')),
      );
    }
    if (response.status === 422) throw new LedgerDeclinedError(code);
    throw new LedgerRejectedError(response.status, code);
  }
}

/** Network errors, timeouts and retryable HTTP statuses. Never business answers. */
function isTransient(error: unknown): boolean {
  if (error instanceof RetryableHttpError) return true;
  if (error instanceof LedgerDeclinedError || error instanceof LedgerRejectedError) return false;
  if (error instanceof CircuitOpenError) return false;
  // fetch: TypeError for network failures, TimeoutError/AbortError for the signal.
  return (
    error instanceof TypeError ||
    (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError'))
  );
}

function retryAfter(header: string | null): number | undefined {
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

import { randomUUID } from 'node:crypto';
import { IncomingMessage, Server, ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * In-memory stand-in for ledger-service, implementing the subset of its contract the
 * payment service uses: POST /transactions and POST /transactions/:id/reversals with
 * Idempotency-Key replay, 422 insufficient_funds, 409 request_in_progress semantics.
 * Used by docker compose and the integration tests; failure modes are switchable so
 * tests can drive timeouts and outages.
 */
export type StubMode =
  | { kind: 'ok' }
  | { kind: 'unavailable' } // 503 for everything
  | { kind: 'slow'; delayMs: number }; // commits, then answers after delayMs

interface Posted {
  id: string;
  reference: string;
  entries: { accountId: string; amount: string; currency: string }[];
  reversalOf?: string;
}

interface StoredResponse {
  status: number;
  body: unknown;
}

export class LedgerStub {
  mode: StubMode = { kind: 'ok' };
  readonly transactions: Posted[] = [];
  readonly requests: { method: string; path: string; key?: string }[] = [];
  private readonly balances = new Map<string, bigint>();
  private readonly idempotency = new Map<string, StoredResponse>();
  private server: Server | undefined;

  constructor(private readonly defaultBalance = 0n) {}

  setBalance(accountId: string, minorUnits: bigint): void {
    this.balances.set(accountId, minorUnits);
  }

  balance(accountId: string): bigint {
    return this.balances.get(accountId) ?? this.defaultBalance;
  }

  async listen(port = 0): Promise<string> {
    this.server = createServer((req, res) => void this.route(req, res));
    await new Promise<void>((resolve) => this.server?.listen(port, resolve));
    const { port: actual } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${actual}`;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server?.closeAllConnections();
      this.server?.close(() => resolve());
    });
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = req.url ?? '/';
    const key = req.headers['idempotency-key'];
    const idempotencyKey = typeof key === 'string' ? key : undefined;
    this.requests.push({ method: req.method ?? '', path, key: idempotencyKey });
    const body = await readJson(req);

    if (path === '/health/live') return send(res, 200, { status: 'ok' });
    if (this.mode.kind === 'unavailable') return send(res, 503, { type: 'unavailable' });
    if (!req.headers.authorization?.startsWith('Bearer ')) {
      return send(res, 401, { type: 'missing_token' });
    }
    if (req.method !== 'POST') return send(res, 404, { type: 'not_found' });
    if (!idempotencyKey) return send(res, 400, { type: 'idempotency_key_required' });

    const replay = this.idempotency.get(idempotencyKey);
    const result =
      replay ??
      (path === '/transactions'
        ? this.post(body as Omit<Posted, 'id'>)
        : this.reverse(/^\/transactions\/([^/]+)\/reversals$/.exec(path)?.[1]));
    if (!replay && result.status < 500) this.idempotency.set(idempotencyKey, result);

    if (this.mode.kind === 'slow') {
      await new Promise((resolve) =>
        setTimeout(resolve, (this.mode as { delayMs: number }).delayMs),
      );
    }
    if (!res.destroyed) send(res, result.status, result.body);
  }

  private post(request: Omit<Posted, 'id'>): StoredResponse {
    if (this.transactions.some((t) => t.reference === request.reference)) {
      return { status: 409, body: { type: 'duplicate_reference' } };
    }
    for (const entry of request.entries) {
      const amount = BigInt(entry.amount);
      if (amount < 0n && this.balance(entry.accountId) + amount < 0n) {
        return { status: 422, body: { type: 'insufficient_funds' } };
      }
    }
    return { status: 201, body: this.apply({ ...request, id: randomUUID() }) };
  }

  private reverse(id: string | undefined): StoredResponse {
    const original = this.transactions.find((t) => t.id === id);
    if (!original) return { status: 404, body: { type: 'transaction_not_found' } };
    return {
      status: 201,
      body: this.apply({
        id: randomUUID(),
        reference: `reversal-${original.id}`,
        reversalOf: original.id,
        entries: original.entries.map((e) => ({ ...e, amount: (-BigInt(e.amount)).toString() })),
      }),
    };
  }

  private apply(tx: Posted) {
    for (const entry of tx.entries) {
      this.balances.set(entry.accountId, this.balance(entry.accountId) + BigInt(entry.amount));
    }
    this.transactions.push(tx);
    return { id: tx.id, reference: tx.reference, entries: tx.entries };
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

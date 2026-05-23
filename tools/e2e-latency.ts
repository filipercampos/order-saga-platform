/**
 * Places N orders sequentially against the docker compose stack and measures how long
 * each takes to reach CONFIRMED (write model) and to show up as CONFIRMED in the
 * read model. Polling every POLL_MS, so results have that resolution.
 * Usage: npm run e2e:latency -- [orders=50]
 */
import { randomUUID } from 'node:crypto';

const ORDER_URL = process.env.ORDER_URL ?? 'http://localhost:3101';
const INVENTORY_URL = process.env.INVENTORY_URL ?? 'http://localhost:3102';
const PAYMENT_URL = process.env.PAYMENT_URL ?? 'http://localhost:3103';
const POLL_MS = 25;
const ops = { authorization: 'Bearer svc-ops', 'content-type': 'application/json' };

async function call(
  url: string,
  init: RequestInit = {},
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, init);
  return { status: res.status, body: await res.json().catch(() => undefined) };
}

async function until(fn: () => Promise<boolean>, timeoutMs = 60_000): Promise<number> {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    if (await fn()) return performance.now() - started;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error('timeout');
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? NaN;
}

async function main(): Promise<void> {
  const total = Number(process.argv[2] ?? 50);
  const sku = `SKU-E2E-${randomUUID().slice(0, 6).toUpperCase()}`;
  const customer = `cust-${randomUUID().slice(0, 8)}`;
  await call(`${INVENTORY_URL}/internal/products/${sku}`, {
    method: 'PUT',
    headers: ops,
    body: JSON.stringify({ name: sku, unitPrice: '100', currency: 'BRL', available: total }),
  });
  await call(`${PAYMENT_URL}/internal/wallets/${customer}`, {
    method: 'PUT',
    headers: ops,
    body: JSON.stringify({ ledgerAccountId: `wallet-${customer}` }),
  });
  const user = { authorization: `Bearer ${customer}`, 'content-type': 'application/json' };

  const confirmMs: number[] = [];
  const projectedMs: number[] = [];
  for (let i = 0; i < total; i += 1) {
    const started = performance.now();
    const placed = await call(`${ORDER_URL}/orders`, {
      method: 'POST',
      headers: { ...user, 'idempotency-key': `e2e-${randomUUID()}` },
      body: JSON.stringify({ items: [{ sku, quantity: 1 }] }),
    });
    const { orderId } = placed.body as { orderId: string };
    await until(async () => {
      const { body } = await call(`${ORDER_URL}/orders/${orderId}`, { headers: user });
      const status = (body as { status?: string }).status;
      if (status === 'CANCELLED' || status === 'FAILED')
        throw new Error(`order ${orderId} ${status}`);
      return status === 'CONFIRMED';
    });
    confirmMs.push(performance.now() - started);
    await until(async () => {
      const { status, body } = await call(`${ORDER_URL}/orders/${orderId}/history`, {
        headers: user,
      });
      return status === 200 && (body as { status?: string }).status === 'CONFIRMED';
    });
    projectedMs.push(performance.now() - started);
  }

  const summary = (values: number[]) => ({
    p50: Math.round(percentile(values, 50)),
    p95: Math.round(percentile(values, 95)),
    max: Math.round(Math.max(...values)),
  });
  console.log(
    JSON.stringify(
      {
        orders: total,
        pollMs: POLL_MS,
        placeToConfirmedMs: summary(confirmMs),
        placeToReadModelConfirmedMs: summary(projectedMs),
      },
      null,
      2,
    ),
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

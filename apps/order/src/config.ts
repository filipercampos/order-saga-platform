import { parseEnv } from '@saga/platform';
import { z } from 'zod';

export const orderEnvShape = {
  /** Deadlines per waiting state (ADR 0006 explains the numbers). */
  SAGA_RESERVE_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  SAGA_CHARGE_TIMEOUT_MS: z.coerce.number().int().positive().default(90_000),
  SAGA_COMPENSATION_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  SAGA_MAX_COMPENSATION_ATTEMPTS: z.coerce.number().int().positive().default(8),
  SAGA_SCAN_INTERVAL_MS: z.coerce.number().int().positive().default(1_000),
};

export type OrderEnv = ReturnType<typeof loadOrderEnv>;

export function loadOrderEnv(source: NodeJS.ProcessEnv = process.env) {
  return parseEnv(orderEnvShape, source);
}

export const ORDER_ENV = Symbol('ORDER_ENV');

export const OrderScopes = {
  read: 'orders/read',
  write: 'orders/write',
  admin: 'orders/admin',
} as const;

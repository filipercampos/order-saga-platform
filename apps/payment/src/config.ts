import { csv, parseEnv } from '@saga/platform';
import { z } from 'zod';

export const paymentEnvShape = {
  LEDGER_BASE_URL: z.string().url(),
  LEDGER_MERCHANT_ACCOUNT_ID: z.string().min(1),
  /** Per attempt. 3 attempts x 2 s + backoff stays well inside the 60 s visibility timeout. */
  LEDGER_TIMEOUT_MS: z.coerce.number().int().positive().default(2_000),
  LEDGER_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
  LEDGER_BACKOFF_BASE_MS: z.coerce.number().int().positive().default(200),
  LEDGER_BACKOFF_CAP_MS: z.coerce.number().int().positive().default(2_000),
  LEDGER_BREAKER_THRESHOLD: z.coerce.number().int().positive().default(5),
  LEDGER_BREAKER_RESET_MS: z.coerce.number().int().positive().default(30_000),
  LEDGER_AUTH_MODE: z.enum(['client_credentials', 'static']).default('client_credentials'),
  LEDGER_TOKEN_URL: z.string().url().optional(),
  LEDGER_CLIENT_ID: z.string().optional(),
  LEDGER_CLIENT_SECRET: z.string().optional(),
  LEDGER_SCOPES: csv.default('ledger/write,ledger/admin'),
  LEDGER_STATIC_TOKEN: z.string().default('dev'),
};

export type PaymentEnv = ReturnType<typeof loadPaymentEnv>;

export function loadPaymentEnv(source: NodeJS.ProcessEnv = process.env) {
  const env = parseEnv(paymentEnvShape, source);
  if (
    env.LEDGER_AUTH_MODE === 'client_credentials' &&
    !(env.LEDGER_TOKEN_URL && env.LEDGER_CLIENT_ID && env.LEDGER_CLIENT_SECRET)
  ) {
    throw new Error(
      'Invalid environment configuration: LEDGER_TOKEN_URL, LEDGER_CLIENT_ID and LEDGER_CLIENT_SECRET are required for client_credentials',
    );
  }
  return env;
}

export const PAYMENT_ENV = Symbol('PAYMENT_ENV');
export const LEDGER_CLIENT = Symbol('LEDGER_CLIENT');
export const PaymentScopes = { admin: 'payment/admin' } as const;

import { z } from 'zod';

export const csv = z
  .string()
  .default('')
  .transform((value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );

export const bool = (fallback: boolean) =>
  z
    .enum(['true', 'false'])
    .default(fallback ? 'true' : 'false')
    .transform((value) => value === 'true');

/** Settings every service has. Each service extends this shape with its own keys. */
export const baseEnvShape = {
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(0).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** Human-readable logs for local runs (needs the pino-pretty dev dependency). */
  LOG_PRETTY: bool(false),
  DATABASE_URL: z.string().url(),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  MIGRATE_ON_START: bool(false),
  AWS_REGION: z.string().default('us-east-1'),
  AWS_ENDPOINT_URL: z.string().url().optional(),
  AWS_ACCOUNT_ID: z
    .string()
    .regex(/^\d{12}$/)
    .default('000000000000'),
  MESSAGING_NAMESPACE: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .default('saga-local'),
  SQS_WAIT_TIME_SECONDS: z.coerce.number().int().min(0).max(20).default(20),
  SQS_RETRY_BASE_SECONDS: z.coerce.number().int().min(0).default(2),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(200),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().positive().max(500).default(50),
  OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().positive().default(20),
  METRICS_ENABLED: bool(true),
  AUTH_MODE: z.enum(['cognito', 'disabled']).default('cognito'),
  COGNITO_USER_POOL_ID: z.string().optional(),
  COGNITO_CLIENT_IDS: csv,
};

export type BaseEnv = z.infer<z.ZodObject<typeof baseEnvShape>>;

/**
 * In EKS the database secret is injected (External Secrets) as DB_HOST / DB_USERNAME /
 * DB_PASSWORD / DB_NAME; locally a single DATABASE_URL is simpler.
 */
function withDatabaseUrl(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (source.DATABASE_URL || !source.DB_HOST) return source;
  const user = encodeURIComponent(source.DB_USERNAME ?? '');
  const password = encodeURIComponent(source.DB_PASSWORD ?? '');
  return {
    ...source,
    DATABASE_URL: `postgres://${user}:${password}@${source.DB_HOST}:5432/${source.DB_NAME ?? ''}?sslmode=require`,
  };
}

export function parseEnv<S extends z.ZodRawShape>(
  shape: S,
  source: NodeJS.ProcessEnv,
): z.infer<z.ZodObject<typeof baseEnvShape & S>> {
  const schema = z.object({ ...baseEnvShape, ...shape });
  const parsed = schema.safeParse(withDatabaseUrl(source));
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  const env = parsed.data as z.infer<z.ZodObject<typeof baseEnvShape & S>>;
  assertAuthSettings(env as BaseEnv);
  return env;
}

function assertAuthSettings(env: BaseEnv): void {
  if (env.AUTH_MODE === 'cognito' && !env.COGNITO_USER_POOL_ID) {
    throw new Error(
      'Invalid environment configuration: COGNITO_USER_POOL_ID required when AUTH_MODE=cognito',
    );
  }
  if (env.NODE_ENV === 'production' && env.AUTH_MODE === 'disabled') {
    throw new Error(
      'Invalid environment configuration: AUTH_MODE cannot be disabled in production',
    );
  }
}

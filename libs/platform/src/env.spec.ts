import { z } from 'zod';
import { parseEnv } from './env';

describe('parseEnv', () => {
  const base = { DATABASE_URL: 'postgres://u:p@localhost:5433/orders', AUTH_MODE: 'disabled' };

  it('merges the base shape with service-specific keys', () => {
    const env = parseEnv({ EXTRA: z.coerce.number().default(7) }, base);
    expect(env).toMatchObject({ PORT: 3000, EXTRA: 7, MIGRATE_ON_START: false });
  });

  it('builds DATABASE_URL from injected secret fields', () => {
    const env = parseEnv(
      {},
      {
        DB_HOST: 'db',
        DB_USERNAME: 'order_svc',
        DB_PASSWORD: 'p@ss',
        DB_NAME: 'orders',
        AUTH_MODE: 'disabled',
      },
    );
    expect(env.DATABASE_URL).toBe('postgres://order_svc:p%40ss@db:5432/orders?sslmode=require');
  });

  it('refuses disabled auth in production and cognito without a pool', () => {
    expect(() => parseEnv({}, { ...base, NODE_ENV: 'production' })).toThrow('AUTH_MODE');
    expect(() => parseEnv({}, { ...base, AUTH_MODE: 'cognito' })).toThrow('COGNITO_USER_POOL_ID');
  });
});

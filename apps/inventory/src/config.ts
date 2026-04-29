import { parseEnv } from '@saga/platform';

export type InventoryEnv = ReturnType<typeof loadInventoryEnv>;

export function loadInventoryEnv(source: NodeJS.ProcessEnv = process.env) {
  return parseEnv({}, source);
}

export const InventoryScopes = { admin: 'inventory/admin' } as const;

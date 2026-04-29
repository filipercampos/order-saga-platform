import type { PricedLine } from '@saga/contracts';
import type { ColumnType, Generated, JSONColumnType } from 'kysely';

export interface ProductsTable {
  sku: string;
  name: string;
  unit_price: ColumnType<string, string, string>;
  currency: string;
  available: number;
  reserved: number;
  updated_at: Generated<Date>;
}

export type ReservationStatus = 'RESERVED' | 'COMMITTED' | 'RELEASED' | 'REJECTED';

export interface ReservationsTable {
  order_id: string;
  status: ReservationStatus;
  lines: JSONColumnType<PricedLine[], string, string>;
  total: ColumnType<string, string, string>;
  currency: string | null;
  reason: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface InventoryDatabase {
  products: ProductsTable;
  reservations: ReservationsTable;
}

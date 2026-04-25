import type { LineItem } from '@saga/contracts';
import type { ColumnType, Generated, JSONColumnType } from 'kysely';
import type { OrderStatus, SagaState } from '../saga/saga-machine';

export interface OrdersTable {
  id: string;
  customer_id: string;
  status: OrderStatus;
  items: JSONColumnType<LineItem[], string, string>;
  /** Integer minor units; null until inventory prices the reservation. */
  total_minor: ColumnType<string | null, string | null, string | null>;
  currency: string | null;
  cancel_reason: string | null;
  idempotency_key: string;
  request_hash: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface SagasTable {
  order_id: string;
  state: SagaState;
  version: number;
  attempts: number;
  deadline_at: Date | null;
  resume_state: SagaState | null;
  started_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface SagaTransitionsTable {
  id: Generated<string>;
  order_id: string;
  from_state: string | null;
  to_state: string;
  trigger: string;
  event_id: string | null;
  at: Generated<Date>;
}

export interface OrderDatabase {
  orders: OrdersTable;
  sagas: SagasTable;
  saga_transitions: SagaTransitionsTable;
}

import type { ColumnType, Generated } from 'kysely';

export interface WalletsTable {
  customer_id: string;
  ledger_account_id: string;
  created_at: Generated<Date>;
}

/**
 * CHARGING  - charge requested, ledger outcome not yet recorded (may be unknown)
 * CHARGED   - ledger transaction posted
 * DECLINED  - ledger said no; nothing to refund
 * REFUNDED  - charge reversed in the ledger
 * CANCELLED - refund arrived before any charge: tombstone, later charges are declined
 */
export type PaymentStatus = 'CHARGING' | 'CHARGED' | 'DECLINED' | 'REFUNDED' | 'CANCELLED';

export interface PaymentsTable {
  order_id: string;
  customer_id: string | null;
  status: PaymentStatus;
  amount: ColumnType<string, string, string>;
  currency: string | null;
  ledger_account_id: string | null;
  ledger_transaction_id: string | null;
  reversal_transaction_id: string | null;
  decline_reason: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface PaymentDatabase {
  wallets: WalletsTable;
  payments: PaymentsTable;
}

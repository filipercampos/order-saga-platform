import { z } from 'zod';

const orderId = z.string().uuid();
/** Amounts are integer minor units as strings (64-bit safe in JSON), like the ledger API. */
const minorUnits = z.string().regex(/^\d{1,18}$/);
const currency = z.string().regex(/^[A-Z]{3}$/);
const lineItem = z.object({
  sku: z.string().min(1).max(64),
  quantity: z.number().int().positive(),
});
const pricedLine = lineItem.extend({ unitPrice: minorUnits });

/**
 * Message catalogue. Names are `<owner>.<Name>`; the owner prefix is the service that
 * owns the schema (the receiver for commands, the producer for events).
 */
export const messageSchemas = {
  // ----- commands: order (orchestrator) -> participants, FIFO per order -----
  'inventory.ReserveStock': z.object({ orderId, items: z.array(lineItem).min(1).max(50) }),
  'inventory.ReleaseStock': z.object({ orderId, reason: z.string().max(100) }),
  'inventory.CommitStock': z.object({ orderId }),
  'payment.ChargePayment': z.object({
    orderId,
    customerId: z.string(),
    amount: minorUnits,
    currency,
  }),
  'payment.RefundPayment': z.object({ orderId, reason: z.string().max(100) }),

  // ----- inventory replies -----
  'inventory.StockReserved': z.object({
    orderId,
    lines: z.array(pricedLine),
    total: minorUnits,
    currency,
  }),
  'inventory.StockReservationRejected': z.object({
    orderId,
    reason: z.enum(['out_of_stock', 'unknown_sku', 'already_released', 'currency_mismatch']),
    sku: z.string().optional(),
  }),
  'inventory.StockReleased': z.object({ orderId, restocked: z.boolean() }),

  // ----- payment replies -----
  'payment.PaymentCharged': z.object({
    orderId,
    ledgerTransactionId: z.string(),
    amount: minorUnits,
    currency,
  }),
  'payment.PaymentDeclined': z.object({ orderId, reason: z.string().max(100) }),
  'payment.PaymentRefunded': z.object({
    orderId,
    refunded: z.boolean(),
    reversalTransactionId: z.string().optional(),
  }),

  // ----- order domain events (read model, notifications) -----
  'order.OrderPlaced': z.object({
    orderId,
    customerId: z.string(),
    items: z.array(lineItem),
    orderVersion: z.number().int(),
    placedAt: z.string().datetime(),
  }),
  'order.OrderStatusChanged': z.object({
    orderId,
    customerId: z.string(),
    status: z.enum(['PENDING', 'CONFIRMED', 'CANCELLING', 'CANCELLED', 'FAILED']),
    sagaState: z.string(),
    orderVersion: z.number().int(),
    total: minorUnits.optional(),
    currency: currency.optional(),
    reason: z.string().optional(),
  }),
  'order.OrderConfirmed': z.object({
    orderId,
    customerId: z.string(),
    total: minorUnits,
    currency,
    orderVersion: z.number().int(),
  }),
  'order.OrderCancelled': z.object({
    orderId,
    customerId: z.string(),
    reason: z.string(),
    orderVersion: z.number().int(),
  }),
} as const;

export type MessageType = keyof typeof messageSchemas;
export type MessagePayload<T extends MessageType> = z.infer<(typeof messageSchemas)[T]>;

export function isMessageType(type: string): type is MessageType {
  return Object.prototype.hasOwnProperty.call(messageSchemas, type);
}

export type LineItem = z.infer<typeof lineItem>;
export type PricedLine = z.infer<typeof pricedLine>;

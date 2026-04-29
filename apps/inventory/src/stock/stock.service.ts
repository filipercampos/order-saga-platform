import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  Envelope,
  LineItem,
  MessagePayload,
  MessageType,
  PricedLine,
  ServiceName,
  TypedEnvelope,
  createEnvelope,
} from '@saga/contracts';
import { PoisonMessageError, Topics } from '@saga/messaging';
import { PendingMessage, enqueue, processOnce } from '@saga/outbox';
import { DATABASE } from '@saga/platform';
import { Kysely, Transaction, sql } from 'kysely';
import type { InventoryDatabase } from '../database/schema';

type Trx = Transaction<InventoryDatabase>;
type Command<T extends MessageType> = Envelope<T, MessagePayload<T>>;

export const INVENTORY_INBOX = 'inventory-commands';

/**
 * Stock reservations driven by saga commands. Every handler runs inside the inbox
 * transaction, so the stock change, the reservation row and the reply (outbox) commit
 * together, exactly once per command.
 */
@Injectable()
export class StockService {
  private readonly logger = new Logger(StockService.name);

  constructor(@Inject(DATABASE) private readonly db: Kysely<InventoryDatabase>) {}

  async handle(command: TypedEnvelope): Promise<'processed' | 'duplicate'> {
    const outcome = await processOnce(
      this.db,
      { consumer: INVENTORY_INBOX, eventId: command.eventId, messageType: command.type },
      async (trx) => {
        switch (command.type) {
          case 'inventory.ReserveStock':
            return this.reserve(trx, command);
          case 'inventory.ReleaseStock':
            return this.release(trx, command);
          case 'inventory.CommitStock':
            return this.commit(trx, command);
          default:
            // Misrouted message: retrying will never help.
            throw new PoisonMessageError(`inventory cannot handle ${command.type}`);
        }
      },
    );
    return outcome.duplicate ? 'duplicate' : 'processed';
  }

  private async reserve(trx: Trx, command: Command<'inventory.ReserveStock'>) {
    const { orderId, items } = command.payload;
    const existing = await this.reservation(trx, orderId);
    if (existing) {
      // Re-reply with the original outcome; never reserve twice for one order.
      if (existing.status === 'RESERVED' || existing.status === 'COMMITTED') {
        return this.reply(trx, command, 'inventory.StockReserved', {
          orderId,
          lines: existing.lines,
          total: existing.total,
          currency: existing.currency ?? 'XXX',
        });
      }
      return this.reject(
        trx,
        command,
        existing.status === 'RELEASED' ? 'already_released' : 'out_of_stock',
      );
    }

    // Lock rows in a deterministic order: concurrent orders for overlapping SKUs
    // cannot deadlock.
    const skus = [...items.map((item) => item.sku)].sort();
    const products = await trx
      .selectFrom('products')
      .selectAll()
      .where('sku', 'in', skus)
      .orderBy('sku')
      .forUpdate()
      .execute();
    const bySku = new Map(products.map((p) => [p.sku, p]));

    const lines: PricedLine[] = [];
    const currencies = new Set<string>();
    for (const item of items) {
      const product = bySku.get(item.sku);
      if (!product) return this.reject(trx, command, 'unknown_sku', item.sku);
      if (product.available < item.quantity) {
        return this.reject(trx, command, 'out_of_stock', item.sku);
      }
      currencies.add(product.currency);
      lines.push({ ...item, unitPrice: product.unit_price });
    }
    if (currencies.size !== 1) return this.reject(trx, command, 'currency_mismatch');

    for (const item of items) {
      await trx
        .updateTable('products')
        .set({
          available: sql`available - ${item.quantity}`,
          reserved: sql`reserved + ${item.quantity}`,
          updated_at: sql`now()`,
        })
        .where('sku', '=', item.sku)
        .execute();
    }
    const total = lines
      .reduce((sum, line) => sum + BigInt(line.unitPrice) * BigInt(line.quantity), 0n)
      .toString();
    const currency = [...currencies][0] ?? 'XXX';
    await trx
      .insertInto('reservations')
      .values({
        order_id: orderId,
        status: 'RESERVED',
        lines: JSON.stringify(lines),
        total,
        currency,
        reason: null,
      })
      .execute();
    return this.reply(trx, command, 'inventory.StockReserved', { orderId, lines, total, currency });
  }

  private async release(trx: Trx, command: Command<'inventory.ReleaseStock'>) {
    const { orderId, reason } = command.payload;
    const existing = await this.reservation(trx, orderId);
    if (!existing) {
      // Release overtook (or replaced) the reserve: leave a tombstone.
      await trx
        .insertInto('reservations')
        .values({
          order_id: orderId,
          status: 'RELEASED',
          lines: '[]',
          total: '0',
          currency: null,
          reason,
        })
        .execute();
      this.logger.warn({ orderId }, 'release before reserve, tombstone written');
      return this.reply(trx, command, 'inventory.StockReleased', { orderId, restocked: false });
    }
    if (existing.status === 'COMMITTED') {
      this.logger.error({ orderId }, 'release requested for committed stock, ignoring');
      return this.reply(trx, command, 'inventory.StockReleased', { orderId, restocked: false });
    }
    if (existing.status !== 'RESERVED') {
      return this.reply(trx, command, 'inventory.StockReleased', { orderId, restocked: false });
    }
    await this.moveStock(trx, existing.lines, 'release');
    await this.setStatus(trx, orderId, 'RELEASED', reason);
    return this.reply(trx, command, 'inventory.StockReleased', { orderId, restocked: true });
  }

  private async commit(trx: Trx, command: Command<'inventory.CommitStock'>) {
    const existing = await this.reservation(trx, command.payload.orderId);
    if (existing?.status !== 'RESERVED') {
      this.logger.warn(
        { orderId: command.payload.orderId, status: existing?.status },
        'nothing to commit',
      );
      return;
    }
    await this.moveStock(trx, existing.lines, 'commit');
    await this.setStatus(trx, command.payload.orderId, 'COMMITTED', null);
  }

  private async moveStock(trx: Trx, lines: LineItem[], mode: 'release' | 'commit') {
    for (const line of [...lines].sort((a, b) => a.sku.localeCompare(b.sku))) {
      await trx
        .updateTable('products')
        .set({
          reserved: sql`reserved - ${line.quantity}`,
          ...(mode === 'release' ? { available: sql`available + ${line.quantity}` } : {}),
          updated_at: sql`now()`,
        })
        .where('sku', '=', line.sku)
        .execute();
    }
  }

  private reservation(trx: Trx, orderId: string) {
    return trx
      .selectFrom('reservations')
      .selectAll()
      .where('order_id', '=', orderId)
      .forUpdate()
      .executeTakeFirst();
  }

  private async setStatus(
    trx: Trx,
    orderId: string,
    status: 'RELEASED' | 'COMMITTED',
    reason: string | null,
  ) {
    await trx
      .updateTable('reservations')
      .set({ status, reason, updated_at: sql`now()` })
      .where('order_id', '=', orderId)
      .execute();
  }

  private async reject(
    trx: Trx,
    command: Command<'inventory.ReserveStock'>,
    reason: MessagePayload<'inventory.StockReservationRejected'>['reason'],
    sku?: string,
  ) {
    const { orderId } = command.payload;
    await trx
      .insertInto('reservations')
      .values({
        order_id: orderId,
        status: 'REJECTED',
        lines: '[]',
        total: '0',
        currency: null,
        reason,
      })
      .onConflict((oc) => oc.column('order_id').doNothing())
      .execute();
    return this.reply(trx, command, 'inventory.StockReservationRejected', { orderId, reason, sku });
  }

  private async reply<T extends MessageType>(
    trx: Trx,
    command: TypedEnvelope,
    type: T,
    payload: MessagePayload<T>,
  ): Promise<void> {
    const message: PendingMessage = {
      topic: Topics.inventoryEvents,
      envelope: createEnvelope({
        type,
        payload,
        producer: ServiceName.inventory,
        correlationId: command.correlationId,
        causationId: command.eventId,
      }),
    };
    await enqueue(trx, [message]);
  }
}

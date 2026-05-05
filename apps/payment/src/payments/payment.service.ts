import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  Envelope,
  MessagePayload,
  MessageType,
  ServiceName,
  TypedEnvelope,
  createEnvelope,
} from '@saga/contracts';
import { PoisonMessageError, Topics } from '@saga/messaging';
import { METRICS, Metrics } from '@saga/observability';
import { enqueue, isProcessed, processOnce } from '@saga/outbox';
import { DATABASE } from '@saga/platform';
import { Kysely, Selectable, Transaction, sql } from 'kysely';
import { LEDGER_CLIENT, PAYMENT_ENV, PaymentEnv } from '../config';
import type { PaymentDatabase, PaymentStatus, PaymentsTable } from '../database/schema';
import {
  LedgerClient,
  LedgerDeclinedError,
  LedgerRejectedError,
  LedgerTransaction,
} from '../ledger/ledger-client';

type Trx = Transaction<PaymentDatabase>;
type Command<T extends MessageType> = Envelope<T, MessagePayload<T>>;
type PaymentRow = Omit<Selectable<PaymentsTable>, 'created_at' | 'updated_at'>;

export const PAYMENT_INBOX = 'payment-commands';

type ChargeOutcome =
  | { kind: 'charged'; tx: LedgerTransaction }
  | { kind: 'declined'; reason: string };

/**
 * Charges and refunds through the external ledger.
 *
 * The ledger call cannot be part of a database transaction, so each command runs in
 * three steps: (1) record intent (short transaction), (2) call the ledger with a
 * deterministic Idempotency-Key (`charge-<orderId>`, `refund-<orderId>`), (3) record the
 * outcome + inbox row + reply in one transaction. A crash or a redelivery between steps
 * repeats step 2 with the same key, which the ledger answers from its idempotency store:
 * exactly one money movement per order, however many times the command is delivered.
 * Transient ledger failures are thrown, so SQS redelivers with backoff.
 */
@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Kysely<PaymentDatabase>,
    @Inject(LEDGER_CLIENT) private readonly ledger: LedgerClient,
    @Inject(PAYMENT_ENV) private readonly env: PaymentEnv,
    @Inject(METRICS) private readonly metrics: Metrics,
  ) {}

  async handle(command: TypedEnvelope): Promise<string> {
    if (await this.alreadyProcessed(command.eventId)) return 'duplicate';
    switch (command.type) {
      case 'payment.ChargePayment':
        return this.charge(command);
      case 'payment.RefundPayment':
        return this.refund(command);
      default:
        throw new PoisonMessageError(`payment cannot handle ${command.type}`);
    }
  }

  private async charge(command: Command<'payment.ChargePayment'>): Promise<string> {
    const { orderId, customerId, amount, currency } = command.payload;
    const payment = await this.db.transaction().execute(async (trx) => {
      const wallet = await trx
        .selectFrom('wallets')
        .select('ledger_account_id')
        .where('customer_id', '=', customerId)
        .executeTakeFirst();
      await trx
        .insertInto('payments')
        .values({
          order_id: orderId,
          customer_id: customerId,
          status: 'CHARGING',
          amount,
          currency,
          ledger_account_id: wallet?.ledger_account_id ?? null,
          ledger_transaction_id: null,
          reversal_transaction_id: null,
          decline_reason: null,
        })
        .onConflict((oc) => oc.column('order_id').doNothing())
        .execute();
      return this.lock(trx, orderId);
    });

    if (payment.status === 'CANCELLED') {
      // The refund overtook the charge (or replaced it after a DLQ): never charge now.
      return this.finish(
        command,
        orderId,
        'CANCELLED',
        {},
        'payment.PaymentDeclined',
        {
          orderId,
          reason: 'order_cancelled',
        },
        ['CANCELLED'],
      );
    }
    if (payment.status !== 'CHARGING') return this.reReply(command, payment);
    if (!payment.ledger_account_id) {
      return this.finish(
        command,
        orderId,
        'DECLINED',
        { decline_reason: 'no_wallet' },
        'payment.PaymentDeclined',
        {
          orderId,
          reason: 'no_wallet',
        },
      );
    }

    const outcome = await this.postCharge(payment);
    if (outcome.kind === 'declined') {
      this.metrics.count('PaymentDeclined', 1, { Reason: outcome.reason });
      return this.finish(
        command,
        orderId,
        'DECLINED',
        { decline_reason: outcome.reason },
        'payment.PaymentDeclined',
        {
          orderId,
          reason: outcome.reason,
        },
      );
    }
    this.metrics.count('PaymentCharged');
    return this.finish(
      command,
      orderId,
      'CHARGED',
      { ledger_transaction_id: outcome.tx.id },
      'payment.PaymentCharged',
      { orderId, ledgerTransactionId: outcome.tx.id, amount, currency },
    );
  }

  private async refund(command: Command<'payment.RefundPayment'>): Promise<string> {
    const { orderId, reason } = command.payload;
    const payment = await this.db.transaction().execute(async (trx) => {
      // No charge seen yet: leave a tombstone so a late charge is declined.
      await trx
        .insertInto('payments')
        .values({
          order_id: orderId,
          customer_id: null,
          status: 'CANCELLED',
          amount: '0',
          currency: null,
          ledger_account_id: null,
          ledger_transaction_id: null,
          reversal_transaction_id: null,
          decline_reason: reason,
        })
        .onConflict((oc) => oc.column('order_id').doNothing())
        .execute();
      return this.lock(trx, orderId);
    });

    const notCharged = () =>
      this.finish(
        command,
        orderId,
        'CANCELLED',
        {},
        'payment.PaymentRefunded',
        { orderId, refunded: false },
        ['CANCELLED', 'DECLINED', 'CHARGING'],
      );

    switch (payment.status) {
      case 'CANCELLED':
      case 'DECLINED':
        return notCharged();
      case 'REFUNDED':
        return this.reReply(command, payment);
      case 'CHARGING': {
        // Outcome of the charge is unknown (timed out, dead-lettered). Replaying the
        // charge with the same Idempotency-Key returns the original result if it was
        // posted, or posts it now; either way we then know what to reverse.
        if (!payment.ledger_account_id) return notCharged();
        const outcome = await this.postCharge(payment);
        if (outcome.kind === 'declined') return notCharged();
        return this.reverse(command, { ...payment, ledger_transaction_id: outcome.tx.id }, reason);
      }
      case 'CHARGED':
        return this.reverse(command, payment, reason);
    }
  }

  private async reverse(
    command: TypedEnvelope,
    payment: PaymentRow,
    reason: string,
  ): Promise<string> {
    const txId = payment.ledger_transaction_id;
    if (!txId) throw new Error(`payment ${payment.order_id} has no ledger transaction`);
    let reversal: LedgerTransaction;
    try {
      reversal = await this.ledger.reverseTransaction(`refund-${payment.order_id}`, txId, reason);
    } catch (error) {
      if (error instanceof LedgerDeclinedError || error instanceof LedgerRejectedError) {
        // A refund the ledger refuses needs a human (runbook: refund rejected).
        throw new PoisonMessageError(`ledger refused reversal of ${txId}: ${error.message}`);
      }
      throw error;
    }
    this.metrics.count('PaymentRefunded');
    return this.finish(
      command,
      payment.order_id,
      'REFUNDED',
      { ledger_transaction_id: txId, reversal_transaction_id: reversal.id },
      'payment.PaymentRefunded',
      { orderId: payment.order_id, refunded: true, reversalTransactionId: reversal.id },
      ['CHARGING', 'CHARGED'],
    );
  }

  private async postCharge(payment: PaymentRow): Promise<ChargeOutcome> {
    try {
      const tx = await this.ledger.postTransaction(`charge-${payment.order_id}`, {
        reference: `order-${payment.order_id}`,
        description: `Order ${payment.order_id}`,
        metadata: { orderId: payment.order_id },
        entries: [
          {
            accountId: payment.ledger_account_id ?? '',
            amount: `-${payment.amount}`,
            currency: payment.currency ?? '',
          },
          {
            accountId: this.env.LEDGER_MERCHANT_ACCOUNT_ID,
            amount: payment.amount,
            currency: payment.currency ?? '',
          },
        ],
      });
      return { kind: 'charged', tx };
    } catch (error) {
      if (error instanceof LedgerDeclinedError) return { kind: 'declined', reason: error.code };
      if (error instanceof LedgerRejectedError) {
        this.logger.error({ err: error, orderId: payment.order_id }, 'ledger rejected charge');
        return { kind: 'declined', reason: `ledger_${error.code}` };
      }
      throw error; // LedgerUnavailableError and anything unexpected: redeliver later
    }
  }

  /** Step 3: outcome + inbox + reply, atomically. */
  private async finish<T extends MessageType>(
    command: TypedEnvelope,
    orderId: string,
    status: PaymentStatus,
    patch: Partial<
      Pick<PaymentRow, 'ledger_transaction_id' | 'reversal_transaction_id' | 'decline_reason'>
    >,
    replyType: T,
    reply: MessagePayload<T>,
    fromStatuses: PaymentStatus[] = ['CHARGING'],
  ): Promise<string> {
    const outcome = await processOnce(
      this.db,
      { consumer: PAYMENT_INBOX, eventId: command.eventId, messageType: command.type },
      async (trx) => {
        await trx
          .updateTable('payments')
          .set({ status, ...patch, updated_at: sql`now()` })
          .where('order_id', '=', orderId)
          .where('status', 'in', fromStatuses)
          .execute();
        await this.reply(trx, command, replyType, reply);
      },
    );
    return outcome.duplicate ? 'duplicate' : status.toLowerCase();
  }

  /** The command was already applied (e.g. a re-sent command): answer with the recorded outcome. */
  private reReply(command: TypedEnvelope, payment: PaymentRow): Promise<string> {
    const orderId = payment.order_id;
    switch (payment.status) {
      case 'CHARGED':
        return this.finish(
          command,
          orderId,
          'CHARGED',
          {},
          'payment.PaymentCharged',
          {
            orderId,
            ledgerTransactionId: payment.ledger_transaction_id ?? '',
            amount: payment.amount,
            currency: payment.currency ?? 'XXX',
          },
          ['CHARGED'],
        );
      case 'REFUNDED':
        return this.finish(
          command,
          orderId,
          'REFUNDED',
          {},
          'payment.PaymentRefunded',
          {
            orderId,
            refunded: true,
            reversalTransactionId: payment.reversal_transaction_id ?? undefined,
          },
          ['REFUNDED'],
        );
      default:
        return this.finish(
          command,
          orderId,
          payment.status,
          {},
          'payment.PaymentDeclined',
          {
            orderId,
            reason: payment.decline_reason ?? 'declined',
          },
          [payment.status],
        );
    }
  }

  private alreadyProcessed(eventId: string): Promise<boolean> {
    // Cheap pre-check so a redelivered command does not call the ledger again.
    return isProcessed(this.db, PAYMENT_INBOX, eventId);
  }

  private async lock(trx: Trx, orderId: string): Promise<PaymentRow> {
    return trx
      .selectFrom('payments')
      .select([
        'order_id',
        'customer_id',
        'status',
        'amount',
        'currency',
        'ledger_account_id',
        'ledger_transaction_id',
        'reversal_transaction_id',
        'decline_reason',
      ])
      .where('order_id', '=', orderId)
      .forUpdate()
      .executeTakeFirstOrThrow();
  }

  private async reply<T extends MessageType>(
    trx: Trx,
    command: TypedEnvelope,
    type: T,
    payload: MessagePayload<T>,
  ): Promise<void> {
    await enqueue(trx, [
      {
        topic: Topics.paymentEvents,
        envelope: createEnvelope({
          type,
          payload,
          producer: ServiceName.payment,
          correlationId: command.correlationId,
          causationId: command.eventId,
        }),
      },
    ]);
  }
}

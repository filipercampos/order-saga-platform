import { Inject, Injectable, Logger } from '@nestjs/common';
import type { TypedEnvelope } from '@saga/contracts';
import { processOnce } from '@saga/outbox';
import { DATABASE } from '@saga/platform';
import { Kysely, sql } from 'kysely';
import type { NotificationDatabase } from '../database/migrations';

export const NOTIFICATION_SENDER = Symbol('NOTIFICATION_SENDER');
export const NOTIFICATION_INBOX = 'notification-order-events';

export interface NotificationSender {
  /** Delivers to the customer's channel. The id is passed as the provider's idempotency token. */
  send(notification: {
    id: string;
    customerId: string;
    template: string;
    orderId: string;
  }): Promise<void>;
}

/**
 * Logs instead of sending. In AWS the adapter resolves the address from Cognito
 * (AdminGetUser) and calls SES; events deliberately carry no email address (PII stays in
 * the identity provider).
 */
export class LogNotificationSender implements NotificationSender {
  private readonly logger = new Logger('NotificationSender');
  sent: string[] = [];

  send(notification: { id: string; customerId: string; template: string; orderId: string }) {
    this.sent.push(`${notification.template}:${notification.orderId}`);
    this.logger.log({ ...notification }, 'notification sent');
    return Promise.resolve();
  }
}

@Injectable()
export class NotificationService {
  constructor(
    @Inject(DATABASE) private readonly db: Kysely<NotificationDatabase>,
    @Inject(NOTIFICATION_SENDER) private readonly sender: NotificationSender,
  ) {}

  async handle(event: TypedEnvelope): Promise<string> {
    if (event.type !== 'order.OrderConfirmed' && event.type !== 'order.OrderCancelled') {
      return 'ignored';
    }
    const template = event.type === 'order.OrderConfirmed' ? 'order-confirmed' : 'order-cancelled';
    const { orderId, customerId } = event.payload;

    // Record the intent exactly once; send after commit (sending is not transactional).
    const outcome = await processOnce(
      this.db,
      { consumer: NOTIFICATION_INBOX, eventId: event.eventId, messageType: event.type },
      (trx) =>
        trx
          .insertInto('notifications')
          .values({
            order_id: orderId,
            customer_id: customerId,
            template,
            status: 'PENDING',
            sent_at: null,
          })
          .onConflict((oc) => oc.columns(['order_id', 'template']).doNothing())
          .returning('id')
          .executeTakeFirst(),
    );
    if (outcome.duplicate || !outcome.result) return 'duplicate';

    const id = outcome.result.id;
    await this.sender.send({ id, customerId, template, orderId });
    await this.db
      .updateTable('notifications')
      .set({ status: 'SENT', sent_at: sql`now()` })
      .where('id', '=', id)
      .execute();
    return 'sent';
  }
}

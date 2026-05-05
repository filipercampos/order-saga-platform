import {
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Put,
} from '@nestjs/common';
import { DATABASE, RequireScopes, ZodValidationPipe } from '@saga/platform';
import { Kysely } from 'kysely';
import { z } from 'zod';
import { PaymentScopes } from '../config';
import type { PaymentDatabase } from '../database/schema';

const walletSchema = z.object({ ledgerAccountId: z.string().min(1).max(64) });

/**
 * Maps customers to their ledger wallet account. Written by the wallet onboarding flow
 * (M2M); never taken from the order request, so a customer cannot pay from someone
 * else's account.
 */
@Controller('internal')
@RequireScopes(PaymentScopes.admin)
export class WalletsController {
  constructor(@Inject(DATABASE) private readonly db: Kysely<PaymentDatabase>) {}

  @Put('wallets/:customerId')
  async link(
    @Param('customerId') customerId: string,
    @Body(new ZodValidationPipe(walletSchema)) body: z.infer<typeof walletSchema>,
  ) {
    await this.db
      .insertInto('wallets')
      .values({ customer_id: customerId, ledger_account_id: body.ledgerAccountId })
      .onConflict((oc) =>
        oc.column('customer_id').doUpdateSet({ ledger_account_id: body.ledgerAccountId }),
      )
      .execute();
    return { customerId, ledgerAccountId: body.ledgerAccountId };
  }

  @Get('payments/:orderId')
  async payment(@Param('orderId', ParseUUIDPipe) orderId: string) {
    const payment = await this.db
      .selectFrom('payments')
      .selectAll()
      .where('order_id', '=', orderId)
      .executeTakeFirst();
    if (!payment) throw new NotFoundException({ type: 'payment_not_found', detail: orderId });
    return payment;
  }
}

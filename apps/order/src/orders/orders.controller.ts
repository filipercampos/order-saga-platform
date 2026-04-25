import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
} from '@nestjs/common';
import { CurrentPrincipal, Principal, RequireScopes, ZodValidationPipe } from '@saga/platform';
import type { Response } from 'express';
import { z } from 'zod';
import { OrderScopes } from '../config';
import { OrdersService } from './orders.service';

const KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export const placeOrderSchema = z.object({
  items: z
    .array(
      z.object({
        sku: z.string().regex(/^[A-Z0-9-]{1,64}$/),
        quantity: z.number().int().positive().max(100),
      }),
    )
    .min(1)
    .max(50)
    .refine((items) => new Set(items.map((i) => i.sku)).size === items.length, {
      message: 'each sku must appear once',
    }),
});
type PlaceOrderDto = z.infer<typeof placeOrderSchema>;

@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  /**
   * Accepts the order and returns 202: the outcome is decided asynchronously by the saga.
   * Clients poll GET /orders/:id (or receive the notification).
   */
  @Post()
  @RequireScopes(OrderScopes.write)
  @HttpCode(HttpStatus.ACCEPTED)
  async place(
    @CurrentPrincipal() principal: Principal,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(new ZodValidationPipe(placeOrderSchema)) body: PlaceOrderDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (principal.kind !== 'user') {
      throw new ForbiddenException({
        type: 'customer_required',
        detail: 'orders are placed by customers',
      });
    }
    if (!idempotencyKey || !KEY_PATTERN.test(idempotencyKey)) {
      throw new BadRequestException({
        type: 'idempotency_key_required',
        detail: 'Idempotency-Key header (8-128 chars, [A-Za-z0-9_-]) is required',
      });
    }
    const { orderId, replayed } = await this.orders.place({
      customerId: principal.subject,
      idempotencyKey,
      items: body.items,
    });
    if (replayed) response.setHeader('Idempotent-Replayed', 'true');
    response.setHeader('Location', `/orders/${orderId}`);
    return { orderId, status: 'PENDING' };
  }

  @Get(':id')
  @RequireScopes(OrderScopes.read)
  async get(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string) {
    // Customers only see their own orders; 404 (not 403) avoids confirming existence.
    const order = await this.orders.find(id, principal.kind === 'user' ? principal.subject : null);
    if (!order) throw new NotFoundException({ type: 'order_not_found', detail: `order ${id}` });
    return order;
  }
}

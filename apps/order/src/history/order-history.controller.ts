import {
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Query,
  Res,
} from '@nestjs/common';
import { CurrentPrincipal, Principal, RequireScopes, ZodValidationPipe } from '@saga/platform';
import type { Response } from 'express';
import { Db, Filter } from 'mongodb';
import { z } from 'zod';
import { OrderScopes } from '../config';
import { MONGO_DB } from './mongo';
import { HISTORY_COLLECTION, OrderHistoryDocument } from './order-history.projector';

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  before: z.string().datetime().optional(),
});

/**
 * Query side (eventually consistent, typically sub-second behind the write side).
 * Responses say so in a header, and GET /orders/:id stays on Postgres for read-your-write.
 */
@Controller('orders')
export class OrderHistoryController {
  constructor(@Inject(MONGO_DB) private readonly db: Db) {}

  @Get()
  @RequireScopes(OrderScopes.read)
  async list(
    @CurrentPrincipal() principal: Principal,
    @Query(new ZodValidationPipe(listQuery)) query: z.infer<typeof listQuery>,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('X-Read-Model', 'eventually-consistent');
    const filter: Filter<OrderHistoryDocument> = { customerId: principal.subject };
    if (query.before) filter.placedAt = { $lt: new Date(query.before) };
    const docs = await this.collection()
      .find(filter, { projection: { timeline: 0 } })
      .sort({ placedAt: -1 })
      .limit(query.limit)
      .toArray();
    const last = docs.at(-1);
    return {
      items: docs.map(({ _id, ...rest }) => ({ orderId: _id, ...rest })),
      next: docs.length === query.limit && last?.placedAt ? last.placedAt.toISOString() : null,
    };
  }

  @Get(':id/history')
  @RequireScopes(OrderScopes.read)
  async history(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('X-Read-Model', 'eventually-consistent');
    const doc = await this.collection().findOne({ _id: id });
    // Until OrderPlaced is projected the owner is unknown: treat as not found.
    if (!doc || (principal.kind === 'user' && doc.customerId !== principal.subject)) {
      throw new NotFoundException({ type: 'order_not_found', detail: `order ${id}` });
    }
    const { _id, timeline, ...rest } = doc;
    return {
      orderId: _id,
      ...rest,
      timeline: [...timeline].sort((a, b) => a.at.getTime() - b.at.getTime()),
    };
  }

  private collection() {
    return this.db.collection<OrderHistoryDocument>(HISTORY_COLLECTION);
  }
}

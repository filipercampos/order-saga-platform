import { Body, Controller, Get, Inject, NotFoundException, Param, Put } from '@nestjs/common';
import { DATABASE, RequireScopes, ZodValidationPipe } from '@saga/platform';
import { Kysely, sql } from 'kysely';
import { z } from 'zod';
import { InventoryScopes } from '../config';
import type { InventoryDatabase } from '../database/schema';

const productSchema = z.object({
  name: z.string().min(1).max(200),
  unitPrice: z.string().regex(/^\d{1,18}$/),
  currency: z.string().regex(/^[A-Z]{3}$/),
  available: z.number().int().min(0),
});
type ProductDto = z.infer<typeof productSchema>;

/** Back-office/catalogue sync endpoint (M2M only). */
@Controller('internal/products')
@RequireScopes(InventoryScopes.admin)
export class ProductsController {
  constructor(@Inject(DATABASE) private readonly db: Kysely<InventoryDatabase>) {}

  @Put(':sku')
  async upsert(
    @Param('sku') sku: string,
    @Body(new ZodValidationPipe(productSchema)) body: ProductDto,
  ) {
    await this.db
      .insertInto('products')
      .values({
        sku,
        name: body.name,
        unit_price: body.unitPrice,
        currency: body.currency,
        available: body.available,
        reserved: 0,
      })
      .onConflict((oc) =>
        oc.column('sku').doUpdateSet({
          name: body.name,
          unit_price: body.unitPrice,
          currency: body.currency,
          available: body.available,
          updated_at: sql`now()`,
        }),
      )
      .execute();
    return this.get(sku);
  }

  @Get(':sku')
  async get(@Param('sku') sku: string) {
    const product = await this.db
      .selectFrom('products')
      .selectAll()
      .where('sku', '=', sku)
      .executeTakeFirst();
    if (!product) throw new NotFoundException({ type: 'product_not_found', detail: sku });
    return {
      sku: product.sku,
      name: product.name,
      unitPrice: product.unit_price,
      currency: product.currency,
      available: product.available,
      reserved: product.reserved,
    };
  }
}

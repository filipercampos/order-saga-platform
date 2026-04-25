import {
  ConflictException,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { RequireScopes } from '@saga/platform';
import { OrderScopes } from '../config';
import { SagaService } from './saga.service';

/**
 * Operator endpoints (runbook: stuck sagas). Reachable only inside the cluster and only
 * with an M2M token carrying `orders/admin`.
 */
@Controller('internal/sagas')
@RequireScopes(OrderScopes.admin)
export class SagaAdminController {
  constructor(private readonly sagas: SagaService) {}

  @Get(':orderId')
  async inspect(@Param('orderId', ParseUUIDPipe) orderId: string) {
    const saga = await this.sagas.load(orderId);
    if (!saga) throw new NotFoundException({ type: 'saga_not_found', detail: orderId });
    return { saga, transitions: await this.sagas.transitions(orderId) };
  }

  @Post(':orderId/retry')
  @HttpCode(202)
  async retry(@Param('orderId', ParseUUIDPipe) orderId: string) {
    const outcome = await this.sagas.operatorRetry(orderId);
    if (outcome === 'unknown')
      throw new NotFoundException({ type: 'saga_not_found', detail: orderId });
    if (outcome === 'ignored') {
      throw new ConflictException({
        type: 'saga_not_failed',
        detail: 'only FAILED sagas can be retried',
      });
    }
    return { orderId, retried: true };
  }
}

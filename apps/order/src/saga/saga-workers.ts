import { Logger } from '@nestjs/common';
import { InterruptibleSleep, Worker } from '@saga/platform';
import type { TypedEnvelope } from '@saga/contracts';
import { isSagaReply } from './saga-machine';
import type { SagaService } from './saga.service';

/** Handles messages from the `order-saga-replies` queue. */
export function sagaReplyHandler(sagas: SagaService, logger = new Logger('SagaReplies')) {
  return async (envelope: TypedEnvelope): Promise<void> => {
    if (!isSagaReply(envelope)) {
      // Subscriptions deliver every inventory/payment event; non-replies are not ours.
      logger.debug({ type: envelope.type }, 'not a saga reply, skipping');
      return;
    }
    const outcome = await sagas.handleReply(envelope);
    logger.log({ type: envelope.type, orderId: envelope.payload.orderId, outcome }, 'saga reply');
  };
}

/** Periodically feeds `timeout` into sagas whose deadline has passed. */
export class SagaTimeoutScanner implements Worker {
  readonly name = 'saga-timeout-scanner';
  private readonly logger = new Logger(SagaTimeoutScanner.name);
  private readonly sleeper = new InterruptibleSleep();
  private running = false;
  private loop: Promise<void> | undefined;

  constructor(
    private readonly sagas: SagaService,
    private readonly intervalMs: number,
    private readonly batchSize = 50,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.sleeper.wake();
    await this.loop;
  }

  private async run(): Promise<void> {
    while (this.running) {
      let delay = this.intervalMs;
      try {
        const applied = await this.sagas.processDueTimeouts(this.batchSize);
        if (applied > 0) this.logger.log({ applied }, 'saga timeouts applied');
        if (applied === this.batchSize) delay = 0;
      } catch (error) {
        this.logger.error({ err: error }, 'timeout scan failed');
      }
      if (delay > 0 && this.running) await this.sleeper.sleep(delay);
    }
  }
}

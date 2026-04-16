import { Logger } from '@nestjs/common';
import { InterruptibleSleep, Worker, backoffWithJitter } from '@saga/platform';
import type { Kysely } from 'kysely';
import { MessagePublisher, RelayOptions, RelayResult, relayBatch } from './outbox';

export interface OutboxRelayOptions extends RelayOptions {
  pollIntervalMs: number;
  onBatch?: (result: RelayResult) => void;
}

const MAX_BACKOFF_MS = 30_000;

/**
 * Drains the outbox continuously while there is backlog, sleeps when idle and backs off
 * (with jitter) when the broker fails, so a broker outage does not become a hot loop.
 */
export class OutboxRelay<DB> implements Worker {
  readonly name = 'outbox-relay';
  private readonly logger = new Logger(OutboxRelay.name);
  private readonly sleeper = new InterruptibleSleep();
  private running = false;
  private loop: Promise<void> | undefined;

  constructor(
    private readonly db: Kysely<DB>,
    private readonly publisher: MessagePublisher,
    private readonly options: OutboxRelayOptions,
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

  /** One pass; exposed for tests. */
  tick(): Promise<RelayResult> {
    return relayBatch(this.db, this.publisher, this.options);
  }

  private async run(): Promise<void> {
    let failures = 0;
    while (this.running) {
      let delay = this.options.pollIntervalMs;
      try {
        const result = await this.tick();
        this.options.onBatch?.(result);
        if (result.failed > 0) {
          failures += 1;
          delay = backoffWithJitter(failures, this.options.pollIntervalMs, MAX_BACKOFF_MS);
          this.logger.warn({ ...result, retryInMs: delay }, 'outbox publish failures');
        } else {
          failures = 0;
          // A full batch means more backlog: go again immediately.
          if (result.published === this.options.batchSize) delay = 0;
        }
      } catch (error) {
        failures += 1;
        delay = backoffWithJitter(failures, this.options.pollIntervalMs, MAX_BACKOFF_MS);
        this.logger.error({ err: error, retryInMs: delay }, 'outbox relay pass failed');
      }
      if (delay > 0 && this.running) await this.sleeper.sleep(delay);
    }
  }
}

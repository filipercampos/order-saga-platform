import {
  BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import type { Worker } from '../worker';

export const WORKERS = Symbol('WORKERS');

/**
 * Starts background workers once the app is fully initialised and stops them in
 * `beforeApplicationShutdown`, i.e. before database pools close in
 * `onApplicationShutdown`. In-flight messages finish; unacked ones are redelivered.
 */
@Injectable()
export class WorkerHost implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(WorkerHost.name);

  constructor(@Inject(WORKERS) private readonly workers: Worker[]) {}

  onApplicationBootstrap(): void {
    for (const worker of this.workers) worker.start();
    this.logger.log({ workers: this.workers.map((w) => w.name) }, 'workers started');
  }

  async beforeApplicationShutdown(): Promise<void> {
    await Promise.all(this.workers.map((worker) => worker.stop()));
    this.logger.log('workers stopped');
  }
}

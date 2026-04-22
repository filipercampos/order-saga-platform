import {
  BeforeApplicationShutdown,
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common';

export const HEALTH_CHECKS = Symbol('HEALTH_CHECKS');

export interface HealthCheck {
  name: string;
  check: () => Promise<void>;
}

const CHECK_TIMEOUT_MS = 2_000;

/**
 * Kubernetes probes. Liveness never touches dependencies (a database outage must not
 * restart every pod); readiness checks them and flips to 503 as soon as shutdown starts,
 * so the endpoint is removed from the Service before the pod stops accepting work.
 */
@Controller('health')
export class HealthController implements BeforeApplicationShutdown {
  private shuttingDown = false;

  constructor(@Inject(HEALTH_CHECKS) private readonly checks: HealthCheck[]) {}

  beforeApplicationShutdown(): void {
    this.shuttingDown = true;
  }

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready() {
    if (this.shuttingDown) {
      throw new ServiceUnavailableException({ type: 'shutting_down', detail: 'draining' });
    }
    const results = await Promise.all(
      this.checks.map(async ({ name, check }) => {
        try {
          await withTimeout(check(), CHECK_TIMEOUT_MS);
          return [name, 'up'] as const;
        } catch {
          return [name, 'down'] as const;
        }
      }),
    );
    const details = Object.fromEntries(results);
    if (results.some(([, status]) => status === 'down')) {
      throw new ServiceUnavailableException({
        type: 'not_ready',
        detail: 'dependency down',
        details,
      });
    }
    return { status: 'ok', details };
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

import type { Server } from 'node:http';
import { DynamicModule, INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';

/** Same app construction for main.ts and integration tests. */
export async function createServiceApp(module: DynamicModule): Promise<INestApplication> {
  const app = await NestFactory.create(module, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  return app;
}

export async function runService(module: DynamicModule, port: number): Promise<void> {
  const app = await createServiceApp(module);
  app.enableShutdownHooks();
  await app.listen(port);
  // Keep-alive above the ALB/NLB idle timeout to avoid 502s on reused connections.
  (app.getHttpServer() as Server).keepAliveTimeout = 65_000;
}

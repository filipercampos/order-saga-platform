import { randomUUID } from 'node:crypto';
import { DynamicModule } from '@nestjs/common';
import { currentCorrelation } from '@saga/platform';
import { LoggerModule } from 'nestjs-pino';

export interface LoggerOptions {
  serviceName: string;
  level: string;
  pretty: boolean;
}

const MAX_ID_LENGTH = 128;

/**
 * Structured JSON logs (pino). HTTP requests get a request id (propagated from
 * `x-request-id` or minted) echoed back to the caller; message handlers get the
 * correlation id (order id) from AsyncLocalStorage, so one grep follows an order
 * across all four services.
 */
export function loggerModule(options: LoggerOptions): DynamicModule {
  return LoggerModule.forRoot({
    pinoHttp: {
      level: options.level,
      base: { service: options.serviceName },
      genReqId: (request, response) => {
        const header = request.headers['x-request-id'];
        const id =
          typeof header === 'string' && header.length <= MAX_ID_LENGTH ? header : randomUUID();
        response.setHeader('x-request-id', id);
        return id;
      },
      mixin: () => {
        const correlation = currentCorrelation();
        return correlation ? { ...correlation } : {};
      },
      redact: ['req.headers.authorization', 'req.headers.cookie'],
      autoLogging: { ignore: (request) => request.url?.startsWith('/health') ?? false },
      transport: options.pretty ? { target: 'pino-pretty' } : undefined,
    },
  });
}

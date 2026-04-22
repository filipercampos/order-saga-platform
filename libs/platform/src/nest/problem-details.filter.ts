import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  [extension: string]: unknown;
}

/** Renders every error as RFC 9457 problem details. Internal errors never leak details. */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const problem = toProblem(exception);
    problem.instance = request.originalUrl;
    if (problem.status >= 500 && problem.status !== 503) {
      this.logger.error({ err: exception, path: request.originalUrl }, 'unhandled error');
    }
    response.status(problem.status).type('application/problem+json').json(problem);
  }
}

function toProblem(exception: unknown): ProblemDetails {
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const body = exception.getResponse();
    if (typeof body === 'object' && body !== null && 'type' in body) {
      return {
        title: exception.name,
        status,
        ...(body as Record<string, unknown>),
      } as ProblemDetails;
    }
    return {
      type: 'about:blank',
      title: exception.name,
      status,
      detail: typeof body === 'string' ? body : exception.message,
    };
  }
  return {
    type: 'internal_error',
    title: 'Internal Server Error',
    status: HttpStatus.INTERNAL_SERVER_ERROR,
  };
}

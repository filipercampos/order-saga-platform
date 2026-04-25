import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

export const TOKEN_VERIFIER = Symbol('TOKEN_VERIFIER');
const SCOPES_KEY = 'auth:scopes';
const PUBLIC_KEY = 'auth:public';

/**
 * - `user`: a customer, access token from the Cognito user pool via the authorization
 *   code flow (+PKCE) in the web/mobile app. `subject` is the Cognito `sub`.
 * - `service`: another workload, access token from the client credentials grant (M2M).
 */
export interface Principal {
  kind: 'user' | 'service';
  subject: string;
  clientId: string;
  scopes: string[];
}

export interface TokenVerifier {
  /** Resolves the principal or throws when the token is invalid or expired. */
  verify(token: string): Promise<Principal>;
}

export interface AuthenticatedRequest extends Request {
  principal?: Principal;
}

/** All listed scopes must be present. */
export const RequireScopes = (...scopes: string[]) => SetMetadata(SCOPES_KEY, scopes);
export const Public = () => SetMetadata(PUBLIC_KEY, true);

export const CurrentPrincipal = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  const principal = ctx.switchToHttp().getRequest<AuthenticatedRequest>().principal;
  if (!principal) throw new UnauthorizedException({ type: 'missing_token' });
  return principal;
});

/**
 * Deny by default: a route without @RequireScopes or @Public is rejected, so a forgotten
 * decorator fails closed.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(TOKEN_VERIFIER) private readonly verifier: TokenVerifier,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, targets)) return true;

    const required = this.reflector.getAllAndOverride<string[]>(SCOPES_KEY, targets);
    if (!required) {
      throw new ForbiddenException({ type: 'route_not_authorized', detail: 'no scope policy' });
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const [scheme, token] = (request.header('authorization') ?? '').split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      throw new UnauthorizedException({ type: 'missing_token', detail: 'Bearer token required' });
    }

    let principal: Principal;
    try {
      principal = await this.verifier.verify(token);
    } catch {
      throw new UnauthorizedException({ type: 'invalid_token', detail: 'token rejected' });
    }

    const missing = required.filter((scope) => !principal.scopes.includes(scope));
    if (missing.length > 0) {
      throw new ForbiddenException({
        type: 'insufficient_scope',
        detail: `missing ${missing.join(', ')}`,
      });
    }
    request.principal = principal;
    return true;
  }
}

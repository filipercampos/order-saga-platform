import { Provider } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { AuthGuard, Principal, TOKEN_VERIFIER, TokenVerifier } from './auth.guard';

/**
 * Verifies Cognito access tokens (signature against the pool JWKS, expiry, issuer,
 * token_use=access, client id). User tokens carry `username`; client-credentials tokens
 * do not, and their `sub` is the app client id.
 */
export class CognitoTokenVerifier implements TokenVerifier {
  private readonly verifier;

  constructor(userPoolId: string, clientIds: string[]) {
    this.verifier = CognitoJwtVerifier.create({
      userPoolId,
      tokenUse: 'access',
      clientId: clientIds.length > 0 ? clientIds : null,
    });
  }

  async verify(token: string): Promise<Principal> {
    const payload = await this.verifier.verify(token);
    return {
      kind: typeof payload.username === 'string' ? 'user' : 'service',
      subject: payload.sub,
      clientId: payload.client_id,
      scopes: typeof payload.scope === 'string' ? payload.scope.split(' ') : [],
    };
  }
}

/**
 * Local development and tests only (config validation rejects it in production).
 * `Bearer svc-<name>` is a service principal, any other token is a customer whose id is
 * the token value. Every scope is granted.
 */
export class DevTokenVerifier implements TokenVerifier {
  constructor(private readonly scopes: string[]) {}

  verify(token: string): Promise<Principal> {
    const subject = token.slice(0, 64);
    return Promise.resolve({
      kind: subject.startsWith('svc-') ? 'service' : 'user',
      subject,
      clientId: `dev-${subject}`,
      scopes: this.scopes,
    });
  }
}

export interface AuthSettings {
  AUTH_MODE: 'cognito' | 'disabled';
  COGNITO_USER_POOL_ID?: string;
  COGNITO_CLIENT_IDS: string[];
}

export function authProviders(env: AuthSettings, devScopes: string[]): Provider[] {
  const verifier: TokenVerifier =
    env.AUTH_MODE === 'cognito'
      ? new CognitoTokenVerifier(env.COGNITO_USER_POOL_ID ?? '', env.COGNITO_CLIENT_IDS)
      : new DevTokenVerifier(devScopes);
  return [
    { provide: TOKEN_VERIFIER, useValue: verifier },
    { provide: APP_GUARD, useClass: AuthGuard },
  ];
}

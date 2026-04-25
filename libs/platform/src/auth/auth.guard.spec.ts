import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard, Principal, TokenVerifier } from './auth.guard';

function contextWith(header: string | undefined, metadata: Record<string, unknown>) {
  const request: { principal?: Principal; header: (name: string) => string | undefined } = {
    header: () => header,
  };
  const reflector = {
    getAllAndOverride: (key: string) => metadata[key],
  } as unknown as Reflector;
  const context = {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { request, reflector, context };
}

const verifier: TokenVerifier = {
  verify: (token) =>
    token === 'good'
      ? Promise.resolve({ kind: 'user', subject: 'u-1', clientId: 'spa', scopes: ['orders/read'] })
      : Promise.reject(new Error('bad signature')),
};

describe('AuthGuard', () => {
  it('denies routes without a scope policy (fail closed)', async () => {
    const { reflector, context } = contextWith('Bearer good', {});
    await expect(new AuthGuard(reflector, verifier).canActivate(context)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('allows public routes without a token', async () => {
    const { reflector, context } = contextWith(undefined, { 'auth:public': true });
    await expect(new AuthGuard(reflector, verifier).canActivate(context)).resolves.toBe(true);
  });

  it('rejects missing and invalid tokens with 401', async () => {
    for (const header of [undefined, 'Basic abc', 'Bearer bad']) {
      const { reflector, context } = contextWith(header, { 'auth:scopes': ['orders/read'] });
      await expect(new AuthGuard(reflector, verifier).canActivate(context)).rejects.toThrow(
        UnauthorizedException,
      );
    }
  });

  it('requires every listed scope and attaches the principal', async () => {
    const denied = contextWith('Bearer good', { 'auth:scopes': ['orders/read', 'orders/admin'] });
    await expect(
      new AuthGuard(denied.reflector, verifier).canActivate(denied.context),
    ).rejects.toThrow('Forbidden');

    const allowed = contextWith('Bearer good', { 'auth:scopes': ['orders/read'] });
    await expect(
      new AuthGuard(allowed.reflector, verifier).canActivate(allowed.context),
    ).resolves.toBe(true);
    expect(allowed.request.principal?.subject).toBe('u-1');
  });
});

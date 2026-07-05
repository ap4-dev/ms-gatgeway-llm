import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RequireScopesGuard } from './require-scopes.guard';
import type { Client } from './client.repository';

function clientWith(scopes: string[]): Client {
    return {
        id: 'admin',
        name: 'Admin',
        apiKeyHash: 'x',
        apiKeyPrefix: 'x',
        scopes,
        rateLimitRpm: 60,
        rateLimitTpm: null,
        createdAt: 0,
        lastUsedAt: null,
        revoked: false,
    };
}

function makeContext(req: any): ExecutionContext {
    return {
        switchToHttp: () => ({ getRequest: () => req }),
        getHandler: () => undefined as any,
        getClass: () => undefined as any,
    } as unknown as ExecutionContext;
}

describe('RequireScopesGuard', () => {
    it('passes when no scopes are required', () => {
        const reflector = { getAllAndOverride: () => undefined } as unknown as Reflector;
        const guard = new RequireScopesGuard(reflector);
        const ctx = makeContext({ client: clientWith(['admin']) });
        expect(guard.canActivate(ctx)).toBe(true);
    });

    it('passes when every required scope is present', () => {
        const reflector = {
            getAllAndOverride: () => ['admin', 'chat.read'],
        } as unknown as Reflector;
        const guard = new RequireScopesGuard(reflector);
        const ctx = makeContext({ client: clientWith(['admin', 'chat.read', 'chat.write']) });
        expect(guard.canActivate(ctx)).toBe(true);
    });

    it('throws ForbiddenException when a required scope is missing', () => {
        const reflector = {
            getAllAndOverride: () => ['admin'],
        } as unknown as Reflector;
        const guard = new RequireScopesGuard(reflector);
        const ctx = makeContext({ client: clientWith(['chat.read']) });
        expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
    });

    it('throws ForbiddenException when no client is attached (auth missing)', () => {
        const reflector = {
            getAllAndOverride: () => ['admin'],
        } as unknown as Reflector;
        const guard = new RequireScopesGuard(reflector);
        const ctx = makeContext({});
        expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
    });

    it('requires ALL listed scopes, not just one', () => {
        const reflector = {
            getAllAndOverride: () => ['admin', 'chat.read'],
        } as unknown as Reflector;
        const guard = new RequireScopesGuard(reflector);
        // Client has admin but not chat.read.
        const ctx = makeContext({ client: clientWith(['admin']) });
        expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
    });
});

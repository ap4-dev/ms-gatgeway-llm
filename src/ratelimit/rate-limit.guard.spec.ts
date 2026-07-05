import { HttpException } from '@nestjs/common';
import { RateLimitGuard } from './rate-limit.guard';
import type { RedisRateLimiterService } from './redis-rate-limiter.service';
import type { ClientService } from '../auth/client.service';
import type { Client } from '../auth/client.repository';

function makeClient(overrides: Partial<Client> = {}): Client {
    return {
        id: 'admin',
        name: 'Admin',
        apiKeyHash: 'scrypt$xx$yy',
        apiKeyPrefix: 'sk-abcde',
        scopes: ['chat.read', 'chat.write'],
        rateLimitRpm: 60,
        rateLimitTpm: null,
        createdAt: 0,
        lastUsedAt: null,
        revoked: false,
        ...overrides,
    };
}

function makeReq(client?: Client): any {
    return { client };
}

function makeContext(req: any): any {
    return {
        switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({ setHeader: jest.fn() }) }),
    };
}

describe('RateLimitGuard', () => {
    it('passes when the client is missing the guard (auth guard should run first)', async () => {
        const limiter = { allowRequest: jest.fn() } as unknown as RedisRateLimiterService;
        const clients = {} as unknown as ClientService;
        const guard = new RateLimitGuard(limiter, clients);
        await expect(guard.canActivate(makeContext(makeReq(undefined)))).resolves.toBe(true);
        expect(limiter.allowRequest).not.toHaveBeenCalled();
    });

    it('allows when the limiter allows', async () => {
        const limiter = {
            allowRequest: jest.fn().mockResolvedValue({
                allowed: true,
                current: 1,
                limit: 60,
            }),
        } as unknown as RedisRateLimiterService;
        const clients = {} as unknown as ClientService;
        const guard = new RateLimitGuard(limiter, clients);
        const ok = await guard.canActivate(makeContext(makeReq(makeClient())));
        expect(ok).toBe(true);
    });

    it('throws HttpException(429) + sets Retry-After when denied', async () => {
        const setHeader = jest.fn();
        const limiter = {
            allowRequest: jest.fn().mockResolvedValue({
                allowed: false,
                current: 60,
                limit: 60,
                retryAfterMs: 12_345,
            }),
        } as unknown as RedisRateLimiterService;
        const clients = {} as unknown as ClientService;
        const guard = new RateLimitGuard(limiter, clients);

        const context = {
            switchToHttp: () => ({ getRequest: () => makeReq(makeClient()), getResponse: () => ({ setHeader }) }),
        };

        await expect(guard.canActivate(context)).rejects.toBeInstanceOf(HttpException);
        const err = await guard.canActivate(context).catch((e) => e);
        expect(err.getStatus()).toBe(429);
        // Retry-After is set in seconds (HTTP convention).
        expect(setHeader).toHaveBeenCalledWith('Retry-After', expect.any(String));
        const [, value] = setHeader.mock.calls[0];
        expect(Number(value)).toBeGreaterThanOrEqual(12);
        expect(Number(value)).toBeLessThanOrEqual(13);
    });

    it('uses the client’s rate_limit_rpm (not a hardcoded limit)', async () => {
        const client = makeClient({ rateLimitRpm: 7 });
        const limiter = {
            allowRequest: jest.fn().mockResolvedValue({ allowed: true, current: 1, limit: 7 }),
        } as unknown as RedisRateLimiterService;
        const clients = {} as unknown as ClientService;
        const guard = new RateLimitGuard(limiter, clients);

        await guard.canActivate(makeContext(makeReq(client)));
        expect((limiter.allowRequest as jest.Mock).mock.calls[0][1]).toBe(7);
    });
});

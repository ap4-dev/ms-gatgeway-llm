import { ApiKeyAuthGuard } from './api-key.guard';
import type { ClientService } from './client.service';
import type { Client } from './client.repository';
import { UnauthorizedException } from '@nestjs/common';

function makeMockReq(headers: Record<string, string | undefined> = {}): any {
    return { headers };
}

function makeMockClient(overrides: Partial<Client> = {}): Client {
    return {
        id: 'admin',
        name: 'Admin',
        apiKeyHash: 'hmac$xx',
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

function makeGuard(client: Client | undefined) {
    const svc = { verifyApiKey: jest.fn().mockResolvedValue(client) } as unknown as ClientService;
    return { guard: new ApiKeyAuthGuard(svc), svc };
}

describe('ApiKeyAuthGuard', () => {
    it('allows a request with a valid Authorization: Bearer <key>', async () => {
        const client = makeMockClient();
        const { guard } = makeGuard(client);
        const req = makeMockReq({ authorization: 'Bearer sk-abcdefghijk' });
        const can = await guard.canActivate({
            switchToHttp: () => ({ getRequest: () => req }),
        } as any);
        expect(can).toBe(true);
        expect(req.client).toBe(client);
    });

    it('falls back to X-API-Key header when Authorization is missing', async () => {
        const client = makeMockClient();
        const { guard, svc } = makeGuard(client);
        const req = makeMockReq({ 'x-api-key': 'sk-abcdefghijk' });
        const can = await guard.canActivate({
            switchToHttp: () => ({ getRequest: () => req }),
        } as any);
        expect(can).toBe(true);
        expect(req.client).toBe(client);
        expect(svc.verifyApiKey).toHaveBeenCalledWith('sk-abcdefghijk');
    });

    it('throws UnauthorizedException when no header is present', async () => {
        const { guard } = makeGuard(undefined);
        await expect(
            guard.canActivate({
                switchToHttp: () => ({ getRequest: () => makeMockReq() }),
            } as any),
        ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('throws UnauthorizedException when Authorization is malformed (not Bearer …)', async () => {
        const { guard } = makeGuard(undefined);
        await expect(
            guard.canActivate({
                switchToHttp: () => ({
                    getRequest: () => makeMockReq({ authorization: 'Basic abc' }),
                }),
            } as any),
        ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('throws UnauthorizedException when the key does not verify', async () => {
        const { guard, svc } = makeGuard(undefined);
        const req = makeMockReq({ authorization: 'Bearer sk-bogus' });
        await expect(
            guard.canActivate({
                switchToHttp: () => ({ getRequest: () => req }),
            } as any),
        ).rejects.toBeInstanceOf(UnauthorizedException);
        expect(svc.verifyApiKey).toHaveBeenCalledWith('sk-bogus');
    });

    it('awaits the async verifyApiKey path', async () => {
        const client = makeMockClient();
        const svc = {
            verifyApiKey: jest.fn(async (_p: string) => {
                await new Promise((r) => setImmediate(r)); // simulate async hop
                return client;
            }),
        } as unknown as ClientService;
        const guard = new ApiKeyAuthGuard(svc);
        const req = makeMockReq({ authorization: 'Bearer sk-abc' });
        const can = await guard.canActivate({
            switchToHttp: () => ({ getRequest: () => req }),
        } as any);
        expect(can).toBe(true);
        expect(req.client).toBe(client);
    });
});

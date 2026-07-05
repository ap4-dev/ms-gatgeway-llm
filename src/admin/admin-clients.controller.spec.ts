import { ConflictException, NotFoundException } from '@nestjs/common';
import { AdminClientsController } from './admin-clients.controller';
import type { ClientService } from '../auth/client.service';
import type { Client } from '../auth/client.repository';

function makeClient(overrides: Partial<Client> = {}): Client {
    return {
        id: 'admin',
        name: 'Admin',
        apiKeyHash: 'scrypt$xx$yy',
        apiKeyPrefix: 'sk-abcde',
        scopes: ['admin', 'chat.read'],
        rateLimitRpm: 60,
        rateLimitTpm: null,
        createdAt: 0,
        lastUsedAt: null,
        revoked: false,
        ...overrides,
    };
}

function makeController(seed: { clients?: Client[]; created?: { client: Client; plaintextApiKey: string }; rotated?: { client: Client; plaintextApiKey: string } } = {}) {
    const stored: Client[] = seed.clients ? [...seed.clients] : [];
    const svc = {
        findById: jest.fn((id: string) => stored.find((c) => c.id === id)),
        list: jest.fn(() => [...stored]),
        count: jest.fn(() => stored.length),
        create: jest.fn(() => {
            if (!seed.created) throw new Error('create not stubbed');
            stored.push(seed.created.client);
            return seed.created;
        }),
        update: jest.fn((id: string, fields: any) => {
            const cur = stored.find((c) => c.id === id);
            if (!cur) throw new NotFoundException(`Client "${id}" not found`);
            const next: Client = {
                ...cur,
                ...fields,
                scopes: fields.scopes ?? cur.scopes,
                rateLimitRpm: fields.rateLimitRpm ?? cur.rateLimitRpm,
                rateLimitTpm:
                    fields.rateLimitTpm !== undefined
                        ? fields.rateLimitTpm
                        : cur.rateLimitTpm,
            } as Client;
            stored.splice(stored.indexOf(cur), 1, next);
            return next;
        }),
        revoke: jest.fn((id: string) => {
            const cur = stored.find((c) => c.id === id);
            if (cur) cur.revoked = true;
        }),
        rotateKey: jest.fn(() => {
            if (!seed.rotated) throw new Error('rotateKey not stubbed');
            const cur = stored.find((c) => c.id === seed.rotated.client.id);
            if (cur) stored.splice(stored.indexOf(cur), 1, seed.rotated.client);
            return seed.rotated;
        }),
        delete: jest.fn((id: string) => {
            const idx = stored.findIndex((c) => c.id === id);
            if (idx >= 0) stored.splice(idx, 1);
        }),
    } as unknown as ClientService;
    return { controller: new AdminClientsController(svc), svc, stored };
}

describe('AdminClientsController.list / get', () => {
    it('list returns the public view only (no apiKeyHash)', () => {
        const { controller } = makeController({
            clients: [makeClient({ id: 'admin' }), makeClient({ id: 'tenant-a' })],
        });
        const out = controller.list();
        expect(out.clients).toHaveLength(2);
        for (const c of out.clients) {
            expect((c as any).apiKeyHash).toBeUndefined();
            expect(c.id).toBeDefined();
        }
    });

    it('get returns the public view for an existing id', () => {
        const { controller } = makeController({ clients: [makeClient()] });
        const out = controller.get('admin');
        expect(out.id).toBe('admin');
        expect((out as any).apiKeyHash).toBeUndefined();
    });

    it('get throws NotFoundException for an unknown id', () => {
        const { controller } = makeController();
        expect(() => controller.get('missing')).toThrow(NotFoundException);
    });
});

describe('AdminClientsController.create', () => {
    it('passes through to ClientService.create and includes the plaintext key', () => {
        const created = makeClient({ id: 'tenant-a', name: 'Tenant A' });
        const { controller } = makeController({
            created: { client: created, plaintextApiKey: 'sk-tenantakey' },
        });
        const out = controller.create({ name: 'Tenant A' } as any);
        expect(out.id).toBe('tenant-a');
        expect(out.plaintextApiKey).toBe('sk-tenantakey');
        expect(out.warning).toMatch(/never be shown again/);
        expect((out as any).apiKeyHash).toBeUndefined();
    });

    it('throws ConflictException when the id already exists', () => {
        const { controller } = makeController({
            clients: [makeClient({ id: 'tenant-a' })],
            created: { client: makeClient({ id: 'tenant-a' }), plaintextApiKey: 'x' },
        });
        expect(() => controller.create({ id: 'tenant-a', name: 'X' } as any)).toThrow(ConflictException);
    });
});

describe('AdminClientsController.update', () => {
    it('updates the supplied fields and persists', () => {
        const { controller, stored } = makeController({
            clients: [makeClient({ id: 'a', rateLimitRpm: 60 })],
        });
        const out = controller.update('a', { rateLimitRpm: 120 } as any);
        expect(out.rateLimitRpm).toBe(120);
        expect(stored[0].rateLimitRpm).toBe(120);
    });

    it('throws NotFoundException on an unknown id', () => {
        const { controller } = makeController();
        expect(() => controller.update('missing', { rateLimitRpm: 100 } as any)).toThrow(NotFoundException);
    });
});

describe('AdminClientsController.rotate', () => {
    it('returns the new plaintext key and the updated view', () => {
        const rotated = makeClient({ id: 'a', apiKeyPrefix: 'sk-new12' });
        const { controller } = makeController({
            clients: [makeClient({ id: 'a' })],
            rotated: { client: rotated, plaintextApiKey: 'sk-new123456' },
        });
        const out = controller.rotate('a');
        expect((out as any).apiKeyPrefix).toBe('sk-new12');
        expect(out.plaintextApiKey).toBe('sk-new123456');
        expect(out.warning).toMatch(/never be shown again/);
        expect((out as any).apiKeyHash).toBeUndefined();
    });
});

describe('AdminClientsController.revoke / remove', () => {
    it('revoke calls ClientService.revoke', () => {
        const { controller, svc } = makeController({ clients: [makeClient()] });
        controller.revoke('admin');
        expect(svc.revoke).toHaveBeenCalledWith('admin');
    });

    it('revoke throws NotFoundException on an unknown id', () => {
        const { controller } = makeController();
        expect(() => controller.revoke('missing')).toThrow(NotFoundException);
    });

    it('remove calls ClientService.delete', () => {
        const { controller, svc } = makeController({ clients: [makeClient()] });
        controller.remove('admin');
        expect(svc.delete).toHaveBeenCalledWith('admin');
    });

    it('remove throws NotFoundException on an unknown id', () => {
        const { controller } = makeController();
        expect(() => controller.remove('missing')).toThrow(NotFoundException);
    });
});

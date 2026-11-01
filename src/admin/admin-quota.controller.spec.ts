import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AdminQuotaController } from './admin-quota.controller';
import type { ClientService } from '../auth/client.service';
import type { ProviderRegistryService } from '../providers/provider.registry';
import type { ClientQuotaView, QuotaService } from '../quota/quota.service';

const PERIOD = '2026-11';
/**
 * Both numbers are deliberately distinctive: `RESETS_AT` is not the real next
 * UTC month start for any plausible "now", and `RETRY_AFTER` is not a
 * plausible day count. A controller that recomputed either from the calendar
 * would fail these assertions.
 */
const RESETS_AT = 1_798_761_600;
const RETRY_AFTER = 4_000_001;

const CLIENT_ID = 'client-1';

function makeView(overrides: Partial<ClientQuotaView> = {}): ClientQuotaView {
    return {
        aliasKey: 'codex',
        monthlyTokenLimit: 20_000_000,
        divertAliasKey: null,
        periodKey: PERIOD,
        tokens: 1_000,
        requests: 3,
        remaining: 19_999_000,
        exhausted: false,
        resetsAt: RESETS_AT,
        retryAfterSeconds: RETRY_AFTER,
        ...overrides,
    };
}

function makeController(options: { views?: ClientQuotaView[] } = {}) {
    const views = options.views ?? [makeView()];

    const quota = {
        describeQuotas: jest.fn((_clientId: string) => views.map((v) => ({ ...v }))),
        upsertQuota: jest.fn(() => makeView()),
        removeQuota: jest.fn(() => true),
        periodKey: jest.fn(() => PERIOD),
        retryAfterSeconds: jest.fn(() => RETRY_AFTER),
    };

    const clients = {
        findById: jest.fn((id: string) =>
            id === CLIENT_ID ? { id: CLIENT_ID } : undefined,
        ),
    };

    const registry = {
        aliases: {
            codex: ['nan/qwen3.6'],
            latin: ['nan/mimo-v2.5'],
            slave: ['nan/deepseek-v4-flash'],
        } as Record<string, string[]>,
    };

    const controller = new AdminQuotaController(
        quota as unknown as QuotaService,
        clients as unknown as ClientService,
        registry as unknown as ProviderRegistryService,
    );

    return { controller, quota, clients, registry };
}

describe('AdminQuotaController.listQuotas', () => {
    it('describes the quotas of a known client', () => {
        const views = [
            makeView({ aliasKey: 'codex' }),
            makeView({
                aliasKey: 'latin',
                monthlyTokenLimit: 5_000,
                tokens: 5_000,
                remaining: 0,
                exhausted: true,
                divertAliasKey: 'slave',
            }),
        ];
        const { controller, quota } = makeController({ views });

        const out = controller.listQuotas(CLIENT_ID);

        expect(quota.describeQuotas).toHaveBeenCalledWith(CLIENT_ID);
        expect(out.clientId).toBe(CLIENT_ID);
        expect(out.periodKey).toBe(PERIOD);
        expect(out.quotas).toHaveLength(2);
        expect(out.quotas[1]).toMatchObject({
            aliasKey: 'latin',
            monthlyTokenLimit: 5_000,
            divertAliasKey: 'slave',
            exhausted: true,
        });
    });

    it('reports the service-provided reset numbers instead of recomputing them', () => {
        const { controller } = makeController();

        const out = controller.listQuotas(CLIENT_ID);

        expect(out.resetsAt).toBe(RESETS_AT);
        expect(out.retryAfterSeconds).toBe(RETRY_AFTER);
        expect(typeof out.resetsAt).toBe('number');
        expect(typeof out.retryAfterSeconds).toBe('number');
        expect(out.quotas[0].resetsAt).toBe(RESETS_AT);
        expect(out.quotas[0].retryAfterSeconds).toBe(RETRY_AFTER);
    });

    it('throws NotFoundException for an unknown client', () => {
        const { controller, quota } = makeController();

        expect(() => controller.listQuotas('missing')).toThrow(NotFoundException);
        expect(quota.describeQuotas).not.toHaveBeenCalled();
    });
});

describe('AdminQuotaController.upsertQuotas', () => {
    const validBody = {
        quotas: [
            { aliasKey: 'codex', monthlyTokenLimit: 20_000_000, divertAliasKey: 'latin' },
            { aliasKey: 'latin', monthlyTokenLimit: 5_000 },
        ],
    };

    it('upserts every entry in order and re-describes the quotas afterwards', () => {
        const { controller, quota } = makeController();

        const out = controller.upsertQuotas(CLIENT_ID, validBody);

        expect(quota.upsertQuota.mock.calls).toEqual([
            [
                CLIENT_ID,
                { aliasKey: 'codex', monthlyTokenLimit: 20_000_000, divertAliasKey: 'latin' },
            ],
            [
                CLIENT_ID,
                { aliasKey: 'latin', monthlyTokenLimit: 5_000, divertAliasKey: null },
            ],
        ]);
        expect(quota.describeQuotas).toHaveBeenCalledWith(CLIENT_ID);

        const lastWrite = quota.upsertQuota.mock.invocationCallOrder.at(-1)!;
        const description = quota.describeQuotas.mock.invocationCallOrder[0];
        expect(description).toBeGreaterThan(lastWrite);

        expect(out.clientId).toBe(CLIENT_ID);
        expect(out.quotas).toHaveLength(1);
    });

    it('is idempotent: the same body twice yields the same response', () => {
        const { controller, quota } = makeController();

        const first = controller.upsertQuotas(CLIENT_ID, validBody);
        const second = controller.upsertQuotas(CLIENT_ID, validBody);

        expect(second).toEqual(first);
        expect(quota.upsertQuota).toHaveBeenCalledTimes(4);
    });

    it('throws NotFoundException and writes nothing for an unknown client', () => {
        const { controller, quota } = makeController();

        expect(() => controller.upsertQuotas('missing', validBody)).toThrow(
            NotFoundException,
        );
        expect(quota.upsertQuota).not.toHaveBeenCalled();
    });

    it('rejects an alias that is not in the registry with 400 and writes nothing', () => {
        const { controller, quota } = makeController();

        const attempt = () =>
            controller.upsertQuotas(CLIENT_ID, {
                quotas: [{ aliasKey: 'nope', monthlyTokenLimit: 1_000 }],
            });

        expect(attempt).toThrow(BadRequestException);
        expect(attempt).toThrow(/aliasKey/);
        expect(quota.upsertQuota).not.toHaveBeenCalled();
        expect(quota.describeQuotas).not.toHaveBeenCalled();
    });

    it('rejects divertAliasKey equal to aliasKey with 400 and writes nothing', () => {
        const { controller, quota } = makeController();

        const attempt = () =>
            controller.upsertQuotas(CLIENT_ID, {
                quotas: [
                    { aliasKey: 'codex', monthlyTokenLimit: 1_000, divertAliasKey: 'codex' },
                ],
            });

        expect(attempt).toThrow(BadRequestException);
        expect(attempt).toThrow(/divertAliasKey/);
        expect(quota.upsertQuota).not.toHaveBeenCalled();
    });

    it('rejects a divertAliasKey that is not in the registry with 400 and writes nothing', () => {
        const { controller, quota } = makeController();

        const attempt = () =>
            controller.upsertQuotas(CLIENT_ID, {
                quotas: [
                    { aliasKey: 'codex', monthlyTokenLimit: 1_000, divertAliasKey: 'ghost' },
                ],
            });

        expect(attempt).toThrow(BadRequestException);
        expect(attempt).toThrow(/divertAliasKey/);
        expect(quota.upsertQuota).not.toHaveBeenCalled();
    });

    it.each([
        ['zero', 0],
        ['negative', -1],
        ['fractional', 1.5],
    ])(
        'rejects a %s monthlyTokenLimit with 400 and writes nothing',
        (_label, monthlyTokenLimit) => {
            const { controller, quota } = makeController();

            const attempt = () =>
                controller.upsertQuotas(CLIENT_ID, {
                    quotas: [{ aliasKey: 'codex', monthlyTokenLimit: monthlyTokenLimit as number }],
                });

            expect(attempt).toThrow(BadRequestException);
            expect(quota.upsertQuota).not.toHaveBeenCalled();
        },
    );

    it('accepts an explicit null divertAliasKey as "no diversion"', () => {
        const { controller, quota } = makeController();

        controller.upsertQuotas(CLIENT_ID, {
            quotas: [{ aliasKey: 'codex', monthlyTokenLimit: 1_000, divertAliasKey: null }],
        });

        expect(quota.upsertQuota).toHaveBeenCalledWith(CLIENT_ID, {
            aliasKey: 'codex',
            monthlyTokenLimit: 1_000,
            divertAliasKey: null,
        });
    });
});

describe('AdminQuotaController.deleteQuota', () => {
    it('reports a deleted row', () => {
        const { controller, quota } = makeController();

        const out = controller.deleteQuota(CLIENT_ID, 'codex');

        expect(quota.removeQuota).toHaveBeenCalledWith(CLIENT_ID, 'codex');
        expect(out).toEqual({ deleted: true, clientId: CLIENT_ID, aliasKey: 'codex' });
    });

    it('throws NotFoundException when there was no row', () => {
        const { controller, quota } = makeController();
        quota.removeQuota.mockReturnValueOnce(false);

        expect(() => controller.deleteQuota(CLIENT_ID, 'codex')).toThrow(
            NotFoundException,
        );
    });

    it('throws NotFoundException for an unknown client and deletes nothing', () => {
        const { controller, quota } = makeController();

        expect(() => controller.deleteQuota('missing', 'codex')).toThrow(
            NotFoundException,
        );
        expect(quota.removeQuota).not.toHaveBeenCalled();
    });
});

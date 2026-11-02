import { UnauthorizedException } from '@nestjs/common';
import { QuotaController } from './quota.controller';
import type { ClientQuotaView, QuotaService } from './quota.service';

const PERIOD = '2026-11';
/**
 * Distinctive on purpose: neither value can be produced by recomputing the
 * next UTC month start from the wall clock, so the assertions below only pass
 * when the controller forwards what the service reported.
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

function makeController(views: ClientQuotaView[] = [makeView()]) {
    const quota = {
        describeQuotas: jest.fn((_clientId: string) => views.map((v) => ({ ...v }))),
        upsertQuota: jest.fn(),
        removeQuota: jest.fn(),
        periodKey: jest.fn(() => PERIOD),
        retryAfterSeconds: jest.fn(() => RETRY_AFTER),
    };
    const controller = new QuotaController(quota as unknown as QuotaService);
    return { controller, quota };
}

describe('QuotaController.get', () => {
    it('returns the authenticated client own quotas', () => {
        const views = [makeView({ aliasKey: 'codex', exhausted: true, tokens: 20_000_000 })];
        const { controller, quota } = makeController(views);

        const out = controller.get({ client: { id: CLIENT_ID } } as any);

        expect(quota.describeQuotas).toHaveBeenCalledWith(CLIENT_ID);
        expect(out.clientId).toBe(CLIENT_ID);
        expect(out.periodKey).toBe(PERIOD);
        expect(out.quotas).toHaveLength(1);
        expect(out.quotas[0]).toMatchObject({ aliasKey: 'codex', exhausted: true });
    });

    it('forwards the service-provided reset numbers', () => {
        const { controller } = makeController();

        const out = controller.get({ client: { id: CLIENT_ID } } as any);

        expect(out.resetsAt).toBe(RESETS_AT);
        expect(out.retryAfterSeconds).toBe(RETRY_AFTER);
        expect(typeof out.resetsAt).toBe('number');
        expect(typeof out.retryAfterSeconds).toBe('number');
    });

    it('returns 401 and never describes an empty client when the request has no client', () => {
        const { controller, quota } = makeController();

        expect(() => controller.get({} as any)).toThrow(UnauthorizedException);
        expect(quota.describeQuotas).not.toHaveBeenCalled();
    });

    it('returns 401 when the client id is missing', () => {
        const { controller, quota } = makeController();

        expect(() => controller.get({ client: {} } as any)).toThrow(
            UnauthorizedException,
        );
        expect(quota.describeQuotas).not.toHaveBeenCalled();
    });
});

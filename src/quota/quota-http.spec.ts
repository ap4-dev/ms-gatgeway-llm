import { QuotaExhaustedError, secondsUntilInstant } from './quota.errors';
import {
    anthropicQuotaErrorBody,
    openAiQuotaErrorBody,
    quotaRetryAfterSeconds,
} from './quota-http';

const DEC_2026 = Date.UTC(2026, 11, 1); // 2026-12-01T00:00:00Z
const JAN_2027 = Date.UTC(2027, 0, 1); // 2027-01-01T00:00:00Z
const SECONDS = 1000;

function makeError(
    overrides: Partial<QuotaExhaustedError['detail']> = {},
): QuotaExhaustedError {
    return new QuotaExhaustedError({
        clientId: 'client-1',
        aliasKey: 'codex',
        periodKey: '2026-11',
        limit: 20_000_000,
        used: 20_500_000,
        resetsAt: DEC_2026 / SECONDS,
        ...overrides,
    });
}

const NOV_MIDDAY = Date.UTC(2026, 10, 15, 12, 0, 0); // 2026-11-15T12:00:00Z

describe('secondsUntilInstant', () => {
    it('counts the whole next month from an exact month start', () => {
        // 2026-12-01T00:00:00Z → 2027-01-01T00:00:00Z; December has 31 days.
        expect(secondsUntilInstant(JAN_2027 / SECONDS, DEC_2026)).toBe(31 * 86_400);
    });

    it('counts the seconds left mid-month', () => {
        // 2026-11-15T12:00:00Z → 2026-12-01T00:00:00Z = 15d 12h.
        expect(secondsUntilInstant(DEC_2026 / SECONDS, NOV_MIDDAY)).toBe(15 * 86_400 + 43_200);
    });

    it('never returns zero or a negative value for an instant in the past', () => {
        // `Retry-After: 0` (or a negative value) reads as "retry now".
        expect(secondsUntilInstant(DEC_2026 / SECONDS - 3_600, DEC_2026)).toBe(1);
        expect(secondsUntilInstant(0, DEC_2026)).toBe(1);
    });

    it('floors the current instant in milliseconds to whole seconds', () => {
        // 500 ms before the reset still yields a whole second, not zero.
        expect(secondsUntilInstant(DEC_2026 / SECONDS, DEC_2026 - 500)).toBe(1);
        expect(secondsUntilInstant(DEC_2026 / SECONDS, NOV_MIDDAY + 999)).toBe(
            DEC_2026 / SECONDS - Math.floor((NOV_MIDDAY + 999) / SECONDS),
        );
    });
});

describe('quotaRetryAfterSeconds', () => {
    it('returns the remaining seconds mid-month', () => {
        const err = makeError();

        expect(quotaRetryAfterSeconds(err, NOV_MIDDAY)).toBe(15 * 86_400 + 43_200);
    });

    it('returns a full month of seconds at an exact month start', () => {
        // Standing exactly on 2026-12-01T00:00:00Z, the next reset is
        // 2027-01-01T00:00:00Z — December has 31 days.
        const err = makeError({ periodKey: '2026-12', resetsAt: JAN_2027 / SECONDS });

        expect(quotaRetryAfterSeconds(err, DEC_2026)).toBe(31 * 86_400);
    });

    it('never drops below 1 for a skewed resetsAt in the past', () => {
        const nowMs = DEC_2026;
        const err = makeError({ resetsAt: nowMs / SECONDS - 3_600 });

        expect(quotaRetryAfterSeconds(err, nowMs)).toBe(1);
    });

    it('floors the current instant instead of rounding it forward', () => {
        const err = makeError({ resetsAt: DEC_2026 / SECONDS });

        // 500 ms before the reset still yields a whole second, not zero.
        expect(quotaRetryAfterSeconds(err, DEC_2026 - 500)).toBe(1);
    });

    it('delegates to the single shared formula, so the two transports cannot drift', () => {
        const err = makeError();

        expect(quotaRetryAfterSeconds(err, NOV_MIDDAY)).toBe(
            secondsUntilInstant(err.detail.resetsAt, NOV_MIDDAY),
        );
        expect(quotaRetryAfterSeconds(err, DEC_2026)).toBe(
            secondsUntilInstant(err.detail.resetsAt, DEC_2026),
        );
    });
});

describe('openAiQuotaErrorBody', () => {
    it('carries the alias, the limit-derived message and the raw resets_at', () => {
        const err = makeError();
        const body = openAiQuotaErrorBody(err);

        expect(body.error.alias).toBe('codex');
        expect(body.error.resets_at).toBe(DEC_2026 / SECONDS);
        expect(body.error.message).toContain('codex');
        expect(body.error.message).toContain('20000000');
        expect(body.error.message).toContain('2026-12-01');
    });

    it('keeps the OpenAI-compatible discriminator and our own machine code', () => {
        const body = openAiQuotaErrorBody(makeError());

        // `type` is the field OpenAI clients (Kilo, OpenCode) switch on;
        // `code` is OUR token for logs and dashboards.
        expect(body.error.type).toBe('insufficient_quota');
        expect(body.error.code).toBe('quota_exhausted');
    });
});

describe('anthropicQuotaErrorBody', () => {
    it('carries the alias, the limit-derived message and the reset instant', () => {
        const body = anthropicQuotaErrorBody(makeError());

        expect(body.type).toBe('error');
        expect(body.error.type).toBe('rate_limit_error');
        expect(body.error.message).toContain('codex');
        expect(body.error.message).toContain('20000000');
        expect(body.error.message).toContain('2026-12-01');
    });
});

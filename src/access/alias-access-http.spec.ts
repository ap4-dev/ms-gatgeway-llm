import { AliasNotPermittedError } from './alias-access.errors';
import {
    aliasForbiddenMessage,
    anthropicAliasForbiddenBody,
    openAiAliasForbiddenBody,
} from './alias-access-http';

function forbidden(aliasKey = 'codex', clientId: string | null = 'client-1'): AliasNotPermittedError {
    return new AliasNotPermittedError({ clientId, aliasKey });
}

describe('alias-access-http', () => {
    describe('the message', () => {
        it('names the requested alias and says it is not permitted', () => {
            const message = aliasForbiddenMessage(forbidden('codex'));

            expect(message).toContain('codex');
            expect(message).toContain('not permitted');
        });

        it('is IDENTICAL for both protocols (one message source)', () => {
            const err = forbidden('codex');
            const openAi = openAiAliasForbiddenBody(err) as any;
            const anthropic = anthropicAliasForbiddenBody(err) as any;

            expect(openAi.error.message).toBe(aliasForbiddenMessage(err));
            expect(anthropic.error.message).toBe(aliasForbiddenMessage(err));
        });

        it('never enumerates what IS permitted (no allowlist leak)', () => {
            // The error deliberately carries no allowlist, and the message must
            // not invent one: telling a client which aliases it may use turns the
            // 403 into a directory of the fleet.
            const message = aliasForbiddenMessage(forbidden('codex'));

            expect(message).not.toMatch(/allowed|available|permitted aliases|you may use/i);
            // Exactly one alias name appears: the one that was asked for.
            expect(message.match(/"[^"]+"/g)).toEqual(['"codex"']);
        });

        it('does not hint at whether the alias exists in the registry', () => {
            // A message like "unknown model" would let a restricted client probe
            // the registry for alias names; the 403 must not answer that question.
            const message = aliasForbiddenMessage(forbidden('ghost'));

            expect(message).not.toMatch(/unknown|not found|does not exist|registry/i);
        });
    });

    describe('openAiAliasForbiddenBody', () => {
        it('renders an OpenAI-compatible 403 body', () => {
            const body = openAiAliasForbiddenBody(forbidden('codex'));

            expect(body.error.type).toBe('permission_error');
            expect(body.error.code).toBe('alias_not_permitted');
            expect(body.error.alias).toBe('codex');
            expect(body.error.message).toContain('codex');
        });

        it('carries no quota fields (this is not a quota error)', () => {
            const body = openAiAliasForbiddenBody(forbidden('codex')) as any;

            expect(body.error).not.toHaveProperty('resets_at');
            expect(JSON.stringify(body)).not.toContain('insufficient_quota');
            expect(JSON.stringify(body)).not.toContain('quota_exhausted');
        });
    });

    describe('anthropicAliasForbiddenBody', () => {
        it('renders an Anthropic-style 403 body', () => {
            const body = anthropicAliasForbiddenBody(forbidden('codex'));

            expect(body.type).toBe('error');
            expect(body.error.type).toBe('permission_error');
            expect(body.error.message).toContain('codex');
        });

        it('uses permission_error, not rate_limit_error (the quota discriminator)', () => {
            const body = anthropicAliasForbiddenBody(forbidden('codex'));

            expect(body.error.type).not.toBe('rate_limit_error');
        });
    });
});

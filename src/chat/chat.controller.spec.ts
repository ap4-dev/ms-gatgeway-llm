import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { QuotaExhaustedError } from '../quota/quota.errors';
import { AliasNotPermittedError } from '../access/alias-access.errors';

const DEC_2026 = Date.UTC(2026, 11, 1);
const SECONDS = 1000;
const NOW_MS = Date.UTC(2026, 10, 15, 12, 0, 0);

function quotaError(): QuotaExhaustedError {
    return new QuotaExhaustedError({
        clientId: 'client-1',
        aliasKey: 'codex',
        periodKey: '2026-11',
        limit: 20_000_000,
        used: 20_500_000,
        resetsAt: DEC_2026 / SECONDS,
    });
}

type FakeRaw = {
    statusCode: number;
    headers: Record<string, string | number>;
    written: string[];
    ended: boolean;
    /** Node flips this to `true` on the first flushed byte. */
    headersSent: boolean;
    setHeader: (name: string, value: string | number) => void;
    write: (chunk: string) => boolean;
    end: () => void;
};

function makeReply(opts: { headersSent?: boolean } = {}) {
    const raw: FakeRaw = {
        statusCode: 200,
        headers: {},
        written: [],
        ended: false,
        headersSent: opts.headersSent ?? false,
        setHeader(name, value) {
            raw.headers[name] = value;
        },
        write(chunk) {
            raw.written.push(chunk);
            return true;
        },
        end() {
            raw.ended = true;
        },
    };

    const reply = {
        statusCode: 200,
        headers: {} as Record<string, string>,
        sent: undefined as unknown,
        raw,
        code: jest.fn((code: number) => {
            reply.statusCode = code;
            return reply;
        }),
        header: jest.fn((name: string, value: string) => {
            reply.headers[name] = value;
            return reply;
        }),
        send: jest.fn((payload: unknown) => {
            reply.sent = payload;
            return reply;
        }),
        hijack: jest.fn(),
    };

    return reply;
}

function makeController(completions: jest.Mock): {
    controller: ChatController;
    chat: { completions: jest.Mock };
} {
    const chat = { completions };
    const controller = new ChatController(chat as unknown as ChatService);
    return { controller, chat };
}

function makeRequest() {
    return { client: { id: 'client-1' } } as any;
}

function aliasForbiddenError(aliasKey = 'slave'): AliasNotPermittedError {
    return new AliasNotPermittedError({ clientId: 'client-1', aliasKey });
}

describe('ChatController quota mapping', () => {
    beforeEach(() => {
        jest.spyOn(Date, 'now').mockReturnValue(NOW_MS);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('maps QuotaExhaustedError to 429 with Retry-After when not streaming', async () => {
        const completions = jest.fn(async () => {
            throw quotaError();
        });
        const { controller } = makeController(completions);
        const reply = makeReply();

        await controller.completions({ model: 'codex' } as any, makeRequest(), reply as any);

        expect(reply.code).toHaveBeenCalledWith(429);
        expect(reply.header).toHaveBeenCalledWith('Retry-After', String(15 * 86_400 + 43_200));
        expect(reply.send).toHaveBeenCalledTimes(1);
        expect(reply.sent).toMatchObject({
            error: {
                type: 'insufficient_quota',
                code: 'quota_exhausted',
                alias: 'codex',
                resets_at: DEC_2026 / SECONDS,
            },
        });
        expect((reply.sent as any).error.message).toContain('codex');
    });

    it('maps QuotaExhaustedError to a 429 SSE frame when streaming', async () => {
        const completions = jest.fn(async () => {
            throw quotaError();
        });
        const { controller } = makeController(completions);
        const reply = makeReply();

        await controller.completions(
            { model: 'codex', stream: true } as any,
            makeRequest(),
            reply as any,
        );

        expect(reply.hijack).toHaveBeenCalledTimes(1);
        expect(reply.raw.statusCode).toBe(429);
        expect(reply.raw.headers['Retry-After']).toBe(String(15 * 86_400 + 43_200));
        expect(reply.raw.written).toHaveLength(1);
        expect(reply.raw.written[0]).toMatch(/^data: .*\n\n$/);
        const payload = JSON.parse(reply.raw.written[0].replace(/^data: /, '').trim());
        expect(payload.error.alias).toBe('codex');
        expect(payload.error.type).toBe('insufficient_quota');
        expect(reply.raw.ended).toBe(true);
    });

    it('claims the 429 and Retry-After on a streamed quota error while no byte is flushed', async () => {
        // R3-002: the claim is only truthful before the status line leaves.
        const completions = jest.fn(async () => {
            throw quotaError();
        });
        const { controller } = makeController(completions);
        const reply = makeReply({ headersSent: false });

        await controller.completions(
            { model: 'codex', stream: true } as any,
            makeRequest(),
            reply as any,
        );

        expect(reply.raw.statusCode).toBe(429);
        expect(reply.raw.headers['Retry-After']).toBe(String(15 * 86_400 + 43_200));
        expect(reply.raw.written).toHaveLength(1);
        expect(reply.raw.written[0]).toMatch(/^data: .*\n\n$/);
        const payload = JSON.parse(reply.raw.written[0].replace(/^data: /, '').trim());
        expect(payload.error.code).toBe('quota_exhausted');
        expect(reply.raw.ended).toBe(true);
    });

    it('writes the quota frame but never rewrites status or headers once bytes are gone', async () => {
        // The 200 is already on the wire: assigning 429 here would only
        // pretend, so the client must learn the reason from the frame alone.
        const completions = jest.fn(async () => {
            throw quotaError();
        });
        const { controller } = makeController(completions);
        const reply = makeReply({ headersSent: true });

        await controller.completions(
            { model: 'codex', stream: true } as any,
            makeRequest(),
            reply as any,
        );

        expect(reply.raw.statusCode).toBe(200);
        expect(reply.raw.headers['Retry-After']).toBeUndefined();
        expect(reply.raw.written).toHaveLength(1);
        const payload = JSON.parse(reply.raw.written[0].replace(/^data: /, '').trim());
        expect(payload.error.code).toBe('quota_exhausted');
        expect(payload.error.alias).toBe('codex');
        expect(reply.raw.ended).toBe(true);
    });

    it('keeps the generic 500 for every non-quota error (non-streaming)', async () => {
        const completions = jest.fn(async () => {
            throw new Error('upstream exploded');
        });
        const { controller } = makeController(completions);
        const reply = makeReply();

        await controller.completions({ model: 'codex' } as any, makeRequest(), reply as any);

        expect(reply.code).toHaveBeenCalledWith(500);
        expect(reply.header).not.toHaveBeenCalled();
        expect(reply.sent).toEqual({ error: { message: 'upstream exploded' } });
        expect(reply.send).toHaveBeenCalledTimes(1);
    });

    it('keeps the generic SSE error frame for every non-quota error (streaming)', async () => {
        const completions = jest.fn(async () => {
            throw new Error('upstream exploded');
        });
        const { controller } = makeController(completions);
        const reply = makeReply();

        await controller.completions(
            { model: 'codex', stream: true } as any,
            makeRequest(),
            reply as any,
        );

        expect(reply.raw.statusCode).toBe(200);
        expect(reply.raw.written).toEqual([
            `data: ${JSON.stringify({ error: { message: 'upstream exploded' } })}\n\n`,
        ]);
        expect(reply.raw.ended).toBe(true);
    });

    it('still streams chunks normally when the quota is not exhausted', async () => {
        const completions = jest.fn(async () =>
            (async function* () {
                yield { id: 'chunk-1' };
            })(),
        );
        const { controller } = makeController(completions);
        const reply = makeReply();

        await controller.completions(
            { model: 'codex', stream: true } as any,
            makeRequest(),
            reply as any,
        );

        expect(reply.raw.statusCode).toBe(200);
        expect(reply.raw.written).toEqual([
            `data: ${JSON.stringify({ id: 'chunk-1' })}\n\n`,
            'data: [DONE]\n\n',
        ]);
        expect(reply.raw.ended).toBe(true);
    });
});

/**
 * The allowlist 403 is a DIFFERENT failure from the quota 429 and must stay
 * distinguishable: `permission_error` + `alias_not_permitted`, no `Retry-After`
 * (waiting does not help — only an operator granting the alias does), and the
 * same status/frame discipline on an already-hijacked SSE response.
 */
describe('ChatController alias-forbidden mapping', () => {
    beforeEach(() => {
        jest.spyOn(Date, 'now').mockReturnValue(NOW_MS);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('maps AliasNotPermittedError to a 403 with the OpenAI-compatible body', async () => {
        const completions = jest.fn(async () => {
            throw aliasForbiddenError('slave');
        });
        const { controller } = makeController(completions);
        const reply = makeReply();

        await controller.completions(
            { model: 'slave' } as any,
            makeRequest(),
            reply as any,
        );

        expect(reply.code).toHaveBeenCalledWith(403);
        expect(reply.send).toHaveBeenCalledTimes(1);
        expect(reply.sent).toMatchObject({
            error: {
                type: 'permission_error',
                code: 'alias_not_permitted',
                alias: 'slave',
            },
        });
        expect((reply.sent as any).error.message).toContain('slave');
    });

    it('never sets Retry-After on a 403 (waiting does not fix a permission)', async () => {
        const completions = jest.fn(async () => {
            throw aliasForbiddenError();
        });
        const { controller } = makeController(completions);
        const reply = makeReply();

        await controller.completions(
            { model: 'slave' } as any,
            makeRequest(),
            reply as any,
        );

        expect(reply.header).not.toHaveBeenCalled();
    });

    it('claims the 403 on a streamed forbidden alias while no byte is flushed', async () => {
        const completions = jest.fn(async () => {
            throw aliasForbiddenError('slave');
        });
        const { controller } = makeController(completions);
        const reply = makeReply({ headersSent: false });

        await controller.completions(
            { model: 'slave', stream: true } as any,
            makeRequest(),
            reply as any,
        );

        expect(reply.hijack).toHaveBeenCalledTimes(1);
        expect(reply.raw.statusCode).toBe(403);
        expect(reply.raw.headers['Retry-After']).toBeUndefined();
        expect(reply.raw.written).toHaveLength(1);
        const payload = JSON.parse(reply.raw.written[0].replace(/^data: /, '').trim());
        expect(payload.error.code).toBe('alias_not_permitted');
        expect(reply.raw.ended).toBe(true);
    });

    it('writes the 403 frame but never rewrites status once bytes are gone', async () => {
        const completions = jest.fn(async () => {
            throw aliasForbiddenError('slave');
        });
        const { controller } = makeController(completions);
        const reply = makeReply({ headersSent: true });

        await controller.completions(
            { model: 'slave', stream: true } as any,
            makeRequest(),
            reply as any,
        );

        expect(reply.raw.statusCode).toBe(200);
        expect(reply.raw.written).toHaveLength(1);
        const payload = JSON.parse(reply.raw.written[0].replace(/^data: /, '').trim());
        expect(payload.error.type).toBe('permission_error');
        expect(reply.raw.ended).toBe(true);
    });

    it('keeps the quota 429 and the alias 403 apart', async () => {
        const quota = makeController(async () => {
            throw quotaError();
        });
        const quotaReply = makeReply();
        await quota.controller.completions(
            { model: 'codex' } as any,
            makeRequest(),
            quotaReply as any,
        );

        const forbidden = makeController(async () => {
            throw aliasForbiddenError('codex');
        });
        const forbiddenReply = makeReply();
        await forbidden.controller.completions(
            { model: 'codex' } as any,
            makeRequest(),
            forbiddenReply as any,
        );

        expect(quotaReply.statusCode).toBe(429);
        expect(forbiddenReply.statusCode).toBe(403);
        expect((forbiddenReply.sent as any).error.code).not.toBe('quota_exhausted');
    });
});

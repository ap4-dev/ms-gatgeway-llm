import { AnthropicController } from './anthropic.controller';
import type { AnthropicService } from './anthropic.service';
import { QuotaExhaustedError } from '../quota/quota.errors';
import { AliasNotPermittedError } from '../access/alias-access.errors';

const DEC_2026 = Date.UTC(2026, 11, 1);
const SECONDS = 1000;
const NOW_MS = Date.UTC(2026, 10, 15, 12, 0, 0);
const RETRY_AFTER = String(15 * 86_400 + 43_200);

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

function aliasForbiddenError(aliasKey = 'slave'): AliasNotPermittedError {
    return new AliasNotPermittedError({ clientId: 'client-1', aliasKey });
}

/** Smallest body that satisfies `AnthropicMessagesSchema`. */
function validBody(stream = false): any {
    return {
        model: 'claude-sonnet-4',
        max_tokens: 256,
        messages: [{ role: 'user', content: 'hola' }],
        ...(stream ? { stream: true } : {}),
    };
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

/**
 * Fake reply following the style used in `chat.controller.spec.ts`, but the
 * fake `write` flips `headersSent` like a real `ServerResponse` so the
 * "status already left the building" path is reachable without a socket.
 */
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
            raw.headersSent = true;
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

function makeController(messages: jest.Mock): {
    controller: AnthropicController;
    anthropic: { messages: jest.Mock };
} {
    const anthropic = { messages };
    const controller = new AnthropicController(
        anthropic as unknown as AnthropicService,
    );
    return { controller, anthropic };
}

function makeRequest() {
    return { client: { id: 'client-1' } } as any;
}

describe('AnthropicController quota mapping', () => {
    beforeEach(() => {
        jest.spyOn(Date, 'now').mockReturnValue(NOW_MS);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('maps a non-streaming QuotaExhaustedError to 429 + Retry-After + Anthropic body', async () => {
        const messages = jest.fn(async () => {
            throw quotaError();
        });
        const { controller, anthropic } = makeController(messages);
        const reply = makeReply();

        await controller.messages(validBody(), makeRequest(), reply as any);

        expect(anthropic.messages).toHaveBeenCalledTimes(1);
        expect(reply.code).toHaveBeenCalledWith(429);
        expect(reply.header).toHaveBeenCalledWith('Retry-After', RETRY_AFTER);
        expect(reply.send).toHaveBeenCalledTimes(1);
        expect(reply.sent).toEqual({
            type: 'error',
            error: {
                type: 'rate_limit_error',
                message: expect.stringContaining('codex'),
            },
        });
        expect((reply.sent as any).error.message).toContain('2026-12-01');
    });

    it('claims the 429 on a streamed quota error while no byte is flushed', async () => {
        const messages = jest.fn(async () => {
            throw quotaError();
        });
        const { controller } = makeController(messages);
        const reply = makeReply();

        await controller.messages(validBody(true), makeRequest(), reply as any);

        expect(reply.hijack).toHaveBeenCalledTimes(1);
        expect(reply.raw.statusCode).toBe(429);
        expect(reply.raw.headers['Retry-After']).toBe(RETRY_AFTER);
        expect(reply.raw.written).toHaveLength(2);
        expect(reply.raw.written[0]).toBe('event: error\n');
        expect(reply.raw.written[1]).toMatch(/^data: .*\n\n$/);
        const payload = JSON.parse(
            reply.raw.written[1].replace(/^data: /, '').trim(),
        );
        expect(payload).toMatchObject({
            type: 'error',
            error: { type: 'rate_limit_error' },
        });
        expect(reply.raw.ended).toBe(true);
    });

    it('writes the quota frame but never rewrites status or headers once bytes are gone', async () => {
        // A stream that emitted one event before hitting the quota gate: the
        // 200 is on the wire, so only the frame can carry the reason.
        const messages = jest.fn(async () => {
            return (async function* () {
                yield { type: 'message_start', message: { id: 'msg-1' } };
                throw quotaError();
            })();
        });
        const { controller } = makeController(messages);
        const reply = makeReply();

        await controller.messages(validBody(true), makeRequest(), reply as any);

        // Two frames for the yielded event, one for the error.
        expect(reply.raw.written[0]).toBe('event: message_start\n');
        expect(reply.raw.headersSent).toBe(true);
        expect(reply.raw.statusCode).toBe(200);
        expect(reply.raw.headers['Retry-After']).toBeUndefined();
        expect(reply.raw.written).toHaveLength(4);
        expect(reply.raw.written[2]).toBe('event: error\n');
        const payload = JSON.parse(
            reply.raw.written[3].replace(/^data: /, '').trim(),
        );
        expect(payload).toMatchObject({
            type: 'error',
            error: { type: 'rate_limit_error' },
        });
        expect(payload.error.message).toContain('codex');
        expect(reply.raw.ended).toBe(true);
    });

    it('keeps the generic 500 api_error for non-quota failures (non-streaming)', async () => {
        const messages = jest.fn(async () => {
            throw new Error('upstream exploded');
        });
        const { controller } = makeController(messages);
        const reply = makeReply();

        await controller.messages(validBody(), makeRequest(), reply as any);

        expect(reply.code).toHaveBeenCalledWith(500);
        expect(reply.header).not.toHaveBeenCalled();
        expect(reply.sent).toEqual({
            type: 'error',
            error: { type: 'api_error', message: 'upstream exploded' },
        });
    });

    it('keeps the generic api_error frame for non-quota failures (streaming)', async () => {
        const messages = jest.fn(async () => {
            throw new Error('upstream exploded');
        });
        const { controller } = makeController(messages);
        const reply = makeReply();

        await controller.messages(validBody(true), makeRequest(), reply as any);

        expect(reply.raw.statusCode).toBe(200);
        expect(reply.raw.written).toEqual([
            'event: error\n',
            `data: ${JSON.stringify({
                type: 'error',
                error: { type: 'api_error', message: 'upstream exploded' },
            })}\n\n`,
        ]);
        expect(reply.raw.ended).toBe(true);
    });
});

/**
 * The allowlist 403 in Anthropic's vocabulary: `permission_error`, not the
 * `rate_limit_error` the quota 429 uses. A client that cannot tell the two apart
 * would retry a permission failure as if it were a temporary limit.
 */
describe('AnthropicController alias-forbidden mapping', () => {
    beforeEach(() => {
        jest.spyOn(Date, 'now').mockReturnValue(NOW_MS);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('maps AliasNotPermittedError to a 403 with the Anthropic permission_error body', async () => {
        const messages = jest.fn(async () => {
            throw aliasForbiddenError('slave');
        });
        const { controller } = makeController(messages);
        const reply = makeReply();

        await controller.messages(validBody(), makeRequest(), reply as any);

        expect(reply.code).toHaveBeenCalledWith(403);
        expect(reply.send).toHaveBeenCalledTimes(1);
        expect(reply.sent).toEqual({
            type: 'error',
            error: {
                type: 'permission_error',
                message: expect.stringContaining('slave'),
            },
        });
    });

    it('never sets Retry-After on a 403', async () => {
        const messages = jest.fn(async () => {
            throw aliasForbiddenError();
        });
        const { controller } = makeController(messages);
        const reply = makeReply();

        await controller.messages(validBody(), makeRequest(), reply as any);

        expect(reply.header).not.toHaveBeenCalled();
    });

    it('claims the 403 on a streamed forbidden alias while no byte is flushed', async () => {
        const messages = jest.fn(async () => {
            throw aliasForbiddenError('slave');
        });
        const { controller } = makeController(messages);
        const reply = makeReply({ headersSent: false });

        await controller.messages(validBody(true), makeRequest(), reply as any);

        expect(reply.hijack).toHaveBeenCalledTimes(1);
        expect(reply.raw.statusCode).toBe(403);
        expect(reply.raw.headers['Retry-After']).toBeUndefined();
        // Anthropic SSE frames are `event:` + `data:`; the 403 uses the error event.
        expect(reply.raw.written[0]).toBe('event: error\n');
        const payload = JSON.parse(
            reply.raw.written[1].replace(/^data: /, '').trim(),
        );
        expect(payload.error.type).toBe('permission_error');
        expect(reply.raw.ended).toBe(true);
    });

    it('writes the 403 frame but never rewrites status once bytes are gone', async () => {
        const messages = jest.fn(async () => {
            throw aliasForbiddenError('slave');
        });
        const { controller } = makeController(messages);
        const reply = makeReply({ headersSent: true });

        await controller.messages(validBody(true), makeRequest(), reply as any);

        expect(reply.raw.statusCode).toBe(200);
        expect(reply.raw.written[0]).toBe('event: error\n');
        expect(reply.raw.ended).toBe(true);
    });

    it('keeps the quota 429 and the alias 403 apart', async () => {
        const quota = makeController(async () => {
            throw quotaError();
        });
        const quotaReply = makeReply();
        await quota.controller.messages(validBody(), makeRequest(), quotaReply as any);

        const forbidden = makeController(async () => {
            throw aliasForbiddenError('codex');
        });
        const forbiddenReply = makeReply();
        await forbidden.controller.messages(validBody(), makeRequest(), forbiddenReply as any);

        expect(quotaReply.statusCode).toBe(429);
        expect(forbiddenReply.statusCode).toBe(403);
        expect((quotaReply.sent as any).error.type).toBe('rate_limit_error');
        expect((forbiddenReply.sent as any).error.type).toBe('permission_error');
    });
});

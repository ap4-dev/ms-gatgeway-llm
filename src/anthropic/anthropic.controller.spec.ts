import { AnthropicController } from './anthropic.controller';
import type { AnthropicService } from './anthropic.service';
import { QuotaExhaustedError } from '../quota/quota.errors';

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

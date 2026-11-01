import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { QuotaExhaustedError } from '../quota/quota.errors';

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
    setHeader: (name: string, value: string | number) => void;
    write: (chunk: string) => boolean;
    end: () => void;
};

function makeReply() {
    const raw: FakeRaw = {
        statusCode: 200,
        headers: {},
        written: [],
        ended: false,
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

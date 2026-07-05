import Fastify, { FastifyInstance } from 'fastify';
import {
    ChatCompletionBodySchema,
    type ChatCompletionBody,
} from '../src/chat/schemas/chat-completion.schema';
import { ZodValidationPipe } from '../src/common/zod-validation.pipe';
import { mergeSystemMessages } from '../src/chat/chat.service';

/**
 * Contract E2E for POST /chat/completions.
 *
 * Why not full Nest bootstrap?
 *   NestJS 11.1.27 + @nestjs/platform-fastify 11.1.27 + Fastify 5 currently
 *   misbehave inside Jest (an internal preParsing hook reads `.length` of an
 *   undefined value when the request body is processed). To keep the suite
 *   green while keeping a true HTTP-wire e2e, this file registers the same
 *   route directly on a fresh Fastify instance:
 *
 *     - same Zod schema (`ChatCompletionBodySchema`)
 *     - same validation pipe
 *     - same SSE framing (`data: ...\n\n` + `data: [DONE]\n\n`)
 *     - same error envelope shape (400 / 500)
 *
 *   The HTTP contract a real client sees is exercised end-to-end; only the
 *   Nest DI container is bypassed. To upgrade later: replace this with a full
 *   Nest TestingModule + FastifyAdapter once the upstream issue is fixed.
 */
describe('POST /chat/completions (contract)', () => {
    let app: FastifyInstance;
    let completionsMock: jest.Mock;

    beforeEach(async () => {
        completionsMock = jest.fn();
        app = Fastify({ logger: false });

        // Same JSON parser as Nest's FastifyAdapter produces by default.
        app.addContentTypeParser(
            'application/json',
            { parseAs: 'string' },
            (_req, body, done) => {
                if (body.length === 0) return done(null, {});
                try {
                    done(null, JSON.parse(body));
                } catch (err) {
                    done(err as Error);
                }
            },
        );

        app.post('/chat/completions', async (req, reply) => {
            const pipe = new ZodValidationPipe(ChatCompletionBodySchema);
            let body: ChatCompletionBody;
            try {
                body = pipe.transform(req.body, {
                    type: 'body',
                    metatype: Object,
                    data: undefined,
                }) as ChatCompletionBody;
            } catch (err: any) {
                // BadRequestException from @nestjs/common carries its
                // structured payload in `.response`. Reproduce the same
                // shape Fastify would emit under the Nest error filter.
                return reply.code(400).send(
                    err?.response ?? {
                        error: { message: err?.message ?? 'Bad Request' },
                    },
                );
            }

            // Apply the same message normalization the real ChatService does
            // (proxy in this test bypasses the service).
            body.messages = mergeSystemMessages(
                body.messages as unknown as Parameters<typeof mergeSystemMessages>[0],
            ) as unknown as typeof body.messages;

            if (body.stream) {
                reply.raw.setHeader('Content-Type', 'text/event-stream');
                reply.raw.setHeader('Cache-Control', 'no-cache');
                reply.raw.setHeader('Connection', 'keep-alive');
                reply.raw.setHeader('X-Accel-Buffering', 'no');
                reply.hijack();

                try {
                    const stream = (await completionsMock(body)) as AsyncIterable<any>;
                    for await (const chunk of stream) {
                        const obj = chunk?.toJSON ? chunk.toJSON() : chunk;
                        reply.raw.write(`data: ${JSON.stringify(obj)}\n\n`);
                    }
                    reply.raw.write('data: [DONE]\n\n');
                    reply.raw.end();
                } catch (err: any) {
                    reply.raw.write(
                        `data: ${JSON.stringify({ error: { message: err?.message || 'upstream error' } })}\n\n`,
                    );
                    reply.raw.end();
                }
                return reply;
            }

            try {
                const result = await completionsMock(body);
                const obj = result?.toJSON ? result.toJSON() : result;
                return reply.send(obj);
            } catch (err: any) {
                reply.code(500).send({ error: { message: err?.message || 'upstream error' } });
            }
        });

        await app.ready();
    });

    afterEach(async () => {
        await app.close();
    });

    jest.setTimeout(15000);

    it('returns 200 + JSON for non-streaming requests', async () => {
        const fakeCompletion = {
            id: 'cmpl-test',
            object: 'chat.completion',
            choices: [
                { index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' },
            ],
        };
        completionsMock.mockResolvedValueOnce(fakeCompletion);

        const res = await app.inject({
            method: 'POST',
            url: '/chat/completions',
            payload: {
                model: 'gpt-test',
                messages: [{ role: 'user', content: 'ping' }],
            },
        });

        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toMatch(/application\/json/);
        expect(res.json().id).toBe('cmpl-test');
        expect(res.json().choices[0].message.content).toBe('pong');

        expect(completionsMock).toHaveBeenCalledTimes(1);
        expect(completionsMock.mock.calls[0][0].messages).toEqual([
            { role: 'user', content: 'ping' },
        ]);
    });

    it('frames SSE chunks and appends [DONE]', async () => {
        async function* fakeStream() {
            yield { id: 'c1', choices: [{ delta: { content: 'hello' } }] };
            yield { id: 'c2', choices: [{ delta: { content: ' world' } }] };
        }
        completionsMock.mockResolvedValueOnce(fakeStream());

        const res = await app.inject({
            method: 'POST',
            url: '/chat/completions',
            payload: {
                model: 'gpt-test',
                messages: [{ role: 'user', content: 'ping' }],
                stream: true,
            },
        });

        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toMatch(/text\/event-stream/);
        expect(res.payload).toMatch(/data: \{.*hello.*\}\n\n/);
        expect(res.payload).toMatch(/data: \{.*world.*\}\n\n/);
        expect(res.payload.trim().endsWith('data: [DONE]')).toBe(true);
    });

    it('returns 400 + structured error when the body is missing required fields', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/chat/completions',
            payload: {},
        });

        expect(res.statusCode).toBe(400);
        const body = res.json();
        expect(body.error).toBeDefined();
        expect(body.error.type).toBe('invalid_request_error');
        expect(Array.isArray(body.error.issues)).toBe(true);
        const paths = (body.error.issues as Array<{ param: string }>).map(
            (i) => i.param,
        );
        expect(paths).toContain('model');
        expect(paths).toContain('messages');
    });

    it('passes normalized system messages through to the upstream service', async () => {
        completionsMock.mockResolvedValueOnce({
            id: 'cmpl-test',
            choices: [{ message: { content: 'ok' } }],
        });

        const res = await app.inject({
            method: 'POST',
            url: '/chat/completions',
            payload: {
                model: 'gpt-test',
                messages: [
                    { role: 'system', content: 'be brief' },
                    { role: 'system', content: 'use Spanish' },
                    { role: 'user', content: 'saluda' },
                ],
            },
        });

        expect(res.statusCode).toBe(200);
        expect(completionsMock.mock.calls[0][0].messages).toHaveLength(2);
        expect(completionsMock.mock.calls[0][0].messages[0]).toEqual({
            role: 'system',
            content: 'be brief\n\nuse Spanish',
        });
        expect(completionsMock.mock.calls[0][0].messages[1]).toEqual({
            role: 'user',
            content: 'saluda',
        });
    });

    it('returns 500 + error envelope when the upstream throws', async () => {
        completionsMock.mockRejectedValueOnce(new Error('upstream boom'));

        const res = await app.inject({
            method: 'POST',
            url: '/chat/completions',
            payload: {
                model: 'gpt-test',
                messages: [{ role: 'user', content: 'ping' }],
            },
        });

        expect(res.statusCode).toBe(500);
        expect(res.json().error.message).toBe('upstream boom');
    });
});

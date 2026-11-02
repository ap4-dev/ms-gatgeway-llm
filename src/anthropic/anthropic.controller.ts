import {
    Body,
    Controller,
    Post,
    Req,
    Res,
    UseGuards,
    Logger,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AnthropicService } from './anthropic.service';
import {
    AnthropicMessagesSchema,
} from './schemas/messages.schema';
import { ApiKeyAuthGuard } from '../auth/api-key.guard';
import { RateLimitGuard } from '../ratelimit/rate-limit.guard';
import type { Client } from '../auth/client.repository';
import type { AnthropicStreamEvent } from './types';
import { QuotaExhaustedError } from '../quota/quota.errors';
import {
    anthropicQuotaErrorBody,
    quotaRetryAfterSeconds,
} from '../quota/quota-http';
import { AliasNotPermittedError } from '../access/alias-access.errors';
import { anthropicAliasForbiddenBody } from '../access/alias-access-http';

@Controller('v1/messages')
@UseGuards(ApiKeyAuthGuard, RateLimitGuard)
export class AnthropicController {
    private readonly logger = new Logger(AnthropicController.name);

    constructor(private readonly anthropic: AnthropicService) {}

    @Post()
    async messages(
        @Body() rawBody: unknown,
        @Req() req: FastifyRequest & { client?: Client },
        @Res() reply: FastifyReply,
    ) {
        const clientId = req.client?.id ?? null;

        // Manual validation with logging for debugging
        const parsed = AnthropicMessagesSchema.safeParse(rawBody);
        if (!parsed.success) {
            this.logger.error(`Zod validation failed: ${JSON.stringify(parsed.error.issues)}`);
            this.logger.error(`Raw body: ${JSON.stringify(rawBody).substring(0, 2000)}`);
            return reply.code(400).send({
                type: 'error',
                error: {
                    type: 'invalid_request_error',
                    message: 'Invalid request body',
                    issues: parsed.error.issues.map((i) => ({
                        path: i.path.join('.'),
                        message: i.message,
                    })),
                },
            });
        }

        const body = parsed.data;

        if (body.stream) {
            reply.raw.setHeader('Content-Type', 'text/event-stream');
            reply.raw.setHeader('Cache-Control', 'no-cache');
            reply.raw.setHeader('Connection', 'keep-alive');
            reply.raw.setHeader('X-Accel-Buffering', 'no');
            reply.hijack();

            try {
                const generator = (await this.anthropic.messages(
                    body,
                    clientId,
                )) as AsyncGenerator<AnthropicStreamEvent>;

                for await (const event of generator) {
                    reply.raw.write(`event: ${event.type}\n`);
                    reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
                }
                reply.raw.end();
            } catch (err: any) {
                if (err instanceof QuotaExhaustedError) {
                    this.writeQuotaErrorFrame(reply, err);
                } else if (err instanceof AliasNotPermittedError) {
                    this.writeAliasForbiddenFrame(reply, err);
                } else {
                    reply.raw.write(`event: error\n`);
                    reply.raw.write(
                        `data: ${JSON.stringify({
                            type: 'error',
                            error: {
                                type: 'api_error',
                                message: err?.message || 'upstream error',
                            },
                        })}\n\n`,
                    );
                    reply.raw.end();
                }
            }
            return reply;
        }

        try {
            const result = await this.anthropic.messages(body, clientId);
            return reply.send(result);
        } catch (err: any) {
            if (err instanceof QuotaExhaustedError) {
                return reply
                    .code(429)
                    .header('Retry-After', String(quotaRetryAfterSeconds(err)))
                    .send(anthropicQuotaErrorBody(err));
            }
            if (err instanceof AliasNotPermittedError) {
                // 403 with NO `Retry-After`: waiting cannot grant a permission.
                return reply
                    .code(403)
                    .send(anthropicAliasForbiddenBody(err));
            }
            return reply.code(500).send({
                type: 'error',
                error: {
                    type: 'api_error',
                    message: err?.message || 'upstream error',
                },
            });
        }
    }

    /**
     * Emit the quota error frame on an already-hijacked Anthropic SSE response.
     *
     * The 429 claim is only truthful while the status line is still unflushed:
     * `reply.raw.statusCode` is applied when headers are written, so assigning
     * it after the first byte is silently ignored and the client keeps the 200
     * it already received. Hence the `headersSent` guard — once the bytes are
     * gone the frame is the only channel left to explain the cut, and writing
     * it unconditionally keeps that explanation coming.
     */
    private writeQuotaErrorFrame(
        reply: FastifyReply,
        err: QuotaExhaustedError,
    ): void {
        if (!reply.raw.headersSent) {
            reply.raw.statusCode = 429;
            reply.raw.setHeader(
                'Retry-After',
                String(quotaRetryAfterSeconds(err)),
            );
        }
        reply.raw.write(`event: error\n`);
        reply.raw.write(
            `data: ${JSON.stringify(anthropicQuotaErrorBody(err))}\n\n`,
        );
        reply.raw.end();
    }

    /**
     * Emit the allowlist 403 frame on an already-hijacked Anthropic SSE response.
     *
     * Same `headersSent` discipline as {@link writeQuotaErrorFrame}: the status
     * line is only honest while nothing has been flushed, and once the 200 is on
     * the wire the frame is the only channel left to explain the refusal.
     *
     * Separate from the quota frame because the two differ in status (`403` vs
     * `429`), headers (`Retry-After` is quota-only) and body (`permission_error`
     * vs `rate_limit_error`).
     */
    private writeAliasForbiddenFrame(
        reply: FastifyReply,
        err: AliasNotPermittedError,
    ): void {
        if (!reply.raw.headersSent) {
            reply.raw.statusCode = 403;
        }
        reply.raw.write(`event: error\n`);
        reply.raw.write(
            `data: ${JSON.stringify(anthropicAliasForbiddenBody(err))}\n\n`,
        );
        reply.raw.end();
    }
}

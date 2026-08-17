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
            return reply;
        }

        try {
            const result = await this.anthropic.messages(body, clientId);
            return reply.send(result);
        } catch (err: any) {
            return reply.code(500).send({
                type: 'error',
                error: {
                    type: 'api_error',
                    message: err?.message || 'upstream error',
                },
            });
        }
    }
}

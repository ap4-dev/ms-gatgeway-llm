import {
    Body,
    Controller,
    Post,
    Req,
    Res,
    UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ChatService } from './chat.service';
import {
    ChatCompletionBodySchema,
} from './schemas/chat-completion.schema';
import type { ChatCompletionBody } from './schemas/chat-completion.schema';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ApiKeyAuthGuard } from '../auth/api-key.guard';
import { RateLimitGuard } from '../ratelimit/rate-limit.guard';
import type { Client } from '../auth/client.repository';
import { QuotaExhaustedError } from '../quota/quota.errors';
import {
    openAiQuotaErrorBody,
    quotaRetryAfterSeconds,
} from '../quota/quota-http';

@Controller('v1/chat')
@UseGuards(ApiKeyAuthGuard, RateLimitGuard)
export class ChatController {
    constructor(private readonly chat: ChatService) {}

    @Post('completions')
    async completions(
        @Body(new ZodValidationPipe(ChatCompletionBodySchema))
        body: ChatCompletionBody,
        @Req() req: FastifyRequest & { client?: Client },
        @Res() reply: FastifyReply,
    ) {
        const clientId = req.client?.id ?? null;
        if (body?.stream) {
            reply.raw.setHeader('Content-Type', 'text/event-stream');
            reply.raw.setHeader('Cache-Control', 'no-cache');
            reply.raw.setHeader('Connection', 'keep-alive');
            reply.raw.setHeader('X-Accel-Buffering', 'no');
            reply.hijack();

            try {
                const stream = await this.chat.completions(body as any, clientId);
                for await (const chunk of stream as any) {
                    const obj = chunk?.toJSON ? chunk.toJSON() : chunk;
                    reply.raw.write(`data: ${JSON.stringify(obj)}\n\n`);
                }
                reply.raw.write('data: [DONE]\n\n');
                reply.raw.end();
            } catch (err: any) {
                if (err instanceof QuotaExhaustedError) {
                    // The reply is hijacked, but nothing has been flushed yet, so
                    // Fastify still lets us set the status and headers on the raw
                    // response. That window closes as soon as the first byte is
                    // written — which is exactly why this must happen first.
                    reply.raw.statusCode = 429;
                    reply.raw.setHeader('Retry-After', String(quotaRetryAfterSeconds(err)));
                    reply.raw.write(`data: ${JSON.stringify(openAiQuotaErrorBody(err))}\n\n`);
                    reply.raw.end();
                } else {
                    reply.raw.write(`data: ${JSON.stringify({ error: { message: err?.message || 'upstream error' } })}\n\n`);
                    reply.raw.end();
                }
            }
            return reply;
        }

        try {
            const result = await this.chat.completions(body as any, clientId);
            const obj = (result as any)?.toJSON ? (result as any).toJSON() : result;
            return reply.send(obj);
        } catch (err: any) {
            if (err instanceof QuotaExhaustedError) {
                return reply
                    .code(429)
                    .header('Retry-After', String(quotaRetryAfterSeconds(err)))
                    .send(openAiQuotaErrorBody(err));
            }
            return reply.code(500).send({ error: { message: err?.message || 'upstream error' } });
        }
    }
}

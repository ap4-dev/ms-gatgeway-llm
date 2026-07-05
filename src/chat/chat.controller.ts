import { Body, Controller, Post, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ChatService } from './chat.service';
import {
    ChatCompletionBodySchema,
} from './schemas/chat-completion.schema';
import type { ChatCompletionBody } from './schemas/chat-completion.schema';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

@Controller('chat')
export class ChatController {
    constructor(private readonly chat: ChatService) { }

    @Post('completions')
    async completions(
        @Body(new ZodValidationPipe(ChatCompletionBodySchema))
        body: ChatCompletionBody,
        @Res() reply: FastifyReply,
    ) {
        if (body?.stream) {
            reply.raw.setHeader('Content-Type', 'text/event-stream');
            reply.raw.setHeader('Cache-Control', 'no-cache');
            reply.raw.setHeader('Connection', 'keep-alive');
            reply.raw.setHeader('X-Accel-Buffering', 'no');
            reply.hijack();

            try {
                const stream = await this.chat.completions(body as any);
                for await (const chunk of stream as any) {
                    const obj = chunk?.toJSON ? chunk.toJSON() : chunk;
                    reply.raw.write(`data: ${JSON.stringify(obj)}\n\n`);
                }
                reply.raw.write('data: [DONE]\n\n');
                reply.raw.end();
            } catch (err: any) {
                reply.raw.write(`data: ${JSON.stringify({ error: { message: err?.message || 'upstream error' } })}\n\n`);
                reply.raw.end();
            }
            return reply;
        }

        try {
            const result = await this.chat.completions(body as any);
            const obj = (result as any)?.toJSON ? (result as any).toJSON() : result;
            return reply.send(obj);
        } catch (err: any) {
            return reply.code(500).send({ error: { message: err?.message || 'upstream error' } });
        }
    }
}

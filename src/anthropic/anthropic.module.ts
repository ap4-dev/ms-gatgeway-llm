import { Module } from '@nestjs/common';
import { AnthropicController } from './anthropic.controller';
import { AnthropicService } from './anthropic.service';
import { ChatModule } from '../chat/chat.module';

/**
 * Anthropic Messages API module — `POST /v1/messages`.
 *
 * Translates Anthropic Messages API format to/from OpenAI Chat Completions
 * format, delegating upstream calls to the existing ChatService (routing,
 * circuit breaker, observability all inherited).
 */
@Module({
    imports: [ChatModule],
    controllers: [AnthropicController],
    providers: [AnthropicService],
})
export class AnthropicModule {}

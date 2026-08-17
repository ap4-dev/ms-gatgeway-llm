import { Injectable } from '@nestjs/common';
import { ChatService } from '../chat/chat.service';
import { translateRequest } from './adapters/request-adapter';
import { translateResponse } from './adapters/response-adapter';
import { createStreamAdapter } from './adapters/stream-adapter';
import type { AnthropicMessagesBody } from './schemas/messages.schema';
import type { AnthropicMessageResponse, AnthropicStreamEvent } from './types';

@Injectable()
export class AnthropicService {
    constructor(private readonly chat: ChatService) {}

    async messages(
        body: AnthropicMessagesBody,
        clientId: string | null,
    ): Promise<AnthropicMessageResponse | AsyncGenerator<AnthropicStreamEvent>> {
        const openaiBody = translateRequest(body);
        const result = await this.chat.completions(openaiBody as any, clientId);

        if (body.stream) {
            return createStreamAdapter(result as any, body.model);
        }

        return translateResponse(result as any, body.model);
    }
}

import { Module } from '@nestjs/common';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';

/**
 * Feature module for the OpenAI-compatible /chat/completions proxy.
 *
 * Phase 1: registers the controller + the single-provider ChatService
 * (env-driven via ConfigService).
 *
 * Phase 2 will add ProviderService and RoutingService here as the
 * multi-provider registry comes online.
 */
@Module({
    controllers: [ChatController],
    providers: [ChatService],
    exports: [ChatService],
})
export class ChatModule {}

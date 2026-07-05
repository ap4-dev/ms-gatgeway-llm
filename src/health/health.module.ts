import { Module } from '@nestjs/common';
import { LlmHealthController } from './llm-health.controller';
import { ChatModule } from '../chat/chat.module';

/**
 * Health module. Imports {@link ChatModule} purely for the exported
 * {@link CircuitBreakerService} — owns the `GET /v1/health/llm` endpoint.
 */
@Module({
    imports: [ChatModule],
    controllers: [LlmHealthController],
})
export class HealthModule {}

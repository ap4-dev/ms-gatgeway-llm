import { Module } from '@nestjs/common';
import { LlmHealthController } from './llm-health.controller';
import { MetricsController } from './metrics.controller';
import { ChatModule } from '../chat/chat.module';
import { ChatService } from '../chat/chat.service';
import {
    CircuitBreakerService,
} from '../resilience/circuit-breaker.service';
import { MetricsService } from '../observability/metrics.service';
import { DatabaseService } from '../database/database.service';

/**
 * Health module. Imports {@link ChatModule} for the exported
 * {@link CircuitBreakerService} and {@link ChatService}, owns the
 * `GET /v1/health/llm` and `GET /v1/metrics/summary` endpoints.
 */
@Module({
    imports: [ChatModule],
    controllers: [LlmHealthController, MetricsController],
    providers: [
        {
            provide: MetricsService,
            useFactory: (db: DatabaseService) => new MetricsService(db.db),
            inject: [DatabaseService],
        },
    ],
})
export class HealthModule {}

import { Module } from '@nestjs/common';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { ProviderService } from '../providers/provider.service';
import { RoutingService } from '../routing/routing.service';
import { CircuitBreakerService } from '../resilience/circuit-breaker.service';
import { ModelsController } from './models.controller';
import {
    ProviderRegistryProvider,
} from '../providers/provider.registry.provider';
import { ProviderRegistryService } from '../providers/provider.registry';
import { RequestLogService } from '../observability/request-log.service';
import { RequestLogRepository } from '../database/repositories/request-log.repository';
import { DatabaseService } from '../database/database.service';

/**
 * Feature module for the OpenAI-compatible /chat/completions proxy.
 *
 * Phase 3: ChatService delegates to RoutingService, which walks an alias's
 * fallback chain under the supervision of CircuitBreakerService.
 *
 * Phase 3.5: ChatService additionally writes one row per call to
 * `request_logs` via RequestLogService. The repository is constructed here
 * (DatabaseService comes from CoreModule → DatabaseModule).
 */
@Module({
    controllers: [ChatController, ModelsController],
    providers: [
        ChatService,
        ProviderService,
        RoutingService,
        // One CircuitBreakerService instance per process — keyed by
        // providerId internally. Constructor pulls the policy from the
        // registry so it stays in sync with the routing_policy table.
        {
            provide: CircuitBreakerService,
            useFactory: (registry: ProviderRegistryService) => {
                const p = registry.policy;
                return new CircuitBreakerService(
                    {
                        failureThreshold: p.failureThreshold,
                        cooldownMs: p.cooldownMs,
                        halfOpenProbes: p.halfOpenProbes,
                    },
                    Date.now,
                    registry,
                );
            },
            inject: [ProviderRegistryService],
        },
        {
            provide: RequestLogRepository,
            useFactory: (db: DatabaseService) => new RequestLogRepository(db.db),
            inject: [DatabaseService],
        },
        RequestLogService,
        ProviderRegistryProvider,
    ],
    exports: [
        ChatService,
        CircuitBreakerService,
        RequestLogService,
        RequestLogRepository,
    ],
})
export class ChatModule {}

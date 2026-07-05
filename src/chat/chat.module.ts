import { Module } from '@nestjs/common';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { ProviderService } from '../providers/provider.service';
import { RoutingService } from '../routing/routing.service';
import { RoundRobinCursor } from '../routing/round-robin-cursor';
import { CircuitBreakerService } from '../resilience/circuit-breaker.service';
import { ModelsController } from './models.controller';
import {
    ProviderRegistryProvider,
} from '../providers/provider.registry.provider';
import { ProviderRegistryService } from '../providers/provider.registry';
import { RequestLogService } from '../observability/request-log.service';
import { LlmLoggingService } from '../observability/llm-logging.service';
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
        // Phase-after-5.5: RoutingService strategy is per-alias — looked
        // up via `registry.getStrategy(model)` on every route call.
        // RoundRobinCursor is process-local (single counter per
        // requested-model key) so distinct aliases rotate independently.
        {
            provide: RoutingService,
            useFactory: (
                providers: ProviderService,
                breaker: CircuitBreakerService,
                registry: ProviderRegistryService,
            ) =>
                new RoutingService(
                    providers,
                    breaker,
                    (aliasKey) => registry.getStrategy(aliasKey),
                    new RoundRobinCursor(),
                ),
            inject: [ProviderService, CircuitBreakerService, ProviderRegistryService],
        },
        {
            provide: RoundRobinCursor,
            useFactory: () => new RoundRobinCursor(),
        },
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
        LlmLoggingService,
        ProviderRegistryProvider,
    ],
    exports: [
        ChatService,
        CircuitBreakerService,
        RequestLogService,
        LlmLoggingService,
        RequestLogRepository,
    ],
})
export class ChatModule {}

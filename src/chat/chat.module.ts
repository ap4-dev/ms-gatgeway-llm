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

/**
 * Feature module for the OpenAI-compatible /chat/completions proxy.
 *
 * Phase 3: ChatService delegates to RoutingService, which walks an alias's
 * fallback chain under the supervision of CircuitBreakerService. Both share
 * a single `ProviderRegistryService` (already global via CoreModule) and
 * derive their knobs from the registry's `routing` block.
 */
@Module({
    controllers: [ChatController, ModelsController],
    providers: [
        ChatService,
        ProviderService,
        RoutingService,
        // One CircuitBreakerService instance per process — keyed by
        // providerId internally. Constructor pulls the policy from the
        // registry so it stays in sync with providers.json.
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
        ProviderRegistryProvider,
    ],
    exports: [ChatService, CircuitBreakerService],
})
export class ChatModule {}

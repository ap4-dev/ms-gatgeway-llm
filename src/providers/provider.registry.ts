import { Injectable } from '@nestjs/common';
import {
    type ModelConfig,
    type ProviderConfig,
    type ProvidersFile,
    type RoutingPolicy,
} from './provider.model';
import { ProviderRegistryRepository } from '../database/repositories/provider-registry.repository';

/** Injection token for the loaded registry. Re-exported here for callers
 *  that don't import from the alias file. Kept symbol-stable for Phase 3
 *  compatibility. */
export const PROVIDER_REGISTRY = Symbol('PROVIDER_REGISTRY');

/**
 * NestJS provider for the multi-provider registry. Reads every value on
 * demand from {@link ProviderRegistryRepository} (better-sqlite3) so any
 * upstream write to providers / model_configs / alias_entries /
 * routing_policy is visible the moment the next getter is called — no
 * in-memory cache.
 *
 * Public surface (preserved from the Phase 2 file-backed version):
 *  - `file`: synthesised ProvidersFile snapshot.
 *  - `providers` / `aliases` / `policy`.
 *  - `has(id)` / `get(id)` / `findModel(modelKey)`.
 *
 * Downstream callers (`ProviderService`, `CircuitBreakerService` factory,
 * `ModelsController`, `RoutingService`) need no changes — the shape is
 * exactly the same, only the source moves.
 */
@Injectable()
export class ProviderRegistryService {
    constructor(private readonly repo: ProviderRegistryRepository) {}

    /**
     * Synthesised top-level view. Kept for callers that previously
     * consumed `file`. The repository's underlying tables are the only
     * authoritative source; this object is fresh per call.
     */
    get file(): ProvidersFile {
        const routing = this.policy;
        return {
            providers: this.providers,
            aliases: this.aliases,
            routing,
        };
    }

    get providers(): Record<string, ProviderConfig> {
        return this.repo.listProviders();
    }

    get aliases(): Record<string, string[]> {
        return this.repo.listAliases();
    }

    get policy(): RoutingPolicy {
        return this.repo.getPolicy();
    }

    has(providerId: string): boolean {
        return this.repo.getProvider(providerId) !== undefined;
    }

    get(providerId: string): ProviderConfig | undefined {
        return this.repo.getProvider(providerId);
    }

    findModel(modelKey: string):
        | { providerId: string; modelKey: string; config: ProviderConfig }
        | undefined {
        return this.repo.findModel(modelKey);
    }

    /** Re-export for tests / admin code that want direct repo access. */
    get repository(): ProviderRegistryRepository {
        return this.repo;
    }
}

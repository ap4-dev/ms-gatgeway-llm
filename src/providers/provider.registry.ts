import { Injectable } from '@nestjs/common';
import {
    type ModelConfig,
    type ProviderConfig,
    type ProvidersFile,
    type RoutingPolicy,
    type RoutingStrategyKind,
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

    /**
     * Per-alias routing strategy lookup. Returns `'primary'` when no
     * `alias_policy` row exists. Phase-after-5.5: the strategy enum
     * lives here (and in `alias_policy`), not on the global
     * `routing_policy` row.
     */
    getStrategy(aliasKey: string): RoutingStrategyKind {
        return this.repo.getStrategy(aliasKey);
    }

    /**
     * Per-alias weights (used by `'weighted'` strategy). Empty array
     * means no configuration; entries are treated as weight=1.
     */
    getWeights(aliasKey: string): Array<{ position: number; weight: number }> {
        return this.repo.getWeights(aliasKey);
    }

    /** Phase-after-5.5: persist a per-alias strategy choice. */
    upsertAliasPolicy(aliasKey: string, strategy: RoutingStrategyKind): void {
        this.repo.upsertAliasPolicy(aliasKey, strategy);
    }

    /** Phase-after-5.5: idempotent weight replacement for an alias. */
    upsertWeights(aliasKey: string, weights: number[]): void {
        this.repo.upsertWeights(aliasKey, weights);
    }

    /**
     * Per-alias chain entries with priorities (used by
     * `'priority-grouped'` strategy).
     */
    getAliasEntries(aliasKey: string): Array<{
        providerId: string;
        modelKey: string;
        position: number;
        priority: number;
    }> {
        const rows = this.repo.getAliasEntries(aliasKey);
        return rows.map((r) => ({
            providerId: r.provider_id,
            modelKey: r.model_key,
            position: r.position,
            priority: r.priority,
        }));
    }

    /** Re-export for tests / admin code that want direct repo access. */
    get repository(): ProviderRegistryRepository {
        return this.repo;
    }
}

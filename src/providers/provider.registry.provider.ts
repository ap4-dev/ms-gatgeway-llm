import { Provider } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ProviderRegistryService } from './provider.registry';
import { ProviderRegistryRepository } from '../database/repositories/provider-registry.repository';
import { PROVIDER_REGISTRY } from './provider.registry';

/**
 * Provider factory for `ProviderRegistryService`. Resolves the singleton
 * `DatabaseService` (provided by DatabaseModule) and wraps it in a
 * `ProviderRegistryRepository`. No string parameters — Nest used to
 * interpret those as `String` DI tokens and threw.
 */
export const ProviderRegistryProvider: Provider = {
    provide: ProviderRegistryService,
    useFactory: (db: DatabaseService) => {
        const repo = new ProviderRegistryRepository(db.db);
        return new ProviderRegistryService(repo);
    },
    inject: [DatabaseService],
};

/** Re-exports the registry under a symbol-keyed token for `@Inject`. */
export const ProviderRegistryAlias: Provider = {
    provide: PROVIDER_REGISTRY,
    useExisting: ProviderRegistryService,
};

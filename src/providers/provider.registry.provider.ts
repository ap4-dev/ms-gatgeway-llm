import { Provider } from '@nestjs/common';
import {
    DEFAULT_PROVIDERS_FILE,
    PROVIDER_REGISTRY,
    ProviderRegistryService,
} from './provider.registry';

/**
 * Provider factory for `ProviderRegistryService`. Reads the file path from
 * a constant (default), never from the DI container, so the constructor
 * receives a real string rather than being interpreted as a `String` token.
 */
export const ProviderRegistryProvider: Provider = {
    provide: ProviderRegistryService,
    useFactory: () => new ProviderRegistryService(DEFAULT_PROVIDERS_FILE),
};

/** Re-exports the registry under a stringly-keyed token for `@Inject`. */
export const ProviderRegistryAlias: Provider = {
    provide: PROVIDER_REGISTRY,
    useExisting: ProviderRegistryService,
};

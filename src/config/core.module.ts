import { Global, Module } from '@nestjs/common';
import { ENV_CONFIG, envProvider } from './env.token';
import { PROVIDER_REGISTRY, ProviderRegistryService } from '../providers/provider.registry';
import {
    ProviderRegistryAlias,
    ProviderRegistryProvider,
} from '../providers/provider.registry.provider';

/**
 * Global module that exposes the validated `Env` snapshot under the
 * `ENV_CONFIG` injection token, the loaded registry under both the
 * `PROVIDER_REGISTRY` symbol and the `ProviderRegistryService` class.
 * Marked `@Global()` so feature modules (ChatModule, …) don't need to
 * import it explicitly — once AppModule has imported CoreModule, any
 * provider can `@Inject(...)` or constructor-inject the class without
 * ceremony.
 */
@Global()
@Module({
    providers: [
        envProvider,
        ProviderRegistryProvider,
        ProviderRegistryAlias,
    ],
    exports: [ENV_CONFIG, PROVIDER_REGISTRY, ProviderRegistryService],
})
export class CoreModule {}

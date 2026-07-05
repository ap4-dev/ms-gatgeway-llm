import { Global, Module } from '@nestjs/common';
import { ENV_CONFIG, envProvider } from './env.token';
import { PROVIDER_REGISTRY, ProviderRegistryService } from '../providers/provider.registry';
import {
    ProviderRegistryAlias,
    ProviderRegistryProvider,
} from '../providers/provider.registry.provider';
import { DatabaseModule } from '../database/database.module';

/**
 * Global module that exposes the validated `Env` snapshot under the
 * `ENV_CONFIG` injection token, the loaded registry under both the
 * `PROVIDER_REGISTRY` symbol and the `ProviderRegistryService` class, and
 * the SQLite-backed repository stack via `DatabaseModule`.
 *
 * Marked `@Global()` so feature modules (ChatModule, HealthModule, …)
 * don't need to import it explicitly — once AppModule has imported
 * CoreModule, any provider can `@Inject(...)` or constructor-inject
 * DatabaseService / ProviderRegistryService / etc. without ceremony.
 */
@Global()
@Module({
    imports: [DatabaseModule],
    providers: [
        envProvider,
        ProviderRegistryProvider,
        ProviderRegistryAlias,
    ],
    exports: [ENV_CONFIG, PROVIDER_REGISTRY, ProviderRegistryService],
})
export class CoreModule {}

import { Global, Module } from '@nestjs/common';
import { ENV_CONFIG, envProvider } from './env.token';
import { PROVIDER_REGISTRY, ProviderRegistryService } from '../providers/provider.registry';
import {
    ProviderRegistryAlias,
    ProviderRegistryProvider,
} from '../providers/provider.registry.provider';
import { DatabaseModule } from '../database/database.module';
import { AuthModule } from '../auth/auth.module';
import { RateLimitModule } from '../ratelimit/ratelimit.module';

/**
 * Global module that exposes the validated `Env` snapshot under the
 * `ENV_CONFIG` injection token, the loaded registry under both the
 * `PROVIDER_REGISTRY` symbol and the `ProviderRegistryService` class, the
 * SQLite-backed repository stack via `DatabaseModule`, the auth services
 * via `AuthModule`, and the rate-limit guard + limiter via
 * `RateLimitModule`.
 *
 * Marked `@Global()` so feature modules (ChatModule, HealthModule, …)
 * don't need to import it explicitly — once AppModule has imported
 * CoreModule, any provider can `@Inject(...)` or constructor-inject
 * DatabaseService / ProviderRegistryService / ClientService /
 * RedisRateLimiterService / etc. without ceremony.
 */
@Global()
@Module({
    imports: [DatabaseModule, AuthModule, RateLimitModule],
    providers: [
        envProvider,
        ProviderRegistryProvider,
        ProviderRegistryAlias,
    ],
    exports: [ENV_CONFIG, PROVIDER_REGISTRY, ProviderRegistryService],
})
export class CoreModule {}

import { Global, Module } from '@nestjs/common';
import { ApiKeyAuthGuard } from './api-key.guard';
import { ClientService } from './client.service';
import { ClientRepository } from './client.repository';
import { ClientAuthCache } from './client-auth-cache';
import { DatabaseService } from '../database/database.service';
import { ENV_CONFIG } from '../config/env.token';
import type { Env } from '../config/env.schema';

/**
 * Phase 6+ auth module. Marked `@Global()` so the {@link ApiKeyAuthGuard}
 * and {@link ClientService} can be used by any feature module without an
 * explicit import. Health/metrics endpoints that stay public do NOT use
 * the guard — apply it per-controller with `@UseGuards(ApiKeyAuthGuard)`.
 *
 * Wires the HMAC pepper from the validated env schema into both
 * `ClientService` and `ClientRepository` consumers. The pepper is required
 * (zod `min(32)`) and load-bearing — the gateway refuses to boot without it.
 */
@Global()
@Module({
    providers: [
        {
            provide: ClientRepository,
            useFactory: (db: DatabaseService) => new ClientRepository(db.db),
            inject: [DatabaseService],
        },
        ClientAuthCache,
        {
            provide: ClientService,
            useFactory: (
                repo: ClientRepository,
                cache: ClientAuthCache,
                env: Env,
            ) => new ClientService(repo, cache, env.API_KEY_PEPPER),
            inject: [ClientRepository, ClientAuthCache, ENV_CONFIG],
        },
        ApiKeyAuthGuard,
    ],
    exports: [ClientService, ApiKeyAuthGuard, ClientRepository, ClientAuthCache],
})
export class AuthModule {}

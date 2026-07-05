import { Global, Module } from '@nestjs/common';
import { ApiKeyAuthGuard } from './api-key.guard';
import { ClientService } from './client.service';
import { ClientRepository } from './client.repository';
import { DatabaseService } from '../database/database.service';

/**
 * Phase 5 auth module. Marked `@Global()` so the {@link ApiKeyAuthGuard}
 * and {@link ClientService} can be used by any feature module without an
 * explicit import. Health/metrics endpoints that stay public do NOT use
 * the guard — apply it per-controller with `@UseGuards(ApiKeyAuthGuard)`.
 */
@Global()
@Module({
    providers: [
        {
            provide: ClientRepository,
            useFactory: (db: DatabaseService) => new ClientRepository(db.db),
            inject: [DatabaseService],
        },
        ClientService,
        ApiKeyAuthGuard,
    ],
    exports: [ClientService, ApiKeyAuthGuard, ClientRepository],
})
export class AuthModule {}

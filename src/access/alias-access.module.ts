import { Module } from '@nestjs/common';
import { ClientAliasAccessRepository } from '../database/repositories/client-alias-access.repository';
import { DatabaseService } from '../database/database.service';
import { AliasAccessService } from './alias-access.service';

/**
 * Per-client alias allowlist feature module.
 *
 * `DatabaseModule` is `@Global()` and exports `DatabaseService`, so it is not
 * imported explicitly here — same convention as `AuthModule` and `QuotaModule`.
 * The repository is built with a factory (not `@Injectable`) because it takes
 * the raw better-sqlite3 handle and is shared with the other repositories on
 * the single connection.
 *
 * Both the repository and the service are exported: `AdminModule` needs the
 * service for `/admin/clients/:id/aliases`, and the later enforcement work unit
 * needs the service from the request path. The repository is exported for
 * symmetry with its neighbours and for specs that assemble the graph directly.
 */
@Module({
    providers: [
        {
            provide: ClientAliasAccessRepository,
            useFactory: (db: DatabaseService) => new ClientAliasAccessRepository(db.db),
            inject: [DatabaseService],
        },
        AliasAccessService,
    ],
    exports: [ClientAliasAccessRepository, AliasAccessService],
})
export class AliasAccessModule {}

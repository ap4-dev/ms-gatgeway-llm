import { Module } from '@nestjs/common';
import { QuotaRepository } from '../database/repositories/quota.repository';
import { DatabaseService } from '../database/database.service';
import { QUOTA_CLOCK, QuotaService } from './quota.service';

/**
 * Per-client alias quota feature module.
 *
 * `DatabaseModule` is `@Global()` and exports `DatabaseService`, so it is not
 * imported explicitly here — same convention as `AuthModule`. The repository is
 * built with a factory (not `@Injectable`) because it takes the raw
 * better-sqlite3 handle and is shared with the other repositories on the single
 * connection.
 *
 * `QUOTA_CLOCK` binds the real wall clock in production; only specs override it
 * to make month rollover and `retryAfter` deterministic.
 *
 * `QuotaService` is exported because the chat pipeline is its consumer.
 */
@Module({
    providers: [
        {
            provide: QuotaRepository,
            useFactory: (db: DatabaseService) => new QuotaRepository(db.db),
            inject: [DatabaseService],
        },
        { provide: QUOTA_CLOCK, useValue: Date.now },
        QuotaService,
    ],
    exports: [QuotaService],
})
export class QuotaModule {}

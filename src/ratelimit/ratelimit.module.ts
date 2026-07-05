import { Global, Module } from '@nestjs/common';
import IORedis from 'ioredis';
import { RedisRateLimiterService, REDIS_RUNNER } from './redis-rate-limiter.service';
import { RateLimitGuard } from './rate-limit.guard';
import { AuthModule } from '../auth/auth.module';
import { ClientService } from '../auth/client.service';

/**
 * Phase 5 rate-limit module. Constructs the ioredis client lazily and
 * exposes the {@link RateLimitGuard} + the underlying limiter. Imported
 * by `CoreModule` so the guard + limiter are globally available.
 *
 * Falls back to no-op (fail-open) when `REDIS_URL` is unset — the
 * limiter constructor detects the missing runner and always allows the
 * request. Local development without Redis keeps working.
 */
@Global()
@Module({
    imports: [AuthModule],
    providers: [
        {
            provide: REDIS_RUNNER,
            useFactory: () => {
                const url = process.env.REDIS_URL;
                if (!url) return null; // limiter detects null and fails open.
                const client = new IORedis(url, {
                    maxRetriesPerRequest: 1,
                    lazyConnect: false,
                    enableOfflineQueue: false,
                });
                return RedisRateLimiterService.fromClient(client);
            },
        },
        {
            provide: RedisRateLimiterService,
            useFactory: (runner: any) => new RedisRateLimiterService(runner),
            inject: [REDIS_RUNNER],
        },
        RateLimitGuard,
    ],
    exports: [RedisRateLimiterService, RateLimitGuard, REDIS_RUNNER],
})
export class RateLimitModule {}

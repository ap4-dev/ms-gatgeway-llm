import { Global, Module } from '@nestjs/common';
import { RedisService } from './redis.service';

/**
 * Promotes `RedisService` from a per-module provider (was only listed in
 * `AppModule.providers`, which made it unusable from feature modules) to
 * a globally injectable provider. Any consumer can now depend on
 * `RedisService` directly — no import required.
 *
 * Today the only consumer is `ClientAuthCache`, but future cross-module
 * caches should follow the same pattern rather than re-creating clients.
 */
@Global()
@Module({
    providers: [RedisService],
    exports: [RedisService],
})
export class RedisModule {}

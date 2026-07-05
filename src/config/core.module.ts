import { Global, Module } from '@nestjs/common';
import { ENV_CONFIG, envProvider } from './env.token';

/**
 * Global module that exposes the validated `Env` snapshot under the
 * `ENV_CONFIG` injection token. Marked `@Global()` so feature modules
 * (ChatModule, …) don't need to import it explicitly — once AppModule
 * has imported CoreModule, any provider can `@Inject(ENV_CONFIG)`
 * without ceremony.
 */
@Global()
@Module({
    providers: [envProvider],
    exports: [ENV_CONFIG],
})
export class CoreModule {}

import { Module } from '@nestjs/common';
import { AdminClientsController } from './admin-clients.controller';
import { ChatModule } from '../chat/chat.module';

/**
 * Phase 5.5 admin module. Imports {@link ChatModule} only because the
 * controllers below depend on `ClientService` which is exported via
 * `AuthModule` → `CoreModule` (the chain reaches it implicitly through
 * the global registry). The guard + decorator wiring lives on each
 * controller — `@UseGuards(ApiKeyAuthGuard, RequireScopesGuard, RateLimitGuard)`
 * + `@RequireScopes('admin')`.
 */
@Module({
    imports: [ChatModule],
    controllers: [AdminClientsController],
})
export class AdminModule {}

import { Module } from '@nestjs/common';
import { AdminClientsController } from './admin-clients.controller';
import { AdminAliasesController } from './admin-aliases.controller';
import { ChatModule } from '../chat/chat.module';

/**
 * Phase 5.5+ admin module. Imports {@link ChatModule} only because the
 * controllers below depend on services which are exported via the
 * global registry (Chain reaches ClientService / ProviderRegistryService
 * through CoreModule's @Global()). Guard + decorator wiring lives on
 * each controller — `@UseGuards(ApiKeyAuthGuard, RequireScopesGuard,
 * RateLimitGuard)` + `@RequireScopes('admin')`.
 */
@Module({
    imports: [ChatModule],
    controllers: [AdminClientsController, AdminAliasesController],
})
export class AdminModule {}

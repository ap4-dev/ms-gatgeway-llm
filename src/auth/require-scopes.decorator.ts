import { SetMetadata } from '@nestjs/common';

/**
 * Phase 5.5 decorator for scope-gated routes / controllers. Reads
 * `req.client.scopes` (set by `ApiKeyAuthGuard`) and validates that
 * every listed scope is present. Apply BEFORE `@UseGuards(ApiKeyAuthGuard,
 * RequireScopesGuard, RateLimitGuard)` on a controller or handler.
 *
 * Example:
 *   @Controller('admin/clients')
 *   @UseGuards(ApiKeyAuthGuard, RequireScopesGuard, RateLimitGuard)
 *   @RequireScopes('admin')
 *   export class AdminClientsController {}
 */
export const SCOPES_METADATA_KEY = 'scopes';
export function RequireScopes(...scopes: string[]): MethodDecorator & ClassDecorator {
    return SetMetadata(SCOPES_METADATA_KEY, scopes);
}

import {
    Body,
    Controller,
    Post,
    Req,
    Res,
    UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ApiKeyAuthGuard } from '../auth/api-key.guard';
import { RequireScopesGuard } from '../auth/require-scopes.guard';
import { RateLimitGuard } from '../ratelimit/rate-limit.guard';
import { RequireScopes } from '../auth/require-scopes.decorator';
import type { Client } from '../auth/client.repository';
import {
    SearchService,
    SearchBodySchema,
    searchErrorEnvelope,
    searchErrorStatus,
    isSearchRateLimited,
    stripSource,
    type SearchBody,
} from './search.service';
import {
    SearchProviderError,
    type SearchResponse,
} from './search-provider.interface';

/**
 * POST /v1/search — REST search surface.
 *
 * Request/response mirror NaN's wire format, minus the provider-internal
 * `source` field on each result (stripped below). Clients talk to this
 * endpoint, never to NaN directly, so the provider can change without
 * touching them.
 *
 * Error envelope (provider failures): `{ error: { message, type, code,
 * retryAfterMs? } }` with `code` in `search_unavailable` |
 * `search_rate_limited` | `search_timeout` and HTTP 502 / 429 / 504.
 */
@Controller('v1/search')
@UseGuards(ApiKeyAuthGuard, RequireScopesGuard, RateLimitGuard)
@RequireScopes('chat.write')
export class SearchController {
    constructor(private readonly service: SearchService) {}

    @Post()
    async search(
        @Body(new ZodValidationPipe(SearchBodySchema)) body: SearchBody,
        @Req() req: FastifyRequest & { client?: Client },
        @Res() reply: FastifyReply,
    ) {
        try {
            const response = await this.service.search(
                body,
                req.client?.id ?? null,
            );
            return reply.send(stripSource(response));
        } catch (err) {
            if (err instanceof SearchProviderError) {
                if (isSearchRateLimited(err) && err.retryAfterMs !== undefined) {
                    reply.header(
                        'Retry-After',
                        String(Math.max(1, Math.ceil(err.retryAfterMs / 1000))),
                    );
                }
                return reply
                    .code(searchErrorStatus(err))
                    .send(searchErrorEnvelope(err));
            }
            // Unexpected (non-provider) failure — never leak internals.
            return reply.code(502).send(
                searchErrorEnvelope(
                    new SearchProviderError('Search failed unexpectedly.'),
                ),
            );
        }
    }
}



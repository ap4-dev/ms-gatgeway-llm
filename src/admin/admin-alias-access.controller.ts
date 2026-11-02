import {
    BadRequestException,
    Body,
    Controller,
    Delete,
    Get,
    NotFoundException,
    Param,
    Put,
    UseGuards,
} from '@nestjs/common';
import {
    ApiBadRequestResponse,
    ApiBearerAuth,
    ApiForbiddenResponse,
    ApiNotFoundResponse,
    ApiOkResponse,
    ApiOperation,
    ApiParam,
    ApiTags,
    ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { z } from 'zod';
import { ClientService } from '../auth/client.service';
import type { Client } from '../auth/client.repository';
import { ApiKeyAuthGuard } from '../auth/api-key.guard';
import { RequireScopesGuard } from '../auth/require-scopes.guard';
import { RateLimitGuard } from '../ratelimit/rate-limit.guard';
import { RequireScopes } from '../auth/require-scopes.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ProviderRegistryService } from '../providers/provider.registry';
import {
    AliasAccessService,
    type AliasAccessDescription,
} from '../access/alias-access.service';

/**
 * Structural rules only. Whether the named aliases EXIST is a question for the
 * registry, not for zod (the schema is defined once, the registry is injected),
 * so it is checked in `assertAliasesExist` below and reported with the same
 * `400` the pipe produces. An empty array passes this schema deliberately: the
 * handler rejects it with a message that points at DELETE, which zod could not
 * phrase (see `parseAliases`).
 */
const PutAliasesSchema = z.object({
    aliases: z.array(z.string().min(1)),
});

type PutAliasesDto = z.infer<typeof PutAliasesSchema>;

/**
 * One instance, used twice: as the `@Body` pipe (the wire-level guard) and by
 * `parseAliases` inside the handler, so the exact same rules apply when the
 * handler is called directly instead of through Nest's routing.
 */
const PutAliasesPipe = new ZodValidationPipe(PutAliasesSchema);

/**
 * Admin alias-access surface: read and edit which aliases a client may use.
 *
 * Same auth chain as the other admin controllers (`ApiKeyAuthGuard` + admin
 * scope + `RateLimitGuard`). Admin only on purpose — this is a permission
 * table, not something a client may read about itself: knowing the list of
 * aliases it cannot use is not useful, and telling a client "you are
 * unrestricted" would leak the shape of the fleet.
 *
 * The controller owns exactly two things the service deliberately does not:
 * that the client exists (404) and that the aliases named in the body exist
 * and make sense together (400). `AliasAccessService.replace` is a dumb writer
 * by design — the registry checks cannot live in the service without dragging
 * the provider registry into the access domain, and cannot live in zod because
 * the alias map is injected.
 *
 * SCOPE: this unit stores and reads the allowlist only. No request path reads
 * it yet, so changing it here cannot change what a client can call — that is
 * the enforcement work unit.
 */
@Controller('admin/clients/:id/aliases')
@UseGuards(ApiKeyAuthGuard, RequireScopesGuard, RateLimitGuard)
@RequireScopes('admin')
@ApiTags('admin · alias access')
@ApiBearerAuth('admin-bearer')
@ApiUnauthorizedResponse({ description: 'Missing or invalid API key.' })
@ApiForbiddenResponse({
    description: 'Client authenticated but lacks the `admin` scope.',
})
export class AdminAliasAccessController {
    constructor(
        private readonly access: AliasAccessService,
        private readonly clients: ClientService,
        private readonly registry: ProviderRegistryService,
    ) {}

    @Get()
    @ApiOperation({
        summary: 'List the alias allowlist of one client.',
        description:
            '`mode: "unrestricted"` means the client has no rows and may use every alias in the ' +
            'registry — that is the state of every client that was never configured. ' +
            '`mode: "restricted"` means the returned list is EXHAUSTIVE: any alias missing from it ' +
            'is forbidden for that client.',
    })
    @ApiParam({ name: 'id', example: 'tenant-acme' })
    @ApiOkResponse({
        description:
            'Alias access state of the client. `unrestricted` is the default state of every ' +
            'client that was never configured.',
        schema: {
            example: {
                clientId: 'tenant-acme',
                mode: 'restricted',
                aliases: ['codex', 'slave'],
            },
        },
    })
    @ApiNotFoundResponse({ description: 'Client id unknown.' })
    list(@Param('id') id: string): AliasAccessDescription {
        this.mustFindClient(id);
        return this.access.describe(id);
    }

    @Put()
    @ApiOperation({
        summary: 'Replace the whole alias allowlist of one client.',
        description:
            'The body states the SET the client should have: aliases missing from it are removed, ' +
            'so no second call is needed to revoke one. Every alias must already exist in the ' +
            'registry and may appear only once. An empty array is rejected: because no rows means ' +
            'UNRESTRICTED, accepting `[]` here would silently grant full access to an operator who ' +
            'meant the opposite — use DELETE to clear the allowlist.',
    })
    @ApiParam({ name: 'id', example: 'tenant-acme' })
    @ApiOkResponse({
        description: 'Alias access state after the replacement.',
        schema: {
            example: {
                clientId: 'tenant-acme',
                mode: 'restricted',
                aliases: ['codex', 'slave'],
            },
        },
    })
    @ApiBadRequestResponse({
        description:
            'Body failed zod validation, the list is empty, an alias is not in the registry, ' +
            'or the same alias appears twice.',
    })
    @ApiNotFoundResponse({ description: 'Client id unknown.' })
    replace(
        @Param('id') id: string,
        @Body(PutAliasesPipe) body: PutAliasesDto,
    ): AliasAccessDescription {
        this.mustFindClient(id);
        const aliases = this.parseAliases(body);
        return this.access.replace(id, aliases);
    }

    @Delete()
    @ApiOperation({
        summary: 'Clear the alias allowlist, returning the client to unrestricted.',
        description:
            'Deletes every access row of the client, so it may use every alias in the registry ' +
            'again — the same state it was in before anyone configured it. Idempotent: clearing an ' +
            'already-clear client is a no-op that returns `unrestricted`.',
    })
    @ApiParam({ name: 'id', example: 'tenant-acme' })
    @ApiOkResponse({
        description: 'Alias access state after the clear.',
        schema: {
            example: { clientId: 'tenant-acme', mode: 'unrestricted', aliases: [] },
        },
    })
    @ApiNotFoundResponse({ description: 'Client id unknown.' })
    clear(@Param('id') id: string): AliasAccessDescription {
        this.mustFindClient(id);
        return this.access.clear(id);
    }

    // --- internals -------------------------------------------------------

    private mustFindClient(id: string): Client {
        const client = this.clients.findById(id);
        if (!client) {
            throw new NotFoundException(`Client "${id}" not found`);
        }
        return client;
    }

    /**
     * Validate the body and then the aliases it names.
     *
     * The pipe already ran on the wire; running it again here is idempotent and
     * keeps one set of rules whether the handler is reached through HTTP or
     * called directly (specs, internal tooling). Each rejection names the exact
     * element so the operator can fix the payload without guessing.
     *
     * The empty-list rejection lives here rather than in the zod schema because
     * the rule is SEMANTIC — it depends on how the rest of this feature reads an
     * absent row — and because the operator needs to be told what to do
     * instead.
     */
    private parseAliases(body: unknown): string[] {
        const parsed = PutAliasesPipe.transform(body, { type: 'body' }) as PutAliasesDto;

        if (parsed.aliases.length === 0) {
            throw new BadRequestException(
                'aliases: must not be empty — with no rows a client is UNRESTRICTED. ' +
                    'Use DELETE /admin/clients/:id/aliases to clear the allowlist.',
            );
        }

        this.assertAliasesExist(parsed.aliases);
        return parsed.aliases;
    }

    private assertAliasesExist(aliases: string[]): void {
        const registryAliases = this.registry.aliases;

        // R3-002: `registryAliases[key]` is a truthiness lookup on a plain
        // object, so it also matches everything inherited from
        // `Object.prototype` — an alias named `constructor`, `toString` or
        // `__proto__` would sail through and be stored as a permitted alias.
        // Only an OWN property that actually is an array counts as an alias.
        const aliasExists = (key: string): boolean =>
            Object.prototype.hasOwnProperty.call(registryAliases, key) &&
            Array.isArray(registryAliases[key]);

        const seen = new Set<string>();

        aliases.forEach((aliasKey, index) => {
            if (!aliasExists(aliasKey)) {
                throw new BadRequestException(
                    `aliases[${index}]: alias "${aliasKey}" is not in the alias registry`,
                );
            }

            // Duplicates are also rejected by the repository (before it writes
            // anything), but catching them here yields a message that names the
            // offending element instead of a domain error.
            if (seen.has(aliasKey)) {
                throw new BadRequestException(
                    `aliases[${index}]: alias "${aliasKey}" appears more than once`,
                );
            }
            seen.add(aliasKey);
        });
    }
}

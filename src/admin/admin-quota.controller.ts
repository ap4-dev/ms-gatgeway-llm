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
import { QuotaService } from '../quota/quota.service';
import {
    describeClientQuotas,
    type ClientQuotasView,
} from '../quota/quota.controller';

/**
 * Structural rules only. Whether the named aliases EXIST is a question for the
 * registry, not for zod (the schema is defined once, the registry is injected),
 * so it is checked in `assertAliasesExist` below and reported with the same
 * `400` the pipe produces.
 *
 * `monthlyTokenLimit` accepts numeric strings via `z.coerce` for consistency
 * with `AdminClientsController`'s rate-limit fields; `.int().positive()` is what
 * keeps a fractional or non-positive allowance out, which the DB CHECK would
 * otherwise reject as a 500 mid-write.
 */
const QuotaEntrySchema = z.object({
    aliasKey: z.string().min(1),
    monthlyTokenLimit: z.coerce.number().int().positive(),
    divertAliasKey: z.string().min(1).nullable().optional(),
});

const PutQuotasSchema = z.object({
    quotas: z.array(QuotaEntrySchema),
});

type PutQuotasDto = z.infer<typeof PutQuotasSchema>;

/**
 * One instance, used twice: as the `@Body` pipe (the wire-level guard) and by
 * `parseQuotas` inside the handler, so the exact same rules apply when the
 * handler is called directly instead of through Nest's routing.
 */
const PutQuotasPipe = new ZodValidationPipe(PutQuotasSchema);

interface QuotaDeletedView {
    deleted: true;
    clientId: string;
    aliasKey: string;
}

/**
 * Admin quota surface: read and edit the monthly token allowance of a client
 * per alias. Same auth chain as the other admin controllers
 * (`ApiKeyAuthGuard` + admin scope + `RateLimitGuard`).
 *
 * The controller owns exactly two things the service deliberately does not:
 * that the client exists (404) and that the aliases named in the body exist and
 * make sense together (400). `QuotaService.upsertQuota` is a dumb writer by
 * design — the registry checks cannot live in the service without dragging the
 * provider registry into the quota domain, and cannot live in zod because the
 * alias map is injected.
 */
@Controller('admin/clients')
@UseGuards(ApiKeyAuthGuard, RequireScopesGuard, RateLimitGuard)
@RequireScopes('admin')
@ApiTags('admin · quota')
@ApiBearerAuth('admin-bearer')
@ApiUnauthorizedResponse({ description: 'Missing or invalid API key.' })
@ApiForbiddenResponse({
    description: 'Client authenticated but lacks the `admin` scope.',
})
export class AdminQuotaController {
    constructor(
        private readonly quota: QuotaService,
        private readonly clients: ClientService,
        private readonly registry: ProviderRegistryService,
    ) {}

    @Get(':id/quotas')
    @ApiOperation({
        summary: 'List the monthly token quotas of one client.',
        description:
            'Each entry joins the stored allowance with the usage of the UTC month in progress. ' +
            '`exhausted` uses the same strict `tokens >= limit` rule as the request gate, and ' +
            '`resetsAt`/`retryAfterSeconds` are the same numbers the 429 reports.',
    })
    @ApiParam({ name: 'id', example: 'tenant-acme' })
    @ApiOkResponse({
        description: 'Client quota envelope.',
        schema: {
            example: {
                clientId: 'tenant-acme',
                periodKey: '2026-11',
                resetsAt: 1798761600,
                retryAfterSeconds: 1_411_200,
                quotas: [
                    {
                        aliasKey: 'codex',
                        monthlyTokenLimit: 20_000_000,
                        divertAliasKey: 'slave',
                        periodKey: '2026-11',
                        tokens: 1_000,
                        requests: 3,
                        remaining: 19_999_000,
                        exhausted: false,
                        resetsAt: 1798761600,
                        retryAfterSeconds: 1_411_200,
                    },
                ],
            },
        },
    })
    @ApiNotFoundResponse({ description: 'Client id unknown.' })
    listQuotas(@Param('id') id: string): ClientQuotasView {
        this.mustFindClient(id);
        return describeClientQuotas(this.quota, id);
    }

    @Put(':id/quotas')
    @ApiOperation({
        summary: 'Upsert one or more monthly token quotas (idempotent).',
        description:
            'Every entry is written in the order given, then the whole set is re-described, ' +
            'so the response already reflects the new limits. Aliases are NOT created here: ' +
            'both `aliasKey` and `divertAliasKey` must already exist in the alias registry.',
    })
    @ApiParam({ name: 'id', example: 'tenant-acme' })
    @ApiOkResponse({
        description: 'Client quota envelope after the writes.',
        schema: {
            example: {
                clientId: 'tenant-acme',
                periodKey: '2026-11',
                resetsAt: 1798761600,
                retryAfterSeconds: 1_411_200,
                quotas: [
                    {
                        aliasKey: 'codex',
                        monthlyTokenLimit: 20_000_000,
                        divertAliasKey: 'slave',
                        periodKey: '2026-11',
                        tokens: 1_000,
                        requests: 3,
                        remaining: 19_999_000,
                        exhausted: false,
                        resetsAt: 1798761600,
                        retryAfterSeconds: 1_411_200,
                    },
                ],
            },
        },
    })
    @ApiBadRequestResponse({
        description:
            'Body failed zod validation, an alias is not in the registry, or ' +
            '`divertAliasKey` equals `aliasKey`.',
    })
    @ApiNotFoundResponse({ description: 'Client id unknown.' })
    upsertQuotas(
        @Param('id') id: string,
        @Body(PutQuotasPipe) body: PutQuotasDto,
    ): ClientQuotasView {
        this.mustFindClient(id);
        const quotas = this.parseQuotas(body);

        for (const entry of quotas) {
            this.quota.upsertQuota(id, {
                aliasKey: entry.aliasKey,
                monthlyTokenLimit: entry.monthlyTokenLimit,
                divertAliasKey: entry.divertAliasKey ?? null,
            });
        }

        return describeClientQuotas(this.quota, id);
    }

    @Delete(':id/quotas/:aliasKey')
    @ApiOperation({
        summary: 'Remove one alias allowance; the alias becomes unlimited.',
        description: '404 when there was no quota row, so a typo is visible.',
    })
    @ApiParam({ name: 'id', example: 'tenant-acme' })
    @ApiParam({ name: 'aliasKey', example: 'codex' })
    @ApiOkResponse({
        description: 'Row removed.',
        schema: {
            example: { deleted: true, clientId: 'tenant-acme', aliasKey: 'codex' },
        },
    })
    @ApiNotFoundResponse({
        description: 'Client id unknown, or no quota row for that alias.',
    })
    deleteQuota(
        @Param('id') id: string,
        @Param('aliasKey') aliasKey: string,
    ): QuotaDeletedView {
        this.mustFindClient(id);

        if (!this.quota.removeQuota(id, aliasKey)) {
            throw new NotFoundException(
                `Client "${id}" has no quota for alias "${aliasKey}"`,
            );
        }

        return { deleted: true, clientId: id, aliasKey };
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
     * request field so the operator can fix the payload without guessing.
     */
    private parseQuotas(body: unknown): PutQuotasDto['quotas'] {
        const parsed = PutQuotasPipe.transform(body, { type: 'body' }) as PutQuotasDto;
        this.assertAliasesExist(parsed.quotas);
        return parsed.quotas;
    }

    private assertAliasesExist(quotas: PutQuotasDto['quotas']): void {
        const aliases = this.registry.aliases;

        quotas.forEach((entry, index) => {
            if (!aliases[entry.aliasKey]) {
                throw new BadRequestException(
                    `quotas[${index}].aliasKey: alias "${entry.aliasKey}" is not in the alias registry`,
                );
            }

            if (entry.divertAliasKey == null) {
                return;
            }

            if (!aliases[entry.divertAliasKey]) {
                throw new BadRequestException(
                    `quotas[${index}].divertAliasKey: alias "${entry.divertAliasKey}" is not in the alias registry`,
                );
            }

            if (entry.divertAliasKey === entry.aliasKey) {
                throw new BadRequestException(
                    `quotas[${index}].divertAliasKey: must differ from aliasKey ("${entry.aliasKey}")`,
                );
            }
        });
    }
}

import {
    BadRequestException,
    Body,
    Controller,
    Delete,
    Get,
    NotFoundException,
    Param,
    Post,
    Put,
    Query,
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
    ApiQuery,
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
import { QuotaReconcileService } from '../quota/quota-reconcile.service';
import type { ReconcileReport } from '../quota/quota-reconcile.service';
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

/** `YYYY-MM` only — the same shape `QuotaReconcileService` validates. */
const PERIOD_KEY_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * `dryRun` arrives as a query STRING, and `z.coerce.boolean()` is unusable
 * here: `Boolean('false')` is `true`, so `?dryRun=false` would silently
 * dry-run the write the operator explicitly asked for. Only the literals below
 * map to a boolean; anything else (`?dryRun=yes`, `?dryRun=`) is a 400.
 */
const DryRunQuerySchema = z
    .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
    .transform((value) => value === true || value === 'true' || value === '1');

/**
 * Query schema for `POST /admin/quotas/reconcile`. Both parameters are
 * optional: the month defaults to the one in progress and `dryRun` defaults to
 * `true` in the handler (not here, so "absent" stays distinguishable).
 */
const ReconcileQuerySchema = z
    .object({
        periodKey: z
            .string()
            .regex(PERIOD_KEY_PATTERN, 'expected a UTC calendar month as YYYY-MM')
            .optional(),
        dryRun: DryRunQuerySchema.optional(),
    })
    .strict();

type ReconcileQuery = z.infer<typeof ReconcileQuerySchema>;

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
 *
 * `POST admin/quotas/reconcile` lives here too, but owns only query parsing: the
 * recomputation itself (and the `dryRun` write rule) belongs to
 * `QuotaReconcileService`, which is the only writer of absolute counters.
 */
@Controller()
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
        private readonly reconciler: QuotaReconcileService,
    ) {}

    /*
     * Paths are declared per method instead of on `@Controller(...)`: this file
     * serves two prefixes (`/admin/clients/:id/quotas` and
     * `/admin/quotas/reconcile`), and one class with explicit paths keeps both
     * surfaces on the same guards, scope and Swagger tag.
     */

    @Get('admin/clients/:id/quotas')
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

    @Put('admin/clients/:id/quotas')
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

    @Delete('admin/clients/:id/quotas/:aliasKey')
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

    @Post('admin/quotas/reconcile')
    @ApiOperation({
        summary: 'Recompute alias usage for a month from `request_logs` (idempotent).',
        description:
            'Rebuilds `client_alias_usage` from the persisted request logs, the durable record of ' +
            'what was actually served. `served_alias` decides who pays, so a request diverted from ' +
            'an exhausted alias is charged to its divert target and never to the alias it was diverted ' +
            'away from. Only pairs that OWN a quota row are reconciled — the same rule the live ' +
            'accounting applies. Writes are absolute values, so running this twice is a no-op. ' +
            '`dryRun` defaults to `true`: a destructive recompute should not be the accidental default.',
    })
    @ApiQuery({
        name: 'periodKey',
        required: false,
        example: '2026-11',
        description: 'UTC calendar month (`YYYY-MM`). Defaults to the month in progress.',
    })
    @ApiQuery({
        name: 'dryRun',
        required: false,
        example: 'true',
        description: '`true` (default) reports drift without writing; `false` repairs it.',
    })
    @ApiOkResponse({
        description: 'Reconciliation report.',
        schema: {
            example: {
                periodKey: '2026-11',
                dryRun: true,
                rowsScanned: 4_120,
                pairsConsidered: 3,
                drift: [
                    {
                        clientId: 'tenant-acme',
                        aliasKey: 'codex',
                        storedTokens: 19_999_000,
                        computedTokens: 20_000_150,
                        storedRequests: 120,
                        computedRequests: 121,
                    },
                ],
                repaired: 0,
            },
        },
    })
    @ApiBadRequestResponse({
        description:
            'Malformed query: `periodKey` is not `YYYY-MM`, `dryRun` is not a boolean, or an unknown parameter was sent.',
    })
    reconcile(@Query() raw: Record<string, string | boolean | undefined>): ReconcileReport {
        const q = this.parseReconcileQuery(raw);

        return this.reconciler.reconcile({
            periodKey: q.periodKey,
            // Absent means read-only. `dryRun` is already normalised above, so
            // this default is the only place the "dry run unless told
            // otherwise" rule lives.
            dryRun: q.dryRun ?? true,
        });
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

    /**
     * Validate the reconcile query with the same envelope the other admin
     * endpoints use (`invalid_query` + per-issue `path`/`message`), then hand the
     * normalised values to the handler. Both parameters are optional, so an
     * empty query is valid and means "current month, dry run".
     */
    private parseReconcileQuery(
        raw: Record<string, string | boolean | undefined>,
    ): ReconcileQuery {
        const parsed = ReconcileQuerySchema.safeParse(raw);
        if (!parsed.success) {
            throw new BadRequestException({
                error: {
                    message: 'Invalid query parameters',
                    type: 'invalid_request_error',
                    code: 'invalid_query',
                    issues: parsed.error.issues.map((issue) => ({
                        path: issue.path.join('.'),
                        message: issue.message,
                    })),
                },
            });
        }

        return parsed.data;
    }

    private assertAliasesExist(quotas: PutQuotasDto['quotas']): void {
        const aliases = this.registry.aliases;

        // R3-002: `aliases[key]` is a truthiness lookup on a plain object, so it
        // also matches everything inherited from `Object.prototype` — an alias
        // named `constructor`, `toString` or `__proto__` would sail through and
        // hand the router a function instead of a chain. Only an OWN property
        // that actually is an array counts as an alias.
        const aliasExists = (key: string): boolean =>
            Object.prototype.hasOwnProperty.call(aliases, key) &&
            Array.isArray(aliases[key]);

        quotas.forEach((entry, index) => {
            if (!aliasExists(entry.aliasKey)) {
                throw new BadRequestException(
                    `quotas[${index}].aliasKey: alias "${entry.aliasKey}" is not in the alias registry`,
                );
            }

            if (entry.divertAliasKey == null) {
                return;
            }

            if (!aliasExists(entry.divertAliasKey)) {
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

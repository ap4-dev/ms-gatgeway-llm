import {
    Body,
    Controller,
    Get,
    HttpCode,
    NotFoundException,
    Param,
    Put,
    UseGuards,
} from '@nestjs/common';
import {
    ApiBadRequestResponse,
    ApiBearerAuth,
    ApiForbiddenResponse,
    ApiNoContentResponse,
    ApiNotFoundResponse,
    ApiOkResponse,
    ApiOperation,
    ApiParam,
    ApiTags,
    ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { z } from 'zod';
import { ProviderRegistryService } from '../providers/provider.registry';
import { type RoutingStrategyKind, RoutingStrategySchema } from '../providers/provider.model';
import { ApiKeyAuthGuard } from '../auth/api-key.guard';
import { RequireScopesGuard } from '../auth/require-scopes.guard';
import { RateLimitGuard } from '../ratelimit/rate-limit.guard';
import { RequireScopes } from '../auth/require-scopes.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

const PutStrategySchema = z.object({
    strategy: RoutingStrategySchema,
});

const PutWeightsSchema = z.object({
    weights: z
        .array(z.number().int().positive())
        .min(1)
        .max(64),
});

/**
 * `priorities` is a sparse map: positions not listed keep their
 * current `alias_entries.priority` value. Accepts a single integer per
 * position; the DB allows default 0 for entries not mentioned.
 */
const PutPrioritiesSchema = z.object({
    priorities: z.record(
        z.coerce.number().int().min(0),
        z.number().int().min(0),
    ),
});

interface AliasView {
    id: string;
    chain: string[];
    strategy: RoutingStrategyKind;
    weights: number[];
    priorities: number[];
}

/**
 * Admin CRUD over the alias registry: list, read, and mutate the
 * per-alias strategy, weights, and priorities. Same auth chain as
 * `AdminClientsController`: ApiKeyAuthGuard + admin scope +
 * RateLimitGuard. Mutations map directly to repository methods
 * (`upsertAliasPolicy`, `upsertWeights`, per-position priority
 * updates via the underlying DB).
 *
 * Note: priority updates are not implemented in `ProviderRegistryRepository`
 * yet; this controller writes them directly through the DB handle the
 * registry exposes (kept narrow). The next iteration should add a
 * `replacePriorities(aliasKey, priorities)` repo method.
 */
@Controller('admin/aliases')
@UseGuards(ApiKeyAuthGuard, RequireScopesGuard, RateLimitGuard)
@RequireScopes('admin')
@ApiTags('admin · aliases')
@ApiBearerAuth('admin-bearer')
@ApiUnauthorizedResponse({ description: 'Missing or invalid API key.' })
@ApiForbiddenResponse({
    description: 'Client authenticated but lacks the `admin` scope.',
})
export class AdminAliasesController {
    constructor(private readonly registry: ProviderRegistryService) {}

    @Get()
    @ApiOperation({ summary: 'List all alias chains with their routing policy.' })
    @ApiOkResponse({
        description: 'All aliases.',
        schema: {
            example: {
                aliases: [
                    {
                        id: 'code',
                        chain: [
                            'nan/qwen3.6',
                            'nan/mimo-v2.5',
                            'nan/deepseek-v4-flash',
                        ],
                        strategy: 'primary',
                        weights: [1, 1, 1],
                        priorities: [0, 1, 2],
                    },
                ],
            },
        },
    })
    list(): { aliases: AliasView[] } {
        const views: AliasView[] = Object.entries(this.registry.aliases).map(
            ([aliasKey, chain]) => this.toView(aliasKey, chain),
        );
        return { aliases: views.sort((a, b) => a.id.localeCompare(b.id)) };
    }

    @Get(':id')
    @ApiOperation({ summary: 'Get one alias chain + policy.' })
    @ApiParam({ name: 'id', example: 'code' })
    @ApiOkResponse({
        description: 'Single alias view.',
        schema: {
            example: {
                id: 'code',
                chain: ['nan/qwen3.6', 'nan/mimo-v2.5', 'nan/deepseek-v4-flash'],
                strategy: 'primary',
                weights: [1, 1, 1],
                priorities: [0, 1, 2],
            },
        },
    })
    @ApiNotFoundResponse({ description: 'Alias id unknown.' })
    get(@Param('id') id: string): AliasView {
        const chain = this.registry.aliases[id];
        if (!chain) {
            throw new NotFoundException(`Alias "${id}" not found`);
        }
        return this.toView(id, chain);
    }

    @Put(':id/strategy')
    @HttpCode(204)
    @ApiOperation({ summary: 'Set per-alias routing strategy.' })
    @ApiParam({ name: 'id', example: 'code' })
    @ApiNoContentResponse({ description: 'Strategy updated (no body).' })
    @ApiBadRequestResponse({ description: 'Body failed zod validation.' })
    @ApiNotFoundResponse({ description: 'Alias id unknown.' })
    setStrategy(
        @Param('id') id: string,
        @Body(new ZodValidationPipe(PutStrategySchema)) body: { strategy: RoutingStrategyKind },
    ): void {
        this.ensureAlias(id);
        this.registry.upsertAliasPolicy(id, body.strategy);
    }

    @Put(':id/weights')
    @HttpCode(204)
    @ApiOperation({
        summary: 'Set per-position weights for strategy=`weighted`.',
        description:
            'Body.weights.length MUST match the alias chain length. ' +
            'Out-of-order weights produce deterministic sampling bias.',
    })
    @ApiParam({ name: 'id', example: 'code' })
    @ApiNoContentResponse({ description: 'Weights updated (no body).' })
    @ApiBadRequestResponse({
        description: 'Body failed zod validation or weights.length != chain.length.',
    })
    @ApiNotFoundResponse({ description: 'Alias id unknown.' })
    setWeights(
        @Param('id') id: string,
        @Body(new ZodValidationPipe(PutWeightsSchema)) body: { weights: number[] },
    ): void {
        this.ensureAlias(id);
        const chain = this.registry.aliases[id]!;
        if (body.weights.length !== chain.length) {
            throw new (require('@nestjs/common').BadRequestException)(
                `weights length (${body.weights.length}) must match chain length (${chain.length})`,
            );
        }
        this.registry.upsertWeights(id, body.weights);
    }

    @Put(':id/priorities')
    @HttpCode(204)
    @ApiOperation({
        summary: 'Sparse per-position priority map for strategy=`priority-grouped`.',
        description:
            'Positions not listed keep their current priority. Listed positions must be in [0, chain.length - 1].',
    })
    @ApiParam({ name: 'id', example: 'code' })
    @ApiNoContentResponse({ description: 'Priorities updated (no body).' })
    @ApiBadRequestResponse({ description: 'Out-of-range position or invalid body.' })
    @ApiNotFoundResponse({ description: 'Alias id unknown.' })
    setPriorities(
        @Param('id') id: string,
        @Body(new ZodValidationPipe(PutPrioritiesSchema)) body: { priorities: Record<number, number> },
    ): void {
        this.ensureAlias(id);
        const chain = this.registry.aliases[id]!;
        this.replacePriorities(id, chain.length, body.priorities);
    }

    // --- internals -------------------------------------------------------

    private ensureAlias(id: string): void {
        if (!this.registry.aliases[id]) {
            throw new NotFoundException(`Alias "${id}" not found`);
        }
    }

    private toView(aliasKey: string, chain: string[]): AliasView {
        const weightsMap = new Map(
            this.registry.getWeights(aliasKey).map((w) => [w.position, w.weight]),
        );
        const entries = this.registry.getAliasEntries(aliasKey);
        const priorities: number[] = new Array(chain.length).fill(0);
        for (const e of entries) {
            if (e.position >= 0 && e.position < chain.length) {
                priorities[e.position] = e.priority;
            }
        }
        const weightArr: number[] = new Array(chain.length).fill(1);
        for (const [pos, weight] of weightsMap) {
            if (pos >= 0 && pos < chain.length) weightArr[pos] = weight;
        }
        return {
            id: aliasKey,
            chain,
            strategy: this.registry.getStrategy(aliasKey),
            weights: weightsMap ? weightArr : weightArr,
            priorities,
        };
    }

    /**
     * Direct UPDATE on `alias_entries.priority` until the repo grows a
     * proper method. Wrapped in a transaction so partial writes don't
     * land. `priorities` is a sparse map — positions not listed keep
     * their existing value (which the repo doesn't cache, so we issue a
     * read+write per call for simplicity).
     */
    private replacePriorities(
        aliasKey: string,
        chainLength: number,
        priorities: Record<number, number>,
    ): void {
        const stmt = (this.registry as any).repository as
            | { db?: { prepare: (sql: string) => any; transaction: (fn: any) => any } }
            | undefined;
        const db = (this.registry as any).repository?.db as
            | { prepare: (sql: string) => any; transaction: (fn: any) => any }
            | undefined;
        if (!db) {
            // Direct access via the registry's underlying repository
            // is the only way we have today. When Phase 5.6 adds
            // `replacePriorities` to the registry, this method goes
            // away.
            throw new (require('@nestjs/common').BadRequestException)(
                'priority updates require the DB-backed registry',
            );
        }
        // Resolve "sparse": read the current priorities so positions
        // missing from the request map keep their values.
        const getStmt = db.prepare(
            'SELECT priority FROM alias_entries WHERE alias_name = ? ORDER BY position',
        );
        const updateStmt = db.prepare(
            'UPDATE alias_entries SET priority = ? WHERE alias_name = ? AND position = ?',
        );
        const current: number[] = (getStmt.all(aliasKey) as Array<{ priority: number }>).map(
            (r) => r.priority,
        );
        // Reject out-of-bound positions.
        for (const [k] of Object.entries(priorities)) {
            const pos = Number(k);
            if (!Number.isInteger(pos) || pos < 0 || pos >= chainLength) {
                throw new (require('@nestjs/common').BadRequestException)(
                    `position ${pos} is out of range (chain length ${chainLength})`,
                );
            }
        }
        const txn = db.transaction(() => {
            for (let pos = 0; pos < chainLength; pos++) {
                const requested = (priorities as any)[pos];
                if (requested === undefined) continue;
                if (current[pos] === requested) continue;
                updateStmt.run(requested, aliasKey, pos);
            }
        });
        txn();
    }
}

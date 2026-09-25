import {
    Body,
    ConflictException,
    Controller,
    Delete,
    Get,
    HttpCode,
    NotFoundException,
    Param,
    Patch,
    Post,
    UseGuards,
} from '@nestjs/common';
import {
    ApiBadRequestResponse,
    ApiBearerAuth,
    ApiConflictResponse,
    ApiCreatedResponse,
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
import { ProviderRegistryRepository } from '../database/repositories/provider-registry.repository';
import { ApiKeyAuthGuard } from '../auth/api-key.guard';
import { RequireScopesGuard } from '../auth/require-scopes.guard';
import { RateLimitGuard } from '../ratelimit/rate-limit.guard';
import { RequireScopes } from '../auth/require-scopes.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

/**
 * Provider ids are routing keys and CLI arguments; keep them to the same
 * conservative alphabet the other admin surfaces use.
 */
const ProviderIdSchema = z
    .string()
    .max(64)
    .regex(/^[a-z0-9][a-z0-9_-]*$/, {
        message: 'id must be lowercase letters, digits, underscores or hyphens',
    });

const CreateProviderSchema = z.object({
    id: ProviderIdSchema,
    // NAME of the env var holding the key — never the key itself.
    apiKeyEnv: z.string().min(1).max(120),
    baseUrl: z.string().max(300).url().optional(),
    timeoutMs: z.number().int().positive().optional(),
    supportsSearch: z.boolean().optional(),
});

const PatchProviderSchema = z.object({
    apiKeyEnv: z.string().min(1).max(120).optional(),
    baseUrl: z.string().max(300).url().optional(),
    timeoutMs: z.number().int().positive().optional(),
    supportsSearch: z.boolean().optional(),
});

const CreateModelSchema = z.object({
    modelKey: z.string().min(1).max(120),
    realName: z.string().min(1).max(200),
    maxTokens: z.number().int().positive().optional(),
    supportsStream: z.boolean().optional(),
    disableThinking: z.boolean().optional(),
});

const PatchModelSchema = z.object({
    realName: z.string().min(1).max(200).optional(),
    maxTokens: z.number().int().positive().optional(),
    supportsStream: z.boolean().optional(),
    disableThinking: z.boolean().optional(),
});

interface ProviderModelView {
    modelKey: string;
    realName: string;
    maxTokens: number | null;
    supportsStream: boolean;
    disableThinking: boolean;
    /** Alias names whose chain contains this exact `provider/model` entry. */
    usedInAliases: string[];
}

interface ProviderView {
    id: string;
    /** Environment variable NAME that holds the key — never the key value. */
    apiKeyEnv: string;
    baseUrl: string | null;
    timeoutMs: number | null;
    supportsSearch: boolean;
    models: ProviderModelView[];
}

/**
 * Admin CRUD over providers and their models.
 *
 * Backed by `ProviderRegistryRepository` (better-sqlite3, synchronous). The
 * registry reads the DB on every request, so writes here are visible to the
 * next `/v1/*` call with no cache invalidation.
 *
 * Deliberate semantics:
 *  - `apiKeyEnv` is the *name* of an env var (e.g. `NAN_API_KEY`); actual key
 *    material is never accepted or returned. A provider whose env var is
 *    unset at runtime is simply skipped by `GET /v1/models`.
 *  - Deleting a provider or model that still backs an alias is refused with
 *    409 instead of relying on the FK cascade, which would silently leave the
 *    alias chain broken.
 *
 * Auth mirrors the other admin controllers: ApiKeyAuthGuard + admin scope +
 * RateLimitGuard, with `ZodValidationPipe` producing the shared `issues`
 * error envelope on bad bodies.
 */
@Controller('admin/providers')
@UseGuards(ApiKeyAuthGuard, RequireScopesGuard, RateLimitGuard)
@RequireScopes('admin')
@ApiTags('admin · providers')
@ApiBearerAuth('admin-bearer')
@ApiUnauthorizedResponse({ description: 'Missing or invalid API key.' })
@ApiForbiddenResponse({
    description: 'Client authenticated but lacks the `admin` scope.',
})
export class AdminProvidersController {
    constructor(private readonly registry: ProviderRegistryService) {}

    private get repo(): ProviderRegistryRepository {
        return this.registry.repository;
    }

    @Get()
    @ApiOperation({ summary: 'List providers, their models and alias usage.' })
    @ApiOkResponse({
        description: 'All providers sorted by id.',
        schema: {
            example: {
                providers: [
                    {
                        id: 'nan',
                        apiKeyEnv: 'NAN_API_KEY',
                        baseUrl: 'https://api.nan.builders/v1',
                        timeoutMs: 180000,
                        supportsSearch: true,
                        models: [
                            {
                                modelKey: 'qwen',
                                realName: 'qwen3.6',
                                maxTokens: null,
                                supportsStream: true,
                                disableThinking: false,
                                usedInAliases: ['coder'],
                            },
                        ],
                    },
                ],
            },
        },
    })
    list(): { providers: ProviderView[] } {
        const providers = this.registry.providers;
        const usage = this.aliasUsage();
        return {
            providers: Object.keys(providers)
                .sort()
                .map((id) => this.toView(id, usage)),
        };
    }

    @Post()
    @ApiOperation({ summary: 'Create a provider.' })
    @ApiCreatedResponse({ description: 'Provider created.' })
    @ApiBadRequestResponse({ description: 'Body failed zod validation.' })
    @ApiConflictResponse({ description: 'A provider with this id already exists.' })
    create(
        @Body(new ZodValidationPipe(CreateProviderSchema))
        body: z.infer<typeof CreateProviderSchema>,
    ): ProviderView {
        if (this.registry.has(body.id)) {
            throw new ConflictException(`Provider "${body.id}" already exists`);
        }
        this.repo.createProvider({
            id: body.id,
            apiKeyEnv: body.apiKeyEnv,
            baseURL: body.baseUrl,
            timeoutMs: body.timeoutMs,
            supportsSearch: body.supportsSearch,
        });
        return this.toView(body.id, this.aliasUsage());
    }

    @Patch(':id')
    @ApiOperation({ summary: 'Partially update a provider.' })
    @ApiParam({ name: 'id', example: 'nan' })
    @ApiOkResponse({ description: 'Updated provider view.' })
    @ApiBadRequestResponse({ description: 'Body failed zod validation.' })
    @ApiNotFoundResponse({ description: 'Provider id unknown.' })
    patch(
        @Param('id') id: string,
        @Body(new ZodValidationPipe(PatchProviderSchema))
        body: z.infer<typeof PatchProviderSchema>,
    ): ProviderView {
        this.ensureProvider(id);
        this.repo.updateProvider(id, {
            apiKeyEnv: body.apiKeyEnv,
            baseURL: body.baseUrl,
            timeoutMs: body.timeoutMs,
            supportsSearch: body.supportsSearch,
        });
        return this.toView(id, this.aliasUsage());
    }

    @Delete(':id')
    @HttpCode(204)
    @ApiOperation({
        summary: 'Delete a provider',
        description:
            'Refused with 409 while any alias chain still references the provider.',
    })
    @ApiParam({ name: 'id', example: 'nan' })
    @ApiNoContentResponse({ description: 'Provider deleted.' })
    @ApiNotFoundResponse({ description: 'Provider id unknown.' })
    @ApiConflictResponse({ description: 'The provider still backs one or more aliases.' })
    remove(@Param('id') id: string): void {
        this.ensureProvider(id);
        const aliases = this.repo.aliasesUsingProvider(id);
        if (aliases.length > 0) {
            throw new ConflictException(
                `Provider "${id}" is used by aliases (${aliases.join(
                    ', ',
                )}); remove it from those chains first`,
            );
        }
        this.repo.deleteProvider(id);
    }

    @Post(':id/models')
    @ApiOperation({ summary: 'Add a model to a provider.' })
    @ApiParam({ name: 'id', example: 'nan' })
    @ApiCreatedResponse({ description: 'Model created.' })
    @ApiBadRequestResponse({ description: 'Body failed zod validation.' })
    @ApiNotFoundResponse({ description: 'Provider id unknown.' })
    @ApiConflictResponse({ description: 'The provider already has this model key.' })
    createModel(
        @Param('id') id: string,
        @Body(new ZodValidationPipe(CreateModelSchema))
        body: z.infer<typeof CreateModelSchema>,
    ): ProviderModelView {
        this.ensureProvider(id);
        if (this.repo.modelExists(id, body.modelKey)) {
            throw new ConflictException(
                `Model "${body.modelKey}" already exists on provider "${id}"`,
            );
        }
        this.repo.createModel(id, body.modelKey, {
            real: body.realName,
            maxTokens: body.maxTokens,
            supportsStream: body.supportsStream,
            disableThinking: body.disableThinking,
        });
        return this.modelView(id, body.modelKey, this.aliasUsage());
    }

    @Patch(':id/models/:modelKey')
    @ApiOperation({ summary: 'Partially update a provider model.' })
    @ApiParam({ name: 'id', example: 'nan' })
    @ApiParam({ name: 'modelKey', example: 'qwen' })
    @ApiOkResponse({ description: 'Updated model view.' })
    @ApiBadRequestResponse({ description: 'Body failed zod validation.' })
    @ApiNotFoundResponse({ description: 'Provider id or model key unknown.' })
    patchModel(
        @Param('id') id: string,
        @Param('modelKey') modelKey: string,
        @Body(new ZodValidationPipe(PatchModelSchema))
        body: z.infer<typeof PatchModelSchema>,
    ): ProviderModelView {
        this.ensureProvider(id);
        this.ensureModel(id, modelKey);
        this.repo.updateModel(id, modelKey, {
            realName: body.realName,
            maxTokens: body.maxTokens,
            supportsStream: body.supportsStream,
            disableThinking: body.disableThinking,
        });
        return this.modelView(id, modelKey, this.aliasUsage());
    }

    @Delete(':id/models/:modelKey')
    @HttpCode(204)
    @ApiOperation({
        summary: 'Delete a provider model',
        description:
            'Refused with 409 while any alias chain still references the model.',
    })
    @ApiParam({ name: 'id', example: 'nan' })
    @ApiParam({ name: 'modelKey', example: 'qwen' })
    @ApiNoContentResponse({ description: 'Model deleted.' })
    @ApiNotFoundResponse({ description: 'Provider id or model key unknown.' })
    @ApiConflictResponse({ description: 'The model still backs one or more aliases.' })
    removeModel(@Param('id') id: string, @Param('modelKey') modelKey: string): void {
        this.ensureProvider(id);
        this.ensureModel(id, modelKey);
        const aliases = this.repo.aliasesUsingModel(id, modelKey);
        if (aliases.length > 0) {
            throw new ConflictException(
                `Model "${modelKey}" on provider "${id}" is used by aliases (${aliases.join(
                    ', ',
                )}); remove it from those chains first`,
            );
        }
        this.repo.deleteModel(id, modelKey);
    }

    // --- internals -------------------------------------------------------

    private ensureProvider(id: string): void {
        if (!this.registry.has(id)) {
            throw new NotFoundException(`Provider "${id}" not found`);
        }
    }

    private ensureModel(providerId: string, modelKey: string): void {
        if (!this.repo.modelExists(providerId, modelKey)) {
            throw new NotFoundException(
                `Model "${modelKey}" not found on provider "${providerId}"`,
            );
        }
    }

    /**
     * Invert the alias registry into `provider/model` -> alias names, so each
     * model view can report which aliases would break if it were deleted.
     */
    private aliasUsage(): Map<string, string[]> {
        const usage = new Map<string, string[]>();
        for (const [aliasName, chain] of Object.entries(this.registry.aliases)) {
            for (const path of chain) {
                const arr = usage.get(path) ?? [];
                arr.push(aliasName);
                usage.set(path, arr);
            }
        }
        for (const arr of usage.values()) arr.sort();
        return usage;
    }

    private toView(id: string, usage: Map<string, string[]>): ProviderView {
        const cfg = this.registry.providers[id];
        const models = Object.entries(cfg.models)
            .map(([modelKey, model]) => ({
                modelKey,
                realName: model.real,
                maxTokens: model.maxTokens ?? null,
                supportsStream: model.supportsStream !== false,
                disableThinking: model.disableThinking === true,
                usedInAliases: usage.get(`${id}/${modelKey}`) ?? [],
            }))
            .sort((a, b) => a.modelKey.localeCompare(b.modelKey));
        return {
            id,
            apiKeyEnv: cfg.apiKeyEnv,
            baseUrl: cfg.baseURL ?? null,
            timeoutMs: cfg.timeoutMs ?? null,
            supportsSearch: cfg.supportsSearch === true,
            models,
        };
    }

    private modelView(
        providerId: string,
        modelKey: string,
        usage: Map<string, string[]>,
    ): ProviderModelView {
        const model = this.registry.providers[providerId].models[modelKey];
        return {
            modelKey,
            realName: model.real,
            maxTokens: model.maxTokens ?? null,
            supportsStream: model.supportsStream !== false,
            disableThinking: model.disableThinking === true,
            usedInAliases: usage.get(`${providerId}/${modelKey}`) ?? [],
        };
    }
}

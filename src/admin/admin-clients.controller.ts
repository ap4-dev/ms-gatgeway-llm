import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    NotFoundException,
    Param,
    Patch,
    Post,
    UseGuards,
    UsePipes,
} from '@nestjs/common';
import { z } from 'zod';
import { ClientService } from '../auth/client.service';
import type { Client } from '../auth/client.repository';
import { ApiKeyAuthGuard } from '../auth/api-key.guard';
import { RequireScopesGuard } from '../auth/require-scopes.guard';
import { RateLimitGuard } from '../ratelimit/rate-limit.guard';
import { RequireScopes } from '../auth/require-scopes.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

const CreateClientSchema = z.object({
    id: z
        .string()
        .min(1)
        .max(64)
        .regex(/^[a-z0-9][a-z0-9_-]*$/, {
            message:
                'id must be lowercase letters, digits, underscores or hyphens',
        })
        .optional(),
    name: z.string().min(1).max(120),
    scopes: z.array(z.string().min(1)).min(1).optional(),
    rateLimitRpm: z.coerce
        .number()
        .int()
        .positive()
        .max(100_000)
        .optional(),
    rateLimitTpm: z.coerce
        .number()
        .int()
        .positive()
        .max(100_000_000)
        .optional(),
});

const PatchClientSchema = z.object({
    name: z.string().min(1).max(120).optional(),
    scopes: z.array(z.string().min(1)).min(1).optional(),
    rateLimitRpm: z.coerce.number().int().positive().max(100_000).optional(),
    rateLimitTpm: z.coerce.number().int().positive().max(100_000_000).nullable().optional(),
});

type CreateClientDto = z.infer<typeof CreateClientSchema>;
type PatchClientDto = z.infer<typeof PatchClientSchema>;

interface ClientView {
    id: string;
    name: string;
    scopes: string[];
    rateLimitRpm: number;
    rateLimitTpm: number | null;
    apiKeyPrefix: string;
    createdAt: number;
    lastUsedAt: number | null;
    revoked: boolean;
}

interface ClientCreatedView extends ClientView {
    plaintextApiKey: string;
    warning: string;
}

/**
 * Phase 5.5 admin CRUD for clients. Every endpoint requires a client
 * whose `scopes` includes `admin` (enforced by `RequireScopesGuard`).
 * Auth via `ApiKeyAuthGuard`; rate-limit via `RateLimitGuard`.
 *
 * Responses NEVER include the stored api_key_hash. `POST /admin/clients`
 * and `POST /admin/clients/:id/rotate` return the plaintext key one
 * time so the operator can hand it out.
 */
@Controller('admin/clients')
@UseGuards(ApiKeyAuthGuard, RequireScopesGuard, RateLimitGuard)
@RequireScopes('admin')
export class AdminClientsController {
    constructor(private readonly clients: ClientService) {}

    @Get()
    list(): { clients: ClientView[] } {
        return { clients: this.clients.list().map(toView) };
    }

    @Get(':id')
    get(@Param('id') id: string): ClientView {
        const client = this.mustFind(id);
        return toView(client);
    }

    @Post()
    @UsePipes(new ZodValidationPipe(CreateClientSchema))
    create(@Body() body: CreateClientDto): ClientCreatedView {
        const id = body.id ?? generateSlugId();
        const existing = this.clients.findById(id);
        if (existing) {
            // Surface a 409-equivalent by throwing a generic conflict.
            // NestJS 11 ships `ConflictException`; use it.
            throw new (require('@nestjs/common').ConflictException)(
                `Client "${id}" already exists`,
            );
        }
        const { client, plaintextApiKey } = this.clients.create({
            id,
            name: body.name,
            scopes: body.scopes,
            rateLimitRpm: body.rateLimitRpm,
            rateLimitTpm: body.rateLimitTpm ?? null,
        });
        return {
            ...toView(client),
            plaintextApiKey,
            warning:
                'Save this API key now. It will never be shown again.',
        };
    }

    @Patch(':id')
    @UsePipes(new ZodValidationPipe(PatchClientSchema))
    update(
        @Param('id') id: string,
        @Body() body: PatchClientDto,
    ): ClientView {
        const updated = this.clients.update(id, {
            name: body.name,
            scopes: body.scopes,
            rateLimitRpm: body.rateLimitRpm,
            rateLimitTpm: body.rateLimitTpm,
        });
        return toView(updated);
    }

    @Post(':id/rotate')
    @HttpCode(200)
    rotate(@Param('id') id: string): ClientView & {
        plaintextApiKey: string;
        warning: string;
    } {
        const { client, plaintextApiKey } = this.clients.rotateKey(id);
        return {
            ...toView(client),
            plaintextApiKey,
            warning:
                'Save this API key now. It will never be shown again.',
        };
    }

    @Post(':id/revoke')
    @HttpCode(204)
    revoke(@Param('id') id: string): void {
        this.mustFind(id); // 404 before mutating.
        this.clients.revoke(id);
    }

    @Delete(':id')
    @HttpCode(204)
    remove(@Param('id') id: string): void {
        const existing = this.clients.findById(id);
        if (!existing) {
            throw new NotFoundException(`Client "${id}" not found`);
        }
        this.clients.delete(id);
    }

    private mustFind(id: string): Client {
        const client = this.clients.findById(id);
        if (!client) {
            throw new NotFoundException(`Client "${id}" not found`);
        }
        return client;
    }
}

function toView(client: Client): ClientView {
    return {
        id: client.id,
        name: client.name,
        scopes: client.scopes,
        rateLimitRpm: client.rateLimitRpm,
        rateLimitTpm: client.rateLimitTpm,
        apiKeyPrefix: client.apiKeyPrefix,
        createdAt: client.createdAt,
        lastUsedAt: client.lastUsedAt,
        revoked: client.revoked,
    };
}

/**
 * Quick & dirty slug generator for clients created without an explicit
 * id. Tenant ids should ideally be supplied; this fallback exists so
 * the endpoint remains ergonomic in tests and one-off scripts.
 */
function generateSlugId(): string {
    return 'c_' + Math.random().toString(36).slice(2, 10);
}

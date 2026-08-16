import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AdminModule } from './admin/admin.module';

/**
 * Bootstrap Swagger at `/docs` documenting ONLY the admin surface.
 *
 * Public `/v1/...` endpoints (chat completions, models, health, metrics)
 * are deliberately excluded: the gateway's external API surface is what
 * clients see and is already covered by `docs/API.md`. Swagger is for
 * operators poking at `/admin/...` and need an interactive reference.
 *
 * Authentication matches the runtime contract — Bearer token in the
 * Swagger UI's Authorize dialog is forwarded on each try-out request.
 */
export function setupSwagger(app: INestApplication): void {
    const config = new DocumentBuilder()
        .setTitle('ms-gateway-llm · Admin API')
        .setDescription(
            'Operator surface for client CRUD, alias routing policy, and ' +
                'request-log inspection. Auth: `admin` scope API key. ' +
                'Public /v1/... endpoints are documented separately in `docs/API.md` ' +
                'and are intentionally excluded from this OpenAPI spec.',
        )
        .setVersion('0.0.1')
        .addBearerAuth(
            {
                type: 'http',
                scheme: 'bearer',
                bearerFormat: 'sk-…',
                description:
                    'API key with the `admin` scope (Authorization: Bearer sk-…)',
            },
            'admin-bearer',
        )
        .addTag('admin · clients', 'Create, read, rotate, revoke clients.')
        .addTag('admin · aliases', 'Per-alias chain + routing policy.')
        .addTag('admin · logs', 'Recent request_logs with filters.')
        .build();

    // `include: [AdminModule]` keeps the spec narrow — the chat, health,
    // models, metrics, and observability modules are not scanned.
    const document = SwaggerModule.createDocument(app, config, {
        include: [AdminModule],
    });

    SwaggerModule.setup('docs', app, document, {
        swaggerOptions: {
            persistAuthorization: true,
            tryItOutEnabled: true,
        },
        customSiteTitle: 'ms-gateway-llm · Admin API · /docs',
    });
}

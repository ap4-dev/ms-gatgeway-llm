import "newrelic";
import 'dotenv/config';
import "./sentry.instrument";
process.env.TZ = process.env.TZ || 'America/Santiago';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AppJsonLogger } from "./app.logger";

import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inyectEnv } from './app.enviroment.js';
import { getEnv } from './config/env.schema';
import { buildCorsHandler } from './config/cors.config';
import { setupSwagger } from './swagger.setup';

async function msCoreOne() {
  await inyectEnv();
  // Validate the merged env (Doppler + .env). Throws on missing required keys
  // so misconfiguration fails fast at startup rather than on first request.
  const env = getEnv();
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      logger: true,
      trustProxy: true,
    }),
    {
      bufferLogs: true,
    }
  );

//  await app.register(fastifyCookie as any);
  await app.register(fastifyWebsocket as any);

  // /assets, /favicon, etc. that /docs (Swagger UI) requests. The UI is
  // served by @fastify/swagger-ui inside SwaggerModule.setup; the assets
  // here cover the static bits that ship with @nestjs/swagger.
  app.register(fastifyStatic as any, {
    root: require('node:path').join(__dirname, '..'),
    serve: false,
    wildcard: false,
  });

  app.enableCors({
    origin: buildCorsHandler(env.CORS_ORIGINS) as any,
    methods: 'GET,HEAD,PUT,PATCH,POST,OPTIONS',
    credentials: true,
  });
  app.register(fastifyMultipart as any, {
    limits: {
      fileSize: 10 * 1024 * 1024, // 10MB
    },
  });
//  app.setGlobalPrefix('v1', {
//    exclude: ['docs', 'docs-json'],
//  });

  // Swagger UI at /docs. DocumentBuilder in src/swagger.setup.ts
  // limits the spec to AdminModule only.
  setupSwagger(app);

  // Admin dashboard SPA (Vue 3 + Vite, built into /dist-dashboard by
  // `pnpm dashboard:build`). It is served under /dashboard/ so it coexists
  // with /v1, /admin and /docs.
  //
  // `wildcard: false` makes @fastify/static register one exact route per
  // emitted file (plus `/dashboard/` -> index.html) instead of its own
  // catch-all route. That leaves GET /dashboard/* free for the SPA history
  // fallback below, and `decorateReply: false` avoids re-decorating
  // `reply.sendFile`, which the Swagger static registration above already did.
  const dashboardRoot = join(__dirname, '..', 'dist-dashboard');
  const dashboardIndexPath = join(dashboardRoot, 'index.html');
  if (existsSync(dashboardIndexPath)) {
    app.register(fastifyStatic as any, {
      root: dashboardRoot,
      prefix: '/dashboard/',
      decorateReply: false,
      wildcard: false,
    });

    // The SPA shell is immutable for the process lifetime; read it once.
    const dashboardIndexHtml = readFileSync(dashboardIndexPath, 'utf8');
    const fastify = app.getHttpAdapter().getInstance();

    // History-mode fallback, scoped strictly to the /dashboard prefix: client
    // routes such as /dashboard/overview have no file on disk and must resolve
    // to the SPA shell. API 404s under /admin, /v1 and /docs are untouched
    // because these handlers only match /dashboard.
    fastify.get('/dashboard', (_request, reply) =>
      reply.type('text/html; charset=utf-8').send(dashboardIndexHtml),
    );
    fastify.get('/dashboard/*', (_request, reply) =>
      reply.type('text/html; charset=utf-8').send(dashboardIndexHtml),
    );
  } else {
    console.warn(
      `⚠️  Dashboard bundle not found at ${dashboardRoot}; /dashboard/ is disabled. Run \`pnpm dashboard:build\`.`,
    );
  }

  const logger = app.get(AppJsonLogger);
  app.useLogger(logger);
  await app.listen(env.PORT, '0.0.0.0');
  console.log(`🚀 Microservicio ms-gateway iniciado en puerto ${env.PORT}`);

  process.on('SIGINT', async () => {
    console.log('⚠️  SIGINT recibido, cerrando gracefully...');
    await app.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('⚠️  SIGTERM recibido, cerrando gracefully...');
    await app.close();
    process.exit(0);
  });

  if (process.send) {
    process.send('ready');
  }
}
msCoreOne();

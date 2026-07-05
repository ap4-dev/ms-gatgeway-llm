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
import fastifyWebsocket from '@fastify/websocket';
import { inyectEnv } from './app.enviroment.js';
import { getEnv } from './config/env.schema';
import { buildCorsHandler } from './config/cors.config';

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
  app.setGlobalPrefix('v1');
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

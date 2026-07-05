import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TerminusModule } from '@nestjs/terminus';

import { APP_FILTER } from '@nestjs/core';
import { SentryModule } from '@sentry/nestjs/setup';
import { SentryGlobalFilter } from '@sentry/nestjs/setup';

import { AppJsonLogger } from './app.logger.js';
import { RedisService } from './redis.service';
import { ChatModule } from './chat/chat.module';
import { CoreModule } from './config/core.module';

@Module({
    imports: [
        ConfigModule.forRoot({ isGlobal: true }), TerminusModule,
        SentryModule.forRoot(), CoreModule, ChatModule,
    ],
    controllers: [AppController],
    providers: [
        {
            provide: APP_FILTER,
            useClass: SentryGlobalFilter,
        },
        AppJsonLogger, RedisService
    ],
})
export class AppModule { }

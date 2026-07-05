import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { AppJsonLogger } from './app.logger';
import { ENV, PROJECT } from './app.enviroment';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
    private readonly context = RedisService.name;
    private client: Redis;

    constructor(private configService: ConfigService, private readonly logger: AppJsonLogger) { }

    async onModuleInit() {
        this.client = new Redis(this.configService.get<string>('REDIS_URL') || 'redis://localhost:6379', {
            keyPrefix: `${PROJECT}:${ENV}:`,
            retryStrategy: (times) => Math.min(times * 50, 2000),
            keepAlive: 10000,
            family: 0
        });

        this.client.on('connect', () => this.logger.log('✅ Connected to Redis', this.context));
        this.client.on('error', (err) => this.logger.error(`❌ Redis Client Error ${err}`, this.context));
    }

    async onModuleDestroy() {
        await this.client.quit();
        this.logger.log('Redis disconnected', this.context);
    }

    getClient(): Redis {
        return this.client;
    }

    // Métodos útiles
    async get(key: string): Promise<string | null> {
        return this.client.get(key);
    }

    async set(key: string, value: string, ttl?: number): Promise<void> {
        if (ttl) {
            await this.client.set(key, value, 'EX', ttl);
        } else {
            await this.client.set(key, value);
        }
    }

    async del(key: string): Promise<void> {
        await this.client.del(key);
    }

    async getJson<T>(key: string): Promise<T | null> {
        const data = await this.client.get(key);
        return data ? JSON.parse(data) : null;
    }

    async setJson<T>(key: string, value: T, ttl?: number): Promise<void> {
        await this.set(key, JSON.stringify(value), ttl);
    }
}
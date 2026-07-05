import { Provider } from '@nestjs/common';
import { getEnv } from './env.schema';
import type { Env } from './env.schema';

export const ENV_CONFIG = Symbol('ENV_CONFIG');

export const envProvider: Provider = {
    provide: ENV_CONFIG,
    useFactory: (): Env => getEnv(),
};

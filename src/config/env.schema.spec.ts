import { getEnv, resetEnvCache } from './env.schema';

describe('env schema', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        resetEnvCache();
        process.env = {
            ...originalEnv,
            LLM_PROVIDER_API_KEY: 'sk-test',
            LLM_PROVIDER_BASE_URL: 'https://example.com/v1',
        };
    });

    afterEach(() => {
        process.env = originalEnv;
        resetEnvCache();
    });

    it('accepts standard NODE_ENV values', () => {
        process.env.NODE_ENV = 'development';
        expect(getEnv().NODE_ENV).toBe('development');

        process.env.NODE_ENV = 'staging';
        resetEnvCache();
        expect(getEnv().NODE_ENV).toBe('staging');

        process.env.NODE_ENV = 'production';
        resetEnvCache();
        expect(getEnv().NODE_ENV).toBe('production');
    });

    it('normalizes Doppler project aliases to canonical Node values', () => {
        process.env.NODE_ENV = 'dev';
        expect(getEnv().NODE_ENV).toBe('development');

        process.env.NODE_ENV = 'develop';
        resetEnvCache();
        expect(getEnv().NODE_ENV).toBe('development');

        process.env.NODE_ENV = 'stg';
        resetEnvCache();
        expect(getEnv().NODE_ENV).toBe('staging');

        process.env.NODE_ENV = 'prd';
        resetEnvCache();
        expect(getEnv().NODE_ENV).toBe('production');

        process.env.NODE_ENV = 'prod';
        resetEnvCache();
        expect(getEnv().NODE_ENV).toBe('production');
    });

    it('rejects unknown NODE_ENV values', () => {
        process.env.NODE_ENV = 'staginggg';
        expect(() => getEnv()).toThrow(/NODE_ENV/);
    });

    it('requires LLM_PROVIDER_API_KEY', () => {
        delete process.env.LLM_PROVIDER_API_KEY;
        expect(() => getEnv()).toThrow(/LLM_PROVIDER_API_KEY/);
    });

    it('parses PORT as a positive integer with default', () => {
        delete process.env.PORT;
        expect(getEnv().PORT).toBe(3000);

        process.env.PORT = '3400';
        resetEnvCache();
        expect(getEnv().PORT).toBe(3400);
    });
});

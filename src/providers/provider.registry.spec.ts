import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { loadProvidersFile } from './provider.registry';

const validRegistry = {
    providers: {
        nan: {
            apiKeyEnv: 'NAN_API_KEY',
            baseURL: 'https://api.nan.builders/v1',
            models: {
                'qwen3.6': { real: 'qwen3.6' },
                'qwen3-coder': { real: 'qwen3-coder', maxTokens: 16384 },
            },
        },
    },
    aliases: {
        default: ['nan/qwen3.6'],
        coder: ['nan/qwen3-coder'],
    },
};

function writeTemp(suffix: string, content: object | string): string {
    const dir = mkdtempSync(join(tmpdir(), 'ms-providers-'));
    const path = join(dir, suffix);
    writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
    return path;
}

describe('loadProvidersFile', () => {
    let dir: string | undefined;

    afterEach(() => {
        if (dir) rmSync(dir, { recursive: true, force: true });
        dir = undefined;
    });

    it('parses a valid registry file', () => {
        const file = writeTemp('p.json', validRegistry);
        dir = join(file, '..');

        const parsed = loadProvidersFile(file);
        expect(Object.keys(parsed.providers)).toEqual(['nan']);
        expect(parsed.providers.nan.models['qwen3-coder'].maxTokens).toBe(16384);
        expect(parsed.aliases?.default).toEqual(['nan/qwen3.6']);
    });

    it('rejects an unreadable file path', () => {
        expect(() => loadProvidersFile('/nonexistent/providers.json')).toThrow(
            /Cannot read providers registry/,
        );
    });

    it('rejects malformed JSON', () => {
        const file = writeTemp('p.json', '{ this is not json');
        dir = join(file, '..');
        expect(() => loadProvidersFile(file)).toThrow(/Invalid JSON/);
    });

    it('rejects JSON that violates the schema (missing real name)', () => {
        const broken = {
            providers: {
                nan: {
                    apiKeyEnv: 'NAN_API_KEY',
                    models: {
                        'qwen3.6': { /* missing real */ },
                    },
                },
            },
        };
        const file = writeTemp('p.json', broken);
        dir = join(file, '..');
        expect(() => loadProvidersFile(file)).toThrow(
            /does not match schema/,
        );
    });

    it('rejects aliases that do not follow provider/model syntax', () => {
        const broken = {
            providers: { nan: { apiKeyEnv: 'N', models: { m: { real: 'r' } } } },
            aliases: { default: ['just-a-name'] },
        };
        const file = writeTemp('p.json', broken);
        dir = join(file, '..');
        expect(() => loadProvidersFile(file)).toThrow(
            /does not match schema/,
        );
    });
});

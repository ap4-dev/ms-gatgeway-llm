import {
    parseArgs,
    generateCredentials,
    buildResetSql,
    buildCreateSql,
    formatOutput,
    buildOutput,
    readPepper,
    CliError,
    type AdminResetOutput,
} from './admin-reset-cli';

const PEPPER = 'unit-test-pepper-' + 'a'.repeat(32);

describe('parseArgs', () => {
    it('returns help=true with --help', () => {
        expect(parseArgs(['--help'])).toEqual({ _: [], help: true });
    });

    it('captures --reset <id>', () => {
        expect(parseArgs(['--reset', 'admin'])).toEqual({
            _: [],
            reset: 'admin',
        });
    });

    it('captures --create plus its companion flags', () => {
        const out = parseArgs([
            '--create',
            '--id', 'tenant-acme',
            '--name', 'Acme Co.',
            '--rpm', '300',
            '--scopes', 'chat.read,chat.write',
        ]);
        expect(out.create).toBe(true);
        expect(out.id).toBe('tenant-acme');
        expect(out.name).toBe('Acme Co.');
        expect(out.rpm).toBe(300);
        expect(out.scopes).toBe('chat.read,chat.write');
    });

    it('coerces --rpm to a number', () => {
        expect(parseArgs(['--rpm', '600']).rpm).toBe(600);
    });

    it('preserves positional args in `_`', () => {
        expect(parseArgs(['reset', 'admin'])._).toEqual(['reset', 'admin']);
    });

    it('returns an empty `_: []` for bare invocation', () => {
        expect(parseArgs([])).toEqual({ _: [] });
    });

    it('captures --plain <key>', () => {
        expect(parseArgs(['--plain', 'sk-mykey123'])).toEqual({
            _: [],
            plain: 'sk-mykey123',
        });
    });

    it('captures --plain alongside --reset', () => {
        const out = parseArgs(['--reset', 'admin', '--plain', 'sk-existingkey']);
        expect(out.reset).toBe('admin');
        expect(out.plain).toBe('sk-existingkey');
    });
});

describe('generateCredentials', () => {
    it('produces a `sk-...` plaintext, 8-char prefix, and `hmac$<64-hex>` stored value', () => {
        const fixedPlain = 'sk-aaaaabbbcccddddeeeffgghhiijjkkllmmnnooppqqrrss';
        const out = generateCredentials({ plain: fixedPlain, pepper: PEPPER });
        expect(out.plain).toBe(fixedPlain);
        expect(out.prefix).toBe('sk-aaaaa');
        expect(out.stored).toMatch(/^hmac\$[0-9a-f]{64}$/);
    });

    it('is deterministic — same plaintext + pepper always produces the same hash', () => {
        const plain = 'sk-sameplainxxxxxxxxxxxxxxxxxxxxxxxxxx';
        const a = generateCredentials({ plain, pepper: PEPPER });
        const b = generateCredentials({ plain, pepper: PEPPER });
        expect(a.stored).toBe(b.stored);
        expect(a.prefix).toBe(b.prefix);
    });

    it('differs for the same plaintext under a different pepper', () => {
        const plain = 'sk-sameplainxxxxxxxxxxxxxxxxxxxxxxxxxx';
        const a = generateCredentials({ plain, pepper: PEPPER });
        const b = generateCredentials({
            plain,
            pepper: 'different-pepper-' + 'b'.repeat(32),
        });
        expect(a.stored).not.toBe(b.stored);
    });

    it('generates a fresh random key when --plain is omitted', () => {
        const a = generateCredentials({ pepper: PEPPER });
        const b = generateCredentials({ pepper: PEPPER });
        expect(a.plain).not.toBe(b.plain);
        expect(a.plain.startsWith('sk-')).toBe(true);
    });

    it('throws on a missing or too-short pepper', () => {
        expect(() => generateCredentials({ pepper: '' })).toThrow(CliError);
        expect(() => generateCredentials({ pepper: 'short' })).toThrow(CliError);
    });

    it('matches what `src/auth/api-key-hash.util` produces for the same input', () => {
        const plain = 'sk-crosstestxxxxxxxxxxxxxxxxxxxxxxxxx';
        const a = generateCredentials({ plain, pepper: PEPPER });
        // Hash util uses the same algorithm; the stored value must match
        // the canonical helper, otherwise operators would lock themselves out.
        const { hashApiKey } = require('../auth/api-key-hash.util');
        expect(a.stored).toBe(hashApiKey(plain, PEPPER));
    });
});

describe('readPepper', () => {
    it('returns the pepper from a populated env', () => {
        expect(readPepper({ API_KEY_PEPPER: PEPPER })).toBe(PEPPER);
    });

    it('throws CliError(2) when the env is missing the variable', () => {
        expect(() => readPepper({})).toThrow(CliError);
        try {
            readPepper({});
        } catch (err) {
            expect((err as CliError).code).toBe(2);
            expect(err.message).toMatch(/API_KEY_PEPPER/);
        }
    });

    it('throws CliError(2) when the env value is too short', () => {
        expect(() => readPepper({ API_KEY_PEPPER: 'short' })).toThrow(CliError);
    });
});

describe('buildResetSql', () => {
    it('produces a single-line UPDATE targeting the named client', () => {
        const sql = buildResetSql({
            clientId: 'admin',
            stored: 'hmac$abcd',
            prefix: 'sk-abcde',
        });
        expect(sql).toBe(
            "UPDATE clients SET api_key_hash = 'hmac$abcd', api_key_prefix = 'sk-abcde', last_used_at = NULL WHERE id = 'admin'",
        );
    });

    it('escapes single quotes in the client id', () => {
        const sql = buildResetSql({
            clientId: "weird'name",
            stored: 'hmac$x',
            prefix: 'sk-abc',
        });
        expect(sql).toContain("WHERE id = 'weird''name'");
    });
});

describe('buildCreateSql', () => {
    it('produces an INSERT with the right defaults', () => {
        const sql = buildCreateSql({
            id: 'tenant-acme',
            name: 'Acme Co.',
            scopes: 'chat.read,chat.write',
            rpm: 300,
            stored: 'hmac$xx',
            prefix: 'sk-abcde',
        });
        expect(sql).toBe(
            "INSERT INTO clients (id, name, api_key_hash, api_key_prefix, scopes, rate_limit_rpm) VALUES ('tenant-acme', 'Acme Co.', 'hmac$xx', 'sk-abcde', 'chat.read,chat.write', 300)",
        );
    });

    it('escapes single quotes in client id AND name', () => {
        const sql = buildCreateSql({
            id: "odd'id",
            name: "Weird 'Name'",
            scopes: 'chat.read,chat.write',
            rpm: 60,
            stored: 'h',
            prefix: 'p',
        });
        expect(sql).toContain("'odd''id'");
        expect(sql).toContain("'Weird ''Name'''");
    });
});

describe('formatOutput', () => {
    const opts: AdminResetOutput = {
        kind: 'RESET',
        clientId: 'admin',
        plain: 'sk-abc12345xxxx',
        stored: 'hmac$h',
        prefix: 'sk-abcde',
        sql: "UPDATE clients SET api_key_hash='h' WHERE id='admin'",
    };

    it('renders the kind / client-id banner', () => {
        expect(formatOutput(opts)).toMatch(/admin-reset · RESET · client 'admin'/);
    });

    it('echoes the plaintext key with a save-it-NOW warning', () => {
        const out = formatOutput(opts);
        expect(out).toContain('PLAIN API KEY (save NOW');
        expect(out).toContain('sk-abc12345xxxx');
    });

    it('embeds the SQL on a labelled line so the operator can copy it', () => {
        const out = formatOutput(opts);
        expect(out).toContain("UPDATE clients SET api_key_hash='h' WHERE id='admin';");
    });
});

describe('integration: parseArgs → generateCredentials → SQL', () => {
    it('produces a complete admin-reset payload from `--reset admin`', () => {
        const out = ((): AdminResetOutput => {
            const args = parseArgs(['--reset', 'admin']);
            const c = generateCredentials({
                plain: 'sk-testplainxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
                pepper: PEPPER,
            });
            const sql = buildResetSql({
                clientId: args.reset!,
                stored: c.stored,
                prefix: c.prefix,
            });
            return {
                kind: 'RESET',
                clientId: args.reset!,
                plain: c.plain,
                stored: c.stored,
                prefix: c.prefix,
                sql,
            };
        })();
        expect(out.clientId).toBe('admin');
        expect(out.kind).toBe('RESET');
        expect(out.prefix).toBe('sk-testp');
        expect(out.sql).toMatch(/^UPDATE clients SET api_key_hash = 'hmac\$/);
    });
});

describe('buildOutput with --plain', () => {
    it('uses the provided plain key instead of generating a random one', () => {
        const args = parseArgs(['--reset', 'admin', '--plain', 'sk-customkey1234567890abcdef']);
        const out = buildOutput(args, PEPPER);
        expect(out).not.toBeNull();
        if (out) {
            expect(out.kind).toBe('RESET');
            expect(out.clientId).toBe('admin');
            expect(out.plain).toBe('sk-customkey1234567890abcdef');
            // Prefix is the first 8 chars of the plaintext, matching
            // generateCredentials (slice(0, 8)) and the convention used by
            // the other tests in this spec.
            expect(out.prefix).toBe('sk-custo');
            expect(out.sql).toMatch(/api_key_prefix = 'sk-custo'/);
        }
    });

    it('uses the provided plain key with --create', () => {
        const args = parseArgs([
            '--create',
            '--id', 'tenant-test',
            '--plain', 'sk-customkey1234567890abcdef',
        ]);
        const out = buildOutput(args, PEPPER);
        expect(out).not.toBeNull();
        if (out) {
            expect(out.kind).toBe('CREATE');
            expect(out.clientId).toBe('tenant-test');
            expect(out.plain).toBe('sk-customkey1234567890abcdef');
            expect(out.prefix).toBe('sk-custo');
            expect(out.sql).toMatch(/'sk-custo'/);
        }
    });

    it('rejects --plain "" (CLIError 2)', () => {
        const args = parseArgs(['--reset', 'admin', '--plain', '']);
        expect(() => buildOutput(args, PEPPER)).toThrow(/non-empty/);
    });

    it('reflects the pepper: same plain + different pepper → different stored', () => {
        const args = parseArgs([
            '--reset', 'admin',
            '--plain', 'sk-sameplainxxxxxxxxxxxxxxxxxxxxxxxxxx',
        ]);
        const a = buildOutput(args, PEPPER) as AdminResetOutput;
        const b = buildOutput(args, 'different-pepper-' + 'b'.repeat(32)) as AdminResetOutput;
        expect(a.stored).not.toBe(b.stored);
        // Same prefix because that comes from the plaintext.
        expect(a.prefix).toBe(b.prefix);
    });
});

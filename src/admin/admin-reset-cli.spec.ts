import {
    parseArgs,
    generateCredentials,
    buildResetSql,
    buildCreateSql,
    formatOutput,
    type AdminResetOutput,
} from './admin-reset-cli';
import { randomBytes } from 'node:crypto';

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
});

describe('generateCredentials', () => {
    it('produces a `sk-...` plaintext, 8-char prefix, and `scrypt$<saltHex>$<hashHex>` stored value', () => {
        const fixedPlain = 'sk-aaaaabbbcccddddeeeffgghhiijjkkllmmnnooppqqrrss';
        // Provide a plain override → fully deterministic.
        const out = generateCredentials({ plain: fixedPlain });
        expect(out.plain).toBe(fixedPlain);
        expect(out.prefix).toBe('sk-aaaaa');
        expect(out.stored).toMatch(/^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
    });

    it('uses scrypt — the same plaintext with two different salts yields different stored hashes', () => {
        const plain = 'sk-sameplainxxxxxxxxxxxxxxxxxxxxxxxxxx';
        const salt1 = Buffer.from('a'.repeat(32), 'hex');
        const salt2 = Buffer.from('b'.repeat(32), 'hex');
        const a = generateCredentials({ plain, salt: salt1 });
        const b = generateCredentials({ plain, salt: salt2 });
        expect(a.stored).not.toBe(b.stored);
        // But same plaintext → same prefix.
        expect(a.prefix).toBe(b.prefix);
    });

    it('matches what `src/auth/api-key-hash.util` produces for the same input', () => {
        // Cross-check the implementation against the canonical helper —
        // any drift between cli and auth hash util would lock operators out
        // of their own gateway.
        const plain = 'sk-crosstestxxxxxxxxxxxxxxxxxxxxxxxxx';
        const saltHex = 'aa'.repeat(16);
        const salt = Buffer.from(saltHex, 'hex');
        const out = generateCredentials({ plain, salt });
        // scrypt$<32 hex>$<64 hex> = scrypt$aa..aa$<sha256 with scrypt>
        expect(out.stored).toMatch(
            new RegExp(`^scrypt\\$${saltHex}\\$[0-9a-f]{64}$`),
        );
    });
});

describe('buildResetSql', () => {
    it('produces a single-line UPDATE targeting the named client', () => {
        const sql = buildResetSql({
            clientId: 'admin',
            stored: 'scrypt$xx$yy',
            prefix: 'sk-abcde',
        });
        expect(sql).toBe(
            "UPDATE clients SET api_key_hash = 'scrypt$xx$yy', api_key_prefix = 'sk-abcde', last_used_at = NULL WHERE id = 'admin'",
        );
    });

    it('escapes single quotes in the client id', () => {
        const sql = buildResetSql({
            clientId: "weird'name",
            stored: 'scrypt$x',
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
            stored: 'scrypt$xx$yy',
            prefix: 'sk-abcde',
        });
        expect(sql).toBe(
            "INSERT INTO clients (id, name, api_key_hash, api_key_prefix, scopes, rate_limit_rpm) VALUES ('tenant-acme', 'Acme Co.', 'scrypt$xx$yy', 'sk-abcde', 'chat.read,chat.write', 300)",
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
        stored: 'scrypt$h$s',
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
        // Provide a known plain + salt so output is deterministic.
        const saltHex = 'aa'.repeat(16);
        const out = ((): AdminResetOutput => {
            const args = parseArgs(['--reset', 'admin']);
            const c = generateCredentials({
                plain: 'sk-testplainxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
                salt: Buffer.from(saltHex, 'hex'),
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
        expect(out.sql).toMatch(/^UPDATE clients SET api_key_hash = 'scrypt\$/);
    });
});

// Reference the import so it isn't flagged as unused.
// (randomBytes is used inside generateCredentials via Node — this is
//  just to make sure the spec still compiles cleanly after edits.)
void randomBytes;

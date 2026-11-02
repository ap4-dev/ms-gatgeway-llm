#!/usr/bin/env node
/* db-migrate — operator CLI that applies the gateway's SQL migrations.

   Usage (also via `pnpm db:migrate -- --help`):
     pnpm build                     # this script runs dist/, NOT src/
     pnpm db:migrate                # apply pending migrations
     pnpm db:migrate -- --status    # report applied + pending, write nothing
     pnpm db:migrate -- --dry-run   # same report, worded as "would apply"
     pnpm db:migrate -- --backup    # consistent DB copy before applying
     pnpm db:migrate -- --db ./data/other.db

   The target database is resolved the same way the server resolves it: with
   START_TOKEN set the CLI loads Doppler exactly as `inyectEnv()` does at boot,
   so DATABASE_PATH is the file the gateway actually opens. If that lookup
   fails the command aborts (exit 1) instead of guessing. `--db <path>` skips
   Doppler entirely and is the offline path. Every run prints the resolved
   database path and where it came from.

   This is a thin shim: it runs the COMPILED output in dist/ so the migration
   applied is exactly the one the built server expects to find recorded in
   `_migrations`. The pure logic + spec live in
   src/database/migrations/migrate-cli.ts, mirroring scripts/admin-reset.js. */

function run() {
    let cli;
    try {
        cli = require('../dist/database/migrations/migrate-cli');
    } catch (err) {
        const code = err && err.code;
        if (code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND') {
            process.stderr.write(
                'db-migrate runs the compiled output in dist/ so the migrations it\n' +
                    'applies are the ones the built server expects. Build first:\n\n' +
                    '  pnpm build\n\n' +
                    'then run this command again.\n\n' +
                    `(original error: ${err.message})\n`,
            );
            process.exitCode = 1;
            return;
        }
        throw err;
    }

    // `main` is unconditionally async (it may need the Doppler lookup the
    // server performs at boot). Promise.resolve keeps the sync-or-async
    // contract moot and `.then` still sees the reported exit code.
    Promise.resolve(cli.main(process.argv.slice(2)))
        .then((result) => {
            if (result && typeof result.text === 'string') {
                process.stdout.write(result.text);
                if (!result.text.endsWith('\n')) process.stdout.write('\n');
            }
            process.exitCode =
                result && typeof result.exitCode === 'number' ? result.exitCode : 0;
        })
        .catch((err) => {
            process.stderr.write(`db-migrate failed: ${(err && err.message) || err}\n`);
            process.exitCode = 1;
        });
}

run();

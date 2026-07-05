-- ---------------------------------------------------------------------------
-- 0004_clients.sql — Phase 5 client (API key) registry
--
-- Every chat / models request must carry an API key bound to a row in this
-- table (validation lives in `ApiKeyAuthGuard`). Rate-limit counters live
-- in Redis, not here, so adding/removing clients is just one row each.
--
-- `api_key_hash` stores a Node-crypto scrypt hash of the full key. The
-- plaintext is shown to the operator exactly once at creation time —
-- we never persist it. `api_key_prefix` keeps the first 8 chars so log
-- lines can be correlated without exposing the secret.
--
-- Phase 5 FK note: SQLite cannot add named FK constraints via
-- `ALTER TABLE … ADD CONSTRAINT`. `request_logs.client_key` stays an
-- unconstrained TEXT column; the ApiKeyAuthGuard verifies referential
-- integrity at the application layer. When migrating to Postgres, add
-- a proper `FOREIGN KEY (client_key) REFERENCES clients(id)` to the
-- request_logs DDL at the same time as the migration.
-- ---------------------------------------------------------------------------

CREATE TABLE clients (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  api_key_hash    TEXT NOT NULL,
  api_key_prefix  TEXT NOT NULL,
  scopes          TEXT NOT NULL DEFAULT 'chat.read,chat.write',
  rate_limit_rpm  INTEGER NOT NULL DEFAULT 60 CHECK (rate_limit_rpm > 0),
  rate_limit_tpm  INTEGER CHECK (rate_limit_tpm IS NULL OR rate_limit_tpm > 0),
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  last_used_at    INTEGER,
  revoked_at      INTEGER
);

CREATE INDEX idx_clients_api_key_prefix ON clients (api_key_prefix);

CREATE INDEX idx_request_logs_client_key ON request_logs (client_key);

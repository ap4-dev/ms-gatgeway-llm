-- ---------------------------------------------------------------------------
-- 0014_client_alias_quotas.sql — per-(client × alias) monthly token quotas
--
-- `client_alias_quotas` carries the monthly token allowance a client has for
-- one alias, plus the `divert_alias_key` that is served once that allowance is
-- exceeded. The unit of quota is the ALIAS, never a position inside a chain.
--
-- ABSENCE OF A ROW MEANS UNLIMITED. An alias with no row for that client is
-- not gated at all: the gateway performs no usage read and no usage write, so
-- an unlimited alias costs zero extra I/O per request. Assigning a row is what
-- turns the gate on; deleting it turns the gate off again.
--
-- `client_alias_usage` is keyed by the alias ACTUALLY SERVED, not the alias the
-- client requested. Diverted traffic therefore never consumes the quota of the
-- exhausted alias, so its counter freezes while diverting — which is exactly
-- what makes raising `monthly_token_limit` mid-period restore access on the
-- very next request, with no cache to invalidate and no reset job to run.
--
-- `period_key` is a UTC `YYYY-MM` calendar month derived from the request
-- timestamp. There is no cron-driven reset: a new month is simply a new key.
--
-- Deliberate omission: NO foreign key to `clients`. Same rationale already
-- documented for `request_logs.client_key` in 0004_clients.sql — SQLite cannot
-- add named FK constraints via `ALTER TABLE … ADD CONSTRAINT`, integrity is
-- enforced at the application layer (`ApiKeyAuthGuard` / admin API), and usage
-- history must survive client deletion. When migrating to Postgres, add a
-- proper `FOREIGN KEY (client_id) REFERENCES clients(id)` here, and mirror the
-- request_logs decision at the same time.
--
-- `request_logs.served_alias` records the alias that was actually routed,
-- while `model_requested` keeps what the client asked for. Without it a
-- downgraded request is indistinguishable from a normal one, and neither
-- auditing nor "tokens per served alias" reporting is possible.
--
-- Schema stays portable to Postgres: standard types only, no JSON1, no
-- SQLite-only functions beyond the `unixepoch()` default already used across
-- the other migrations.
-- ---------------------------------------------------------------------------

CREATE TABLE client_alias_quotas (
  client_id           TEXT    NOT NULL,
  alias_key           TEXT    NOT NULL,
  monthly_token_limit INTEGER NOT NULL CHECK (monthly_token_limit > 0),
  divert_alias_key    TEXT    CHECK (divert_alias_key IS NULL OR divert_alias_key <> alias_key),
  created_at          INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at          INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (client_id, alias_key)
);

CREATE TABLE client_alias_usage (
  client_id  TEXT    NOT NULL,
  alias_key  TEXT    NOT NULL,
  period_key TEXT    NOT NULL,
  tokens     INTEGER NOT NULL DEFAULT 0 CHECK (tokens >= 0),
  requests   INTEGER NOT NULL DEFAULT 0 CHECK (requests >= 0),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (client_id, alias_key, period_key)
);

CREATE INDEX idx_client_alias_usage_period ON client_alias_usage (period_key);

ALTER TABLE request_logs ADD COLUMN served_alias TEXT;
CREATE INDEX idx_request_logs_served_alias ON request_logs (served_alias);

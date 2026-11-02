-- ---------------------------------------------------------------------------
-- 0015_client_alias_access.sql — per-client alias allowlist
--
-- `client_alias_access` records which aliases a client MAY use. It is the
-- visibility/permission half of the per-client model, deliberately kept in its
-- own table instead of a column on `client_alias_quotas` because the two are
-- ORTHOGONAL: a quota row says "this alias is gated", an access row says "this
-- client may use this alias". Neither implies the other — a client can have a
-- monthly allowance for an alias it cannot reach, and can reach an alias that
-- is not gated at all (that is what `slave` is for today).
--
-- ABSENCE OF ANY ROW MEANS UNRESTRICTED. A client with no row here sees and may
-- use every alias in the registry, exactly as before this migration existed.
-- Only once an operator writes the first row does the client become
-- RESTRICTED, and then the set is exhaustive. That asymmetry is the whole
-- deployability argument: every client that exists today is untouched until
-- someone deliberately configures it, and there is no backfill to get wrong.
--
-- ABSENCE OF A SPECIFIC ROW *INSIDE* A NON-EMPTY SET MEANS FORBIDDEN. That is
-- the same "absence is meaningful" style as `client_alias_quotas`, with the
-- opposite reading, which is precisely why the two rules live in ONE accessor
-- (`AliasAccessService.getAccess`) that returns a discriminated union instead
-- of exposing two booleans or a raw array that each caller could interpret
-- differently. The future `/v1/models` filter and the future chat guard must
-- never be able to disagree about what a missing row means.
--
-- Cache-free by design, for the same reason the quota gate is: revoking access
-- must take effect on the very NEXT request. A TTL would leave a window where
-- the row is gone but the client still gets in. Reading this table is one
-- primary-key lookup per client on synchronous SQLite, i.e. microseconds.
--
-- Deliberate omission: NO foreign key to `clients`. Same rationale already
-- documented in 0004_clients.sql and 0014_client_alias_quotas.sql — SQLite
-- cannot add named FK constraints via `ALTER TABLE … ADD CONSTRAINT`,
-- integrity is enforced at the application layer (admin API), and access
-- history must survive client deletion. When migrating to Postgres, add a
-- proper `FOREIGN KEY (client_id) REFERENCES clients(id)` here, and mirror the
-- `request_logs`/quota decisions at the same time.
--
-- Scope note: this migration only makes the allowlist STORABLE and READABLE
-- through the admin API. It does not change request behaviour — no guard, no
-- filter and no error type consumes it yet.
--
-- Schema stays portable to Postgres: standard types only, no JSON1, no
-- SQLite-only functions beyond the `unixepoch()` default already used across
-- the other migrations.
-- ---------------------------------------------------------------------------

CREATE TABLE client_alias_access (
  client_id  TEXT    NOT NULL,
  alias_key  TEXT    NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (client_id, alias_key)
);

CREATE INDEX idx_client_alias_access_client ON client_alias_access (client_id);

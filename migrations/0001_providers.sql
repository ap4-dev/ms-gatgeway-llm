-- ---------------------------------------------------------------------------
-- 0001_providers.sql — multi-provider registry schema
--
-- Replaces config/providers.json (Phase 2) with relational tables. Schema is
-- designed to be portable to Postgres later (only standard SQL types,
-- standard FK actions, no JSON1-only features).
-- ---------------------------------------------------------------------------

CREATE TABLE providers (
  id          TEXT PRIMARY KEY,
  api_key_env TEXT NOT NULL,
  base_url    TEXT,
  timeout_ms  INTEGER CHECK (timeout_ms IS NULL OR timeout_ms > 0),
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE model_configs (
  provider_id     TEXT NOT NULL,
  model_key       TEXT NOT NULL,
  real_name       TEXT NOT NULL,
  max_tokens      INTEGER CHECK (max_tokens IS NULL OR max_tokens > 0),
  supports_stream INTEGER NOT NULL DEFAULT 1 CHECK (supports_stream IN (0, 1)),
  PRIMARY KEY (provider_id, model_key),
  FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE
);

CREATE TABLE alias_entries (
  alias_name  TEXT NOT NULL,
  position    INTEGER NOT NULL CHECK (position >= 0),
  provider_id TEXT NOT NULL,
  model_key   TEXT NOT NULL,
  PRIMARY KEY (alias_name, position),
  FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE,
  FOREIGN KEY (provider_id, model_key)
    REFERENCES model_configs(provider_id, model_key) ON DELETE CASCADE
);

-- Singleton row (id = 1). Holds the routing policy that's currently inside
-- config/providers.json#routing. Phase 3 added per-provider timeoutMs; the
-- policy itself carries global defaults + circuit breaker knobs.
CREATE TABLE routing_policy (
  id                       INTEGER PRIMARY KEY CHECK (id = 1),
  fallback_enabled         INTEGER NOT NULL DEFAULT 1
                           CHECK (fallback_enabled IN (0, 1)),
  strategy                 TEXT    NOT NULL DEFAULT 'primary'
                           CHECK (strategy IN ('primary', 'round-robin', 'fallback')),
  health_check_interval_ms INTEGER NOT NULL DEFAULT 30000
                           CHECK (health_check_interval_ms > 0),
  request_timeout_ms       INTEGER NOT NULL DEFAULT 120000
                           CHECK (request_timeout_ms > 0),
  failure_threshold        INTEGER NOT NULL DEFAULT 5
                           CHECK (failure_threshold > 0),
  cooldown_ms              INTEGER NOT NULL DEFAULT 30000
                           CHECK (cooldown_ms > 0),
  half_open_probes         INTEGER NOT NULL DEFAULT 1
                           CHECK (half_open_probes > 0)
);

INSERT INTO routing_policy (id) VALUES (1);

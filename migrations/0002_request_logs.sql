-- ---------------------------------------------------------------------------
-- 0002_request_logs.sql — per-request observability log
--
-- Lays the persistence surface for Phase 4. Writes happen from
-- RequestLogService inside ChatService.completions. The full observability
-- story (metrics aggregation, OpenTelemetry) lands in Phase 4.
--
-- `client_key` is intentionally text (no FK) so Phase 5 can add a
-- `clients` table and run `ALTER TABLE request_logs ADD CONSTRAINT
-- fk_request_logs_client FOREIGN KEY (client_key) REFERENCES clients(id)`
-- without rewriting this migration.
-- ---------------------------------------------------------------------------

CREATE TABLE request_logs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  requested_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  model_requested   TEXT NOT NULL,
  resolved_provider TEXT,
  resolved_model    TEXT,
  attempts          INTEGER NOT NULL DEFAULT 0,
  latency_ms        INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL
                    CHECK (status IN ('ok', 'error', 'circuit_open')),
  error             TEXT,
  client_key        TEXT
);

CREATE INDEX idx_request_logs_requested_at      ON request_logs (requested_at);
CREATE INDEX idx_request_logs_resolved_provider ON request_logs (resolved_provider);
CREATE INDEX idx_request_logs_model_requested   ON request_logs (model_requested);

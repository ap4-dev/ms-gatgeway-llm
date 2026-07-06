-- ---------------------------------------------------------------------------
-- 0009_log_indexes.sql — Phase 6+ admin /logs endpoint supports
--
-- Adds covering indexes for the two filter columns most likely to be
-- queried from `GET /admin/logs` in production (admin looking at one
-- tenant's traffic, or paging through errors only). Both follow the
-- same shape `(filter_col, requested_at DESC, id DESC)` so the entire
-- ORDER BY uses index order and `LIMIT` becomes an early-exit scan.
--
-- We don't index `model_requested` or `resolved_provider` yet — the
-- volume for those is bounded enough that a `requested_at` index scan
-- is fine until they actually become slow. Add them on demand.
-- ---------------------------------------------------------------------------

CREATE INDEX idx_request_logs_client_key_ts
    ON request_logs (client_key, requested_at DESC, id DESC);

CREATE INDEX idx_request_logs_status_ts
    ON request_logs (status, requested_at DESC, id DESC);

-- ---------------------------------------------------------------------------
-- 0013_request_params.sql — failure-only request diagnostics
--
-- Adds `request_params` (JSON) to `request_logs`: a diagnostic snapshot of the
-- outbound request used to debug upstream 400s. It stores the scalar request
-- params (model, max_tokens, temperature, stream, ...) plus a truncated first
-- user message — never the full conversation. The column is populated only for
-- failed rows; success rows leave it NULL.
-- ---------------------------------------------------------------------------

ALTER TABLE request_logs ADD COLUMN request_params TEXT;

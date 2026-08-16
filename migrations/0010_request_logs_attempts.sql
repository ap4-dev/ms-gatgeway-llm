-- ---------------------------------------------------------------------------
-- 0010_request_logs_attempts.sql — individual attempt observability
--
-- Adds `attempt_details` column (JSON) for storing per-attempt metadata:
-- provider, model, duration, error message, circuit open flag.
--
-- The column is populated by RequestLogService when a fallback chain
-- has multiple attempts (some failed, one succeeded). Each failed
-- attempt is also logged as its own request_logs row with status='error'.
-- ---------------------------------------------------------------------------

ALTER TABLE request_logs ADD COLUMN attempt_details TEXT;
-- ---------------------------------------------------------------------------
-- 0003_request_logs_tokens.sql — Phase 4 observability columns
--
-- Adds token counts (prompt / completion / total) and a prompt_hash to
-- `request_logs`. Token counts come from the upstream ChatCompletion
-- `usage` payload (streamed responses may not surface them — they're left
-- NULL). `prompt_hash` is the 16-char sha256 prefix returned by
-- `src/observability/prompt-hash.util.ts`.
-- ---------------------------------------------------------------------------

ALTER TABLE request_logs ADD COLUMN prompt_hash        TEXT;
ALTER TABLE request_logs ADD COLUMN prompt_tokens      INTEGER;
ALTER TABLE request_logs ADD COLUMN completion_tokens  INTEGER;
ALTER TABLE request_logs ADD COLUMN total_tokens       INTEGER;

CREATE INDEX idx_request_logs_prompt_hash ON request_logs (prompt_hash);
CREATE INDEX idx_request_logs_total_tokens ON request_logs (total_tokens);

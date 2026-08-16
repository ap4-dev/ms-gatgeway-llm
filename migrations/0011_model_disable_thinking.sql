-- ---------------------------------------------------------------------------
-- 0011_model_disable_thinking.sql — per-model thinking-mode override
--
-- DeepSeek V4 models run in thinking mode and emit `reasoning_content`.
-- When the client does not echo it back, the upstream rejects the next
-- request in the same thread with 400 (``reasoning_content ... must be
-- passed back''). `thinking: {"type":"disabled"}` on the request relaxes
-- that echo requirement while keeping reasoning quality.
--
-- This flag lets operators pin that override per model via DB instead of
-- hardcoding it in code. `ChatService.applyResolved` injects
-- `thinking: {type: "disabled"}` when the flag is set and the client did
-- not send a `thinking` field of its own.
-- ---------------------------------------------------------------------------

ALTER TABLE model_configs ADD COLUMN disable_thinking INTEGER NOT NULL DEFAULT 0
    CHECK (disable_thinking IN (0, 1));

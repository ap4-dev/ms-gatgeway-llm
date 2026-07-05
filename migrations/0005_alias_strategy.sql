-- ---------------------------------------------------------------------------
-- 0005_alias_strategy.sql — phase-after-5.5 — strategy per-alias
--
-- The `routing_policy` table currently carries a single `strategy`
-- column that applies to every alias. The right shape is per-alias:
-- each alias gets its own strategy (e.g. `fast` round-robin, `coder`
-- primary). This migration:
--
--   1. Removes `strategy` from the global `routing_policy` singleton.
--   2. Adds a new `alias_policy` table that ties a strategy to each
--      alias key by name.
--
-- Strategy changes do NOT require touching the registry code that
-- reads `routing_policy` for CB knobs (failure_threshold, cooldown_ms,
-- etc.) — only the router's strategy lookup.
--
-- FUTURE EXTENSIONS (intentionally NOT implemented yet):
--   - Weighted sampling (e.g. 50% qwen / 30% gpt / 20% gemma). Add a
--     sibling table `alias_weights(alias_key, position, weight)` and
--     extend the enum with `'weighted'` when the use case appears.
--   - Priority groups (primary group tried in order, secondary group
--     only entered after the primary group is exhausted). Each entry
--     gains a `priority` integer; same enum.
-- When added, the CHECK constraint is widened via a separate
-- migration — never edit this one.
-- ---------------------------------------------------------------------------

ALTER TABLE routing_policy DROP COLUMN strategy;

CREATE TABLE alias_policy (
    alias_key TEXT PRIMARY KEY,
    strategy  TEXT NOT NULL DEFAULT 'primary'
              CHECK (strategy IN ('primary', 'round-robin', 'fallback'))
);

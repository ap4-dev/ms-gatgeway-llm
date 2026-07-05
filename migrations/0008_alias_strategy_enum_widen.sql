-- ---------------------------------------------------------------------------
-- 0008_alias_strategy_enum_widen.sql — add 'weighted' and 'priority-grouped'
--
-- SQLite cannot ALTER a CHECK constraint on an existing column, so we
-- rebuild the table via RENAME + CREATE + INSERT + DROP. Each DDL
-- statement auto-commits; the runner wraps the whole file in a single
-- transaction so the swap is effectively atomic at the application
-- layer even without an explicit BEGIN/COMMIT here.
-- ---------------------------------------------------------------------------

ALTER TABLE alias_policy RENAME TO alias_policy_old;

CREATE TABLE alias_policy (
    alias_key TEXT PRIMARY KEY,
    strategy  TEXT NOT NULL DEFAULT 'primary'
              CHECK (strategy IN (
                  'primary',
                  'round-robin',
                  'fallback',
                  'weighted',
                  'priority-grouped'
              ))
);

INSERT INTO alias_policy (alias_key, strategy)
    SELECT alias_key, strategy FROM alias_policy_old;

DROP TABLE alias_policy_old;

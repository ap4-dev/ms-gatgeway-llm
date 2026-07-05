-- ---------------------------------------------------------------------------
-- 0006_alias_weights.sql — per-entry weights for `strategy='weighted'`
--
-- Each row pins an integer weight to a (alias_key, position) pair. Used
-- by `RoutingService` when `alias_policy.strategy === 'weighted'`: the
-- router samples one entry per request, weighted by these integers
-- (treated as counts at sampling time — e.g. weights [5,3,2] give ~50%
-- / 30% / 20%). Entries without a row are treated as weight=1 so an
-- alias with default-equal-weight entries still works without a row.
--
-- No FK to `alias_entries` so weights can be added before their position
-- is configured, and removed without cascading touch-ups.
-- ---------------------------------------------------------------------------

CREATE TABLE alias_weights (
    alias_key  TEXT NOT NULL,
    position   INTEGER NOT NULL CHECK (position >= 0),
    weight     INTEGER NOT NULL CHECK (weight > 0),
    PRIMARY KEY (alias_key, position)
);

CREATE INDEX idx_alias_weights_alias_key ON alias_weights (alias_key);

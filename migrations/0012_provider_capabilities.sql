-- ---------------------------------------------------------------------------
-- 0012_provider_capabilities.sql — capability flags per provider
--
-- The registry declares WHAT a provider can do, so feature modules pick
-- providers by capability instead of hardcoding a provider id. Today only
-- `supports_search` exists: "chat capability" is derivable from the
-- presence of rows in `model_configs` (a provider with models is a chat
-- provider), so no redundant flag for it.
--
-- The single existing provider (nan) is flagged as search-capable. Fresh
-- installs get the flag from the seed JSON (0001_initial_providers.json).
-- ---------------------------------------------------------------------------

ALTER TABLE providers
  ADD COLUMN supports_search INTEGER NOT NULL DEFAULT 0
    CHECK (supports_search IN (0, 1));

-- One-time backfill: the only provider in the current DB is nan, which
-- backs both chat and search.
UPDATE providers SET supports_search = 1;

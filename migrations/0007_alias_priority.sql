-- ---------------------------------------------------------------------------
-- 0007_alias_priority.sql — priority groups for `strategy='priority-grouped'`
--
-- Each alias entry gains an integer priority (default 0). Lower number =
-- higher priority. Entries with the same priority belong to the same
-- group; within a group, `position` decides order. Groups are tried in
-- priority order — the router only enters a lower-priority group after
-- every entry in the higher-priority group has been tried (or the chain
-- says so).
--
-- Why default 0 instead of NULL: keeps the existing rows unaffected and
-- unblocks group semantics without a backfill; rows "without explicit
-- priority" simply join the default group.
-- ---------------------------------------------------------------------------

ALTER TABLE alias_entries ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;

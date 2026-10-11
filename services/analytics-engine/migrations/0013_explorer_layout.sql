-- Explorer views v2 (Bikram, 2026-10-08): parameters, shape, group, pivot and filters of a view,
-- one JSON object (explorerLayoutSchema). Rows written before it read with the defaults.
ALTER TABLE research_explorer_views ADD COLUMN layout TEXT NOT NULL DEFAULT '{}';

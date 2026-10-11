-- Custom views (Bikram, 2026-10-08): one store for every desk's saved CustomViewPage views. A view
-- belongs to a desk and a data domain (holdings, explorer, ...); `owner` is the Access email of the
-- person it belongs to, or NULL when everyone on the desk shares it. `config` is the domain's JSON
-- (CustomViewConfig; an explorer view's formulas, parameters and shape).
CREATE TABLE custom_views (
  domain TEXT NOT NULL,
  id TEXT NOT NULL,
  desk TEXT NOT NULL,
  owner TEXT,
  name TEXT NOT NULL,
  config TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (domain, id)
);
CREATE INDEX custom_views_owner ON custom_views (domain, owner);

-- Explorer views move in as shared research views; their table goes (no old names).
INSERT INTO custom_views (domain, id, desk, owner, name, config, created_at, updated_at)
SELECT 'explorer', id, 'research', NULL, name,
       json_patch(json(layout), json_object('range', json(range), 'columns', json(columns))),
       created_at, updated_at
  FROM research_explorer_views;
DROP TABLE research_explorer_views;

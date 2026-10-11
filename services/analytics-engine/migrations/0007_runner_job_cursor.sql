-- Step 8c-1: a runner Research lands its trials while it runs. The Worker replays the runner's
-- records past a cursor, and keeps the stand-in ids (`@version`, `@research` -> the real ids) the
-- later records refer to. Additive: existing rows start at 0 and no ids.
ALTER TABLE research_jobs ADD COLUMN reports_done INTEGER NOT NULL DEFAULT 0;
ALTER TABLE research_jobs ADD COLUMN report_ids TEXT;

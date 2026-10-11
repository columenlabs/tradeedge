-- Replays are gone (Bikram, 2026-10-07). 0009 copied every live Replay into research_results, so the
-- old table and its blob rows go now. The R2 objects under replays/ stay: research_results.curves_key
-- points at them, and the legacy POST /api/replays and report_replay aliases write to Results.
DELETE FROM research_blobs WHERE owner_kind = 'replay';
DROP INDEX IF EXISTS research_idx_replays_strategy;
DROP TABLE research_replays;

-- StrategyDesk is TradingDesk (Bikram, 2026-10-10): the desk id `strategy` becomes `trading` on the
-- rows that store it. Reads never filter on desk, so this can run before or after the deploy.
UPDATE custom_views SET desk = 'trading' WHERE desk = 'strategy';
UPDATE feedback SET desk = 'trading' WHERE desk = 'strategy';

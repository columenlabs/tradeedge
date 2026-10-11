-- TradingEdge is TradeEdge (Bikram, 2026-10-11): the desk id `trading` becomes `trade` on the rows
-- that store it. Reads never filter on desk, so this can run before or after the deploy.
UPDATE custom_views SET desk = 'trade' WHERE desk = 'trading';
UPDATE feedback SET desk = 'trade' WHERE desk = 'trading';

#!/usr/bin/env bash
# Build TradeEdge alone for Workers Static Assets (the self-hosted Worker, wrangler.trade.jsonc):
#   public/app/ ← apps/tradeedge/dist (vite base: /app/)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/services/analytics-engine/public"

cd "$ROOT"
bun --filter=tradeedge run build

rm -rf "$OUT"
mkdir -p "$OUT/app"
cp -R apps/tradeedge/dist/. "$OUT/app/"
echo "assets → $OUT"

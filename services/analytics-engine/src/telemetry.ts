/**
 * Request-scoped stats (AsyncLocalStorage): upstream time / calls and cache
 * hits, surfaced as one structured log line + a Server-Timing header.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestStats {
  route: string;
  /** MCP JSON-RPC method + tool name when applicable. */
  rpc?: string;
  tool?: string;
  upstreamMs: number;
  upstreamCalls: number;
  memoryHits: number;
  sharedHits: number;
  misses: number;
}

const als = new AsyncLocalStorage<RequestStats>();

export const currentStats = () => als.getStore();

export function runWithStats<T>(route: string, fn: (s: RequestStats) => Promise<T>): Promise<T> {
  const s: RequestStats = {
    route,
    upstreamMs: 0,
    upstreamCalls: 0,
    memoryHits: 0,
    sharedHits: 0,
    misses: 0,
  };
  return als.run(s, () => fn(s));
}

export async function timeUpstream<T>(fn: () => Promise<T>): Promise<T> {
  const s = currentStats();
  const t0 = performance.now();
  try {
    return await fn();
  } finally {
    if (s) {
      s.upstreamMs += performance.now() - t0;
      s.upstreamCalls++;
    }
  }
}

export function serverTiming(s: RequestStats, totalMs: number): string {
  const cache = s.sharedHits ? 'shared' : s.memoryHits ? 'memory' : s.misses ? 'miss' : 'none';
  return `total;dur=${totalMs.toFixed(1)}, upstream;dur=${s.upstreamMs.toFixed(1)};desc="${s.upstreamCalls} calls", cache;desc="${cache}"`;
}

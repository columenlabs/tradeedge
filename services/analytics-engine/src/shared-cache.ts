/**
 * Colo-shared cache (Cloudflare Cache API) for off-hours market data.
 * Bun/local dev: no-op.
 */
export interface SharedCache {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown, ttlSeconds: number): Promise<void>;
}

export const noSharedCache: SharedCache = {
  async get() {
    return undefined;
  },
  async put() {},
};

interface CacheLike {
  match(req: Request): Promise<Response | undefined>;
  put(req: Request, res: Response): Promise<void>;
}

export function cacheApi(
  cache: CacheLike,
  namespace = 'https://cache.edgedesk.internal',
): SharedCache {
  const req = (key: string) => new Request(`${namespace}/${encodeURIComponent(key)}`);
  return {
    async get<T>(key: string) {
      const hit = await cache.match(req(key));
      return hit ? ((await hit.json()) as T) : undefined;
    },
    async put(key, value, ttlSeconds) {
      await cache.put(
        req(key),
        new Response(JSON.stringify(value), {
          headers: {
            'content-type': 'application/json',
            'cache-control': `public, max-age=${Math.max(1, Math.floor(ttlSeconds))}`,
          },
        }),
      );
    },
  };
}

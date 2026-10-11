/** Per-identity request limiting via the Workers Rate Limiting binding. */

/** Cloudflare Workers Rate Limiting binding shape. */
export interface RateLimiter {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

export const clientIp = (h: (name: string) => string | undefined) =>
  h('cf-connecting-ip') ?? h('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';

/** 429 when the limiter says no. Key = Access subject when known, else client IP. */
export async function rateLimited(
  limiter: RateLimiter | undefined,
  key: string,
): Promise<Response | null> {
  if (!limiter) return null;
  const { success } = await limiter.limit({ key });
  return success
    ? null
    : new Response(JSON.stringify({ error: 'rate limited: slow down and retry in a minute' }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '60' },
      });
}

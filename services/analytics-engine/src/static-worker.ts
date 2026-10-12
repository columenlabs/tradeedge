/**
 * Worker: serve the desks from Workers Static Assets (the `ASSETS` binding).
 * edgedesk and tradeedge: `/` (landing, on edgedesk.app), `/docs` and `/app` (on trade.edgedesk.app;
 * `app.ts` keeps each on its own host). `/app/*` falls back to its SPA shell (`/app/`, not
 * `/app/index.html`, which Assets would redirect and lose the deep link).
 * dataedge host: the dataedge SPA, built to `public/dataedge/`, served at the host root.
 * Workers Static Assets ignores `Range`, so `siteStatic` answers it itself: iPhone Safari plays
 * the landing's hero video only from 206 partial responses.
 */
import type { MountStatic } from './desks/tradeedge/app';

export interface AssetsFetcher {
  fetch(req: Request): Promise<Response>;
}

const DATAEDGE_DIR = '/dataedge';

/**
 * A 200 asset answered for one `Range: bytes=…` request as 206 (or 416); other requests pass.
 * The binding's response carries no Content-Length, so the body is read to learn the size
 * (the largest asset, the 1080p hero video, is 15 MB).
 */
export async function partial(req: Request, res: Response): Promise<Response> {
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('range')?.trim() ?? '');
  if (!m || (!m[1] && !m[2]) || res.status !== 200 || !res.body) return res;
  const body = new Uint8Array(await res.arrayBuffer());
  const size = body.length;
  const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  const headers = new Headers(res.headers);
  headers.set('accept-ranges', 'bytes');
  if (start >= size || start > end) {
    headers.set('content-range', `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }
  headers.set('content-range', `bytes ${start}-${end}/${size}`);
  headers.set('content-length', String(end - start + 1));
  return new Response(body.subarray(start, end + 1), { status: 206, headers });
}

/** The landing, `/docs` and `/app` as built; the self-hosted TradeEdge ships `/app` only. */
export const siteStatic =
  (assets: AssetsFetcher): MountStatic =>
  (app) => {
    app.get('*', async (c) => {
      const path = new URL(c.req.url).pathname;
      const res = await assets.fetch(c.req.raw);
      if (res.status === 404 && path.startsWith('/app/')) {
        return assets.fetch(new Request(new URL('/app/', c.req.url).toString(), c.req.raw));
      }
      return partial(c.req.raw, res);
    });
  };

export function workerStatic(assets: AssetsFetcher): {
  edgedesk: MountStatic;
  dataedge: MountStatic;
} {
  return {
    edgedesk: siteStatic(assets),
    dataedge: (app) => {
      app.get('*', async (c) => {
        const url = new URL(c.req.url);
        const at = (p: string) =>
          new Request(new URL(`${DATAEDGE_DIR}${p}`, url).toString(), c.req.raw);
        const res = await assets.fetch(at(url.pathname));
        // SPA deep links (/market/SPY) fall back to the shell.
        if (res.status === 404) return assets.fetch(at('/'));
        return res;
      });
    },
  };
}

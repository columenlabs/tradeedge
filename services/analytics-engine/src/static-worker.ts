/**
 * Worker: serve the desks from Workers Static Assets (the `ASSETS` binding).
 * edgedesk and tradeedge: `/` (landing, on edgedesk.app), `/docs` and `/app` (on trade.edgedesk.app;
 * `app.ts` keeps each on its own host). `/app/*` falls back to its SPA shell (`/app/`, not
 * `/app/index.html`, which Assets would redirect and lose the deep link).
 * dataedge host: the dataedge SPA, built to `public/dataedge/`, served at the host root.
 */
import type { MountStatic } from './desks/tradeedge/app';

export interface AssetsFetcher {
  fetch(req: Request): Promise<Response>;
}

const DATAEDGE_DIR = '/dataedge';

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
      return res;
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

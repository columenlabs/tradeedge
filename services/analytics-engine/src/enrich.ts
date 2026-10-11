/**
 * Fill missing iv / greeks (upstream omits them on 0DTE and some illiquid
 * contracts) by implying vol from the mid with Black–Scholes. Uses the real
 * time left to the 4pm ET close, so same-day contracts get sensible values.
 */
import { bsGreeks, impliedVol } from '@edgedesk/strategies';
import { type OptionQuote, expIntToIso } from '@edgedesk/types';

/** Max (ask − bid) / mid for a quote to be trusted for implying vol. */
const MAX_SPREAD = 0.5;
const MIN_T = 5 / (60 * 24 * 365); // 5 minutes

/** Epoch ms of 16:00 America/New_York on the expiration date. */
export function expiryCloseMs(expiration: number): number {
  const iso = expIntToIso(expiration);
  // 16:00 ET is 20:00 UTC in EDT and 21:00 UTC in EST; pick by the NY offset that day.
  const probe = new Date(`${iso}T20:00:00Z`);
  const nyHour = Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      hour12: false,
    }).format(probe),
  );
  return probe.getTime() + (16 - nyHour) * 3_600_000;
}

export function enrichQuotes(
  quotes: OptionQuote[],
  spot: number | null,
  now = Date.now(),
): OptionQuote[] {
  if (spot === null || !(spot > 0)) return quotes;
  return quotes.map((q) => {
    if (q.iv !== null && q.delta !== null) return { ...q, greeksSource: 'provider' as const };
    const { bid, ask } = q;
    if (bid === null || ask === null || !(bid > 0) || !(ask >= bid)) return q;
    const mid = (bid + ask) / 2;
    if ((ask - bid) / mid > MAX_SPREAD) return q;
    const t = Math.max(MIN_T, (expiryCloseMs(q.expiration) - now) / (365 * 86_400_000));
    const iv = q.iv ?? impliedVol(mid, { type: q.type, spot, strike: q.strike, t });
    if (iv === null) return q;
    const g = bsGreeks({ type: q.type, spot, strike: q.strike, t, iv });
    return {
      ...q,
      iv,
      delta: q.delta ?? g.delta,
      gamma: q.gamma ?? g.gamma,
      theta: q.theta ?? g.theta,
      vega: q.vega ?? g.vega,
      greeksSource: 'model' as const,
    };
  });
}

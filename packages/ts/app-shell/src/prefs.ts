// User preferences that hold on every desk (Bikram, 2026-10-08): theme, glass, time zone and
// Hide amounts (Bikram, 2026-10-09).
// Desks live on their own hosts (data., research., trade.edgedesk.app), so the choice is kept in
// one cookie on the parent domain rather than per-origin localStorage; nothing is stored server-side.
import { useSyncExternalStore } from 'react';

export const THEMES = ['light', 'dark', 'system'] as const;
export type Theme = (typeof THEMES)[number];

export const TIME_ZONES = [
  { id: 'America/New_York', label: 'Eastern' },
  { id: 'America/Chicago', label: 'Central' },
  { id: 'America/Los_Angeles', label: 'Pacific' },
  { id: 'UTC', label: 'UTC' },
] as const;
export type TimeZoneId = (typeof TIME_ZONES)[number]['id'];

export interface Prefs {
  theme: Theme;
  glass: boolean;
  timeZone: TimeZoneId;
  /** Hide amounts: the header's eye masks holding dollars and quantities, e.g. for screen-sharing. */
  hideAmounts: boolean;
}

/** Eastern by default, as DataEdge's zone picker had it (the market's own zone). */
export const DEFAULT_PREFS: Prefs = {
  theme: 'light',
  glass: false,
  timeZone: 'America/New_York',
  hideAmounts: false,
};

const COOKIE = 'edgedesk_prefs';
const YEAR = 60 * 60 * 24 * 365;
const listeners = new Set<() => void>();

/** `.edgedesk.app` on the real hosts so every desk shares it; host-only elsewhere (local dev). */
function cookieDomain() {
  const host = location.hostname;
  return host === 'edgedesk.app' || host.endsWith('.edgedesk.app') ? '; domain=.edgedesk.app' : '';
}

function read(): Prefs {
  try {
    const raw = document.cookie
      .split('; ')
      .find((c) => c.startsWith(`${COOKIE}=`))
      ?.slice(COOKIE.length + 1);
    if (!raw) return DEFAULT_PREFS;
    const v = JSON.parse(decodeURIComponent(raw)) as Partial<Prefs>;
    return {
      theme: THEMES.includes(v.theme as Theme) ? (v.theme as Theme) : DEFAULT_PREFS.theme,
      glass: v.glass === true,
      timeZone: TIME_ZONES.find((z) => z.id === v.timeZone)?.id ?? DEFAULT_PREFS.timeZone,
      hideAmounts: v.hideAmounts === true,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

let state: Prefs = typeof document === 'undefined' ? DEFAULT_PREFS : read();

const systemDark = () =>
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches;

/** The theme on screen: `system` follows the device. */
export const resolvedTheme = (p: Prefs = state): 'light' | 'dark' =>
  p.theme === 'system' ? (systemDark() ? 'dark' : 'light') : p.theme;

function apply() {
  const el = document.documentElement;
  el.classList.toggle('dark', resolvedTheme() === 'dark');
  el.dataset.glass = state.glass ? 'on' : 'off';
}

if (typeof document !== 'undefined') {
  apply();
  matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (state.theme !== 'system') return;
    apply();
    for (const l of listeners) l();
  });
  // Another desk (or tab) changed a preference: pick it up when this tab comes back.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    const next = read();
    if (JSON.stringify(next) === JSON.stringify(state)) return;
    state = next;
    apply();
    for (const l of listeners) l();
  });
}

export function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]) {
  state = { ...state, [key]: value };
  document.cookie = `${COOKIE}=${encodeURIComponent(JSON.stringify(state))}; path=/; max-age=${YEAR}; samesite=lax; secure${cookieDomain()}`;
  apply();
  for (const l of listeners) l();
}

export const getPrefs = (): Prefs => state;

export function usePrefs(): Prefs {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getPrefs,
    () => DEFAULT_PREFS,
  );
}

/** `Pacific`, `UTC`: the short name shown next to times. */
export const timeZoneLabel = (id: TimeZoneId) => TIME_ZONES.find((z) => z.id === id)?.label ?? id;

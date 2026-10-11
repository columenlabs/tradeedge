import { useEffect, useState } from 'react';

export interface Identity {
  email: string;
  name: string | null;
}

/** Cloudflare Access serves the signed-in person on every protected host; nothing is stored. */
const IDENTITY_URL = '/cdn-cgi/access/get-identity';
export const SIGN_OUT_URL = '/cdn-cgi/access/logout';

let cached: Promise<Identity | null> | null = null;

function load(): Promise<Identity | null> {
  cached ??= fetch(IDENTITY_URL, { credentials: 'include' })
    .then((r) => (r.ok ? r.json() : null))
    .then((j: { email?: unknown; name?: unknown } | null) =>
      j && typeof j.email === 'string'
        ? { email: j.email, name: typeof j.name === 'string' && j.name ? j.name : null }
        : null,
    )
    .catch(() => null);
  return cached;
}

/** The signed-in person, or null while loading and where Access is not in front (local dev). */
export function useIdentity(): Identity | null {
  const [who, setWho] = useState<Identity | null>(null);
  useEffect(() => {
    let live = true;
    load().then((w) => live && setWho(w));
    return () => {
      live = false;
    };
  }, []);
  return who;
}

/** `BC` from "Bikram Choor", else the first two letters of the email. */
export function initials(who: Identity | null): string {
  if (!who) return '··';
  const parts = (who.name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0]?.[0] ?? ''}${parts.at(-1)?.[0] ?? ''}`.toUpperCase();
  return who.email.slice(0, 2).toUpperCase();
}

/** What the profile button shows (Bikram, 2026-10-09): the first name only, else the email's name. */
export function firstName(who: Identity | null): string {
  if (!who) return 'Signed in';
  return (who.name ?? '').trim().split(/\s+/)[0] || (who.email.split('@')[0] ?? who.email);
}

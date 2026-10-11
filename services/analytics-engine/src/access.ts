/**
 * Cloudflare Access JWT verification (`Cf-Access-Jwt-Assertion`). Access
 * already gates `/mcp` at the edge (Managed OAuth); the Worker re-checks the
 * token so the route stays closed even if the Access app is misconfigured.
 */

export interface AccessConfig {
  /** e.g. `columenlabs.cloudflareaccess.com` */
  teamDomain: string;
  /** The Access application's AUD tag. */
  aud: string;
}

export interface AccessIdentity {
  email?: string;
  sub: string;
  /** Service-token client ID (`common_name`) when an Access service token, not a person, signed in. */
  serviceToken?: string;
}

interface Jwk {
  kid: string;
  kty: string;
  [field: string]: unknown;
}

type FetchFn = (input: string) => Promise<Response>;

const b64urlToBytes = (s: string): Uint8Array<ArrayBuffer> => {
  const b64 = s
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(s.length / 4) * 4, '=');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const decodeJson = <T>(s: string): T => JSON.parse(new TextDecoder().decode(b64urlToBytes(s))) as T;

export class AccessVerifier {
  private keys: { at: number; keys: Map<string, CryptoKey> } | undefined;

  constructor(
    private readonly cfg: AccessConfig,
    private readonly fetchImpl: FetchFn = (u) => fetch(u),
    private readonly now: () => number = Date.now,
  ) {}

  private async keyFor(kid: string): Promise<CryptoKey | undefined> {
    const fresh = this.keys && this.now() - this.keys.at < 60 * 60_000;
    if (!fresh || !this.keys?.keys.has(kid)) {
      const res = await this.fetchImpl(`https://${this.cfg.teamDomain}/cdn-cgi/access/certs`);
      if (!res.ok) throw new Error(`access certs ${res.status}`);
      const { keys } = (await res.json()) as { keys: Jwk[] };
      const map = new Map<string, CryptoKey>();
      for (const k of keys) {
        map.set(
          k.kid,
          await crypto.subtle.importKey(
            'jwk',
            // JWK from Access's certs endpoint; the lib's JsonWebKey type isn't in scope here.
            k as never,
            { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
            false,
            ['verify'],
          ),
        );
      }
      this.keys = { at: this.now(), keys: map };
    }
    return this.keys?.keys.get(kid);
  }

  /** Returns the identity, or null when the token is missing/invalid. */
  async verify(token: string | undefined): Promise<AccessIdentity | null> {
    if (!token) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [h, p, s] = parts as [string, string, string];
    try {
      const header = decodeJson<{ alg: string; kid: string }>(h);
      if (header.alg !== 'RS256') return null;
      const key = await this.keyFor(header.kid);
      if (!key) return null;
      const ok = await crypto.subtle.verify(
        'RSASSA-PKCS1-v1_5',
        key,
        b64urlToBytes(s),
        new Uint8Array(new TextEncoder().encode(`${h}.${p}`)),
      );
      if (!ok) return null;
      const claims = decodeJson<{
        aud: string | string[];
        iss: string;
        exp: number;
        nbf?: number;
        sub: string;
        email?: string;
        common_name?: string;
      }>(p);
      const nowS = this.now() / 1000;
      const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (!auds.includes(this.cfg.aud)) return null;
      if (claims.iss !== `https://${this.cfg.teamDomain}`) return null;
      if (claims.exp < nowS || (claims.nbf !== undefined && claims.nbf > nowS + 60)) return null;
      return {
        sub: claims.sub,
        email: claims.email,
        // Service tokens carry no email; `common_name` is the token's client ID.
        ...(claims.email || !claims.common_name ? {} : { serviceToken: claims.common_name }),
      };
    } catch {
      return null;
    }
  }
}

import {CacheLib} from './cache.js';

/**
 * Document shape returned by an external token-refresh service, e.g. the
 * `docs/id/{docId}` store on api.themeparks.wiki. A separate out-of-process
 * job (a darkride automation, an OTP-cycle runner, etc.) is responsible for
 * keeping `accessToken` rolling well ahead of `exp` — this module only ever
 * consumes it.
 */
export interface ExternalTokenDoc {
  accessToken: string;
  /** Epoch ms. */
  exp: number;
}

/**
 * Fetch a bearer token from an external token-refresh service and cache it.
 *
 * Used by parks whose live-data API needs a credential that can't be derived
 * or refreshed in-process (an OTP-only login cycle, a reverse-engineered
 * app-embedded secret that shouldn't live in this repo, etc.). The token
 * itself is fetched from `tokenUrl` and cached under that URL — multiple
 * destinations pointed at the same `tokenUrl` share one cached fetch rather
 * than each polling the service independently.
 *
 * Failures are NOT cached (CacheLib.wrap rethrows on inner-fn throw and skips
 * the set step), so a transient token-service blip only costs the caller one
 * HTTP round-trip, not the full TTL. Returns '' when `tokenUrl` is unset or
 * the fetch fails — callers are expected to tolerate an empty token by
 * omitting whatever data requires it, rather than failing outright.
 */
export async function fetchExternalToken(opts: {
  tokenUrl: string;
  tokenAuth?: string;
  tokenAuthHeader?: string;
  cacheTtlSeconds?: number;
  logPrefix?: string;
}): Promise<string> {
  if (!opts.tokenUrl) return '';
  const cacheKey = `externalToken:${opts.tokenUrl}`;
  try {
    return await CacheLib.wrap(cacheKey, async () => {
      const headers: Record<string, string> = {'Accept': 'application/json'};
      if (opts.tokenAuth) headers[opts.tokenAuthHeader || 'Authorization'] = opts.tokenAuth;
      const resp = await fetch(opts.tokenUrl, {headers});
      if (!resp.ok) throw new Error(`token service HTTP ${resp.status}`);
      const doc = await resp.json() as ExternalTokenDoc;
      if (!doc?.accessToken) throw new Error('token service returned no accessToken');
      return doc.accessToken;
    }, opts.cacheTtlSeconds ?? 60 * 60 * 3);
  } catch (err: any) {
    console.warn(`${opts.logPrefix ?? '[TokenService]'} token fetch failed: ${err?.message ?? err}`);
    return '';
  }
}

/**
 * Read past the HTTP response cache for the requests made inside one scope.
 *
 * A consumer that needs to know whether an upstream answers right now (a health
 * probe, for example) cannot trust a cached response: an `@http({cacheSeconds})`
 * hit returns before the request is sent, so it proves nothing about the
 * upstream. Inside {@link bypassHttpCache}, a request skips the cache READ and
 * goes to the network. A successful response is still WRITTEN, so the fresh copy
 * serves every later caller, inside the scope or not.
 *
 * Deliberately narrow:
 * - Only the `@http` response cache. Method-level `@cache` entries are still
 *   served. Those hold things such as login sessions, app installation tokens
 *   and scraped rosters, some kept for days, and re-minting them per probe would
 *   create upstream accounts or logins the park sees, not just extra requests.
 * - Only requests started inside the scope. The decision is taken when the
 *   request is queued, so a request that runs later, after the scope has ended,
 *   still bypasses, and other callers running concurrently are unaffected.
 * - Concurrent identical calls inside the scope still share one request. They
 *   never share with a call queued outside it, which may be answered from the
 *   cache.
 */
import {AsyncLocalStorage} from 'node:async_hooks';

const scope = new AsyncLocalStorage<true>();

/** Run `fn` with HTTP response-cache reads skipped for every request it queues. */
export function bypassHttpCache<T>(fn: () => T | Promise<T>): Promise<T> {
  return scope.run(true, async () => fn());
}

/** Whether the current async context is inside {@link bypassHttpCache}. */
export function httpCacheBypassed(): boolean {
  return scope.getStore() === true;
}

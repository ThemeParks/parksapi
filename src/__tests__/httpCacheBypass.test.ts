/**
 * bypassHttpCache: requests queued inside the scope skip the `@http` response
 * cache read and still write it; method-level `@cache` is untouched; callers
 * outside the scope keep their cache hits.
 */
import {setHttpTransport} from '../httpProxy.js';
import {http, HTTPObj, stopHttpQueue} from '../http.js';
import {cache, CacheLib} from '../cache.js';
import {bypassHttpCache, httpCacheBypassed} from '../httpCacheBypass.js';

let served = 0;
let sent = 0;

class BypassClient {
  @http({cacheSeconds: 600})
  async fetchWaits(park: string): Promise<HTTPObj> {
    return {method: 'GET', url: `http://bypass.invalid/waits/${park}`, options: {json: true}} as any as HTTPObj;
  }

  @http({cacheSeconds: 600, delayMs: 30})
  async fetchSlow(park: string): Promise<HTTPObj> {
    return {method: 'GET', url: `http://bypass.invalid/slow/${park}`, options: {json: true}} as any as HTTPObj;
  }

  /** Stands in for a login or installation token kept for days. */
  @cache({ttlSeconds: 86400})
  async getToken(): Promise<string> {
    const resp = await this.fetchToken();
    return (await resp.json()).n;
  }

  @http({cacheSeconds: 600})
  async fetchToken(): Promise<HTTPObj> {
    return {method: 'POST', url: 'http://bypass.invalid/token', options: {json: true}} as any as HTTPObj;
  }
}

const value = async (p: Promise<HTTPObj>) => (await (await p).json()).n;

beforeEach(() => {
  CacheLib.clearByClassName('BypassClient', {includePersistent: true});
  served = 0;
  sent = 0;
  // Every network response carries a new number, so a stale cached body is visible.
  setHttpTransport(async () => {
    sent++;
    return new Response(JSON.stringify({n: ++served}), {status: 200, headers: {'content-type': 'application/json'}});
  });
});

afterEach(() => setHttpTransport(null));
afterAll(() => stopHttpQueue());

describe('bypassHttpCache', () => {
  it('reports the scope', async () => {
    expect(httpCacheBypassed()).toBe(false);
    await bypassHttpCache(async () => {
      await Promise.resolve();
      expect(httpCacheBypassed()).toBe(true);
    });
    expect(httpCacheBypassed()).toBe(false);
  });

  it('a cached response is normally served without a request', async () => {
    const c = new BypassClient();
    expect(await value(c.fetchWaits('a'))).toBe(1);
    expect(await value(c.fetchWaits('a'))).toBe(1);
    expect(sent).toBe(1);
  });

  it('inside the scope the request goes to the network, and the fresh copy is cached', async () => {
    const c = new BypassClient();
    expect(await value(c.fetchWaits('a'))).toBe(1);
    expect(await bypassHttpCache(() => value(c.fetchWaits('a')))).toBe(2);
    expect(sent).toBe(2);
    // Outside again: served the copy the bypassing request wrote.
    expect(await value(c.fetchWaits('a'))).toBe(2);
    expect(sent).toBe(2);
  });

  it('decides at queue time: a request still queued when the scope ends still bypasses', async () => {
    const c = new BypassClient();
    expect(await value(c.fetchSlow('a'))).toBe(1);
    let pending!: Promise<HTTPObj>;
    await bypassHttpCache(() => { pending = c.fetchSlow('a'); });
    expect(httpCacheBypassed()).toBe(false);
    expect(await value(pending)).toBe(2);
  });

  it('does not touch a concurrent caller outside the scope', async () => {
    const c = new BypassClient();
    expect(await value(c.fetchWaits('a'))).toBe(1);
    const [inside, outside] = await Promise.all([
      bypassHttpCache(() => value(c.fetchWaits('a'))),
      value(c.fetchWaits('a')),
    ]);
    expect(inside).toBe(2);
    // The outside caller sends nothing: it reads the cache, which by then may
    // already hold the copy the bypassing request wrote.
    expect([1, 2]).toContain(outside);
    expect(sent).toBe(2);
  });

  it('never coalesces with an identical call queued outside the scope', async () => {
    const c = new BypassClient();
    expect(await value(c.fetchSlow('a'))).toBe(1);
    // The outside call is still in flight (delayMs) and will be served from the cache.
    const outside = c.fetchSlow('a');
    const inside = bypassHttpCache(() => c.fetchSlow('a'));
    expect(await value(outside)).toBe(1);
    expect(await value(inside)).toBe(2);
  });

  it('concurrent identical calls inside the scope share one request', async () => {
    const c = new BypassClient();
    expect(await value(c.fetchWaits('a'))).toBe(1);
    const [x, y] = await bypassHttpCache(() => Promise.all([value(c.fetchWaits('a')), value(c.fetchWaits('a'))]));
    expect([x, y]).toEqual([2, 2]);
    expect(sent).toBe(2);
  });

  it('leaves method-level @cache alone: a held token is not re-minted', async () => {
    const c = new BypassClient();
    expect(await c.getToken()).toBe(1);
    expect(await bypassHttpCache(() => c.getToken())).toBe(1);
    expect(sent).toBe(1);
  });

  it('a failed response inside the scope does not replace the cached copy', async () => {
    const c = new BypassClient();
    expect(await value(c.fetchWaits('a'))).toBe(1);
    setHttpTransport(async () => { sent++; return new Response('down', {status: 503}); });
    await bypassHttpCache(async () => { await c.fetchWaits('a').catch(() => undefined); });
    setHttpTransport(async () => { sent++; return new Response(JSON.stringify({n: 99}), {status: 200}); });
    expect(await value(c.fetchWaits('a'))).toBe(1);
  });
});

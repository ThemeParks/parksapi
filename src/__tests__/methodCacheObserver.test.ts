/**
 * The method cache observer, set with `setMethodCacheObserver()`.
 *
 * A call served from the method cache (`@cache`, `CacheLib.wrap()`) does not
 * run the method, so it makes no HTTP request and neither the transport nor
 * the HTTP cache observer sees it (see httpCacheObserver.test.ts). The
 * observer reports those hits instead: the cache key, who calls and when the
 * entry expires. A miss and a call that shares a concurrent miss are not
 * hits.
 */
import {CacheLib, MethodCacheHit, cache, setMethodCacheObserver} from '../cache.js';
import {getHttpInstanceId} from '../httpProxy.js';

let calls = 0;

class Calendar {
  @cache({ttlSeconds: 60})
  async getMonth(year: number, month: number): Promise<string[]> {
    calls++;
    return [`${year}-${month}-01`, `${year}-${month}-02`];
  }

  @cache({ttlSeconds: 60})
  async getNothing(): Promise<null> {
    calls++;
    return null;
  }

  @cache({ttlSeconds: 60})
  async getSlowly(): Promise<string> {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return 'slow';
  }
}

class TokenClient {
  @cache({callback: (response: {token: string; expiresIn: number}) => response.expiresIn})
  async getToken(): Promise<{token: string; expiresIn: number}> {
    calls++;
    return {token: `token-${calls}`, expiresIn: 120};
  }
}

class VersionedPark {
  protected cacheVersion = 3;

  getCacheKeyPrefix(): string {
    return 'versioned';
  }

  @cache({ttlSeconds: 60})
  async getPOI(language: string): Promise<string[]> {
    calls++;
    return [`poi-${language}`];
  }

  @cache({ttlSeconds: 60, key: 'schedule', cacheVersion: 7})
  async getSchedule(): Promise<string[]> {
    calls++;
    return ['schedule'];
  }
}

describe('the method cache observer', () => {
  beforeEach(() => {
    CacheLib.clear({includePersistent: true});
    calls = 0;
  });

  afterEach(() => {
    setMethodCacheObserver(null);
  });

  it('reports a hit of a @cache method, not the miss that filled it', async () => {
    const hits: MethodCacheHit[] = [];
    setMethodCacheObserver((hit) => { hits.push(hit); });

    const calendar = new Calendar();
    const before = Date.now();
    expect(await calendar.getMonth(2026, 10)).toEqual(['2026-10-01', '2026-10-02']);
    expect(calls).toBe(1);
    expect(hits).toHaveLength(0);

    expect(await calendar.getMonth(2026, 10)).toEqual(['2026-10-01', '2026-10-02']);
    expect(calls).toBe(1);
    expect(hits).toHaveLength(1);

    const [hit] = hits;
    expect(hit.key).toBe('Calendar:getMonth:[2026,10]');
    expect(hit.caller).toEqual({className: 'Calendar', methodName: 'getMonth', args: [2026, 10], instanceId: getHttpInstanceId(calendar)});
    expect(hit.expiresAt).toBeGreaterThanOrEqual(before + 60_000);
    expect(hit.expiresAt).toBeLessThanOrEqual(Date.now() + 60_000);
    expect(hit).not.toHaveProperty('value');

    await calendar.getMonth(2026, 11);
    expect(calls).toBe(2);
    expect(hits).toHaveLength(1);
  });

  it('does not report a result that is not served from the cache', async () => {
    const hits: MethodCacheHit[] = [];
    setMethodCacheObserver((hit) => { hits.push(hit); });

    const calendar = new Calendar();
    await calendar.getNothing();
    await calendar.getNothing();
    expect(calls).toBe(2);

    await calendar.getMonth(2026, 10);
    CacheLib.delete('Calendar:getMonth:[2026,10]');
    await calendar.getMonth(2026, 10);
    expect(calls).toBe(4);

    expect(hits).toHaveLength(0);
  });

  it('does not report a call that shares the execution of a concurrent miss', async () => {
    const hits: MethodCacheHit[] = [];
    setMethodCacheObserver((hit) => { hits.push(hit); });

    const calendar = new Calendar();
    expect(await Promise.all([calendar.getSlowly(), calendar.getSlowly()])).toEqual(['slow', 'slow']);
    expect(calls).toBe(1);
    expect(hits).toHaveLength(0);

    expect(await calendar.getSlowly()).toBe('slow');
    expect(calls).toBe(1);
    expect(hits).toHaveLength(1);
  });

  it('reports the expiry a lifetime callback derived', async () => {
    const hits: MethodCacheHit[] = [];
    setMethodCacheObserver((hit) => { hits.push(hit); });

    const client = new TokenClient();
    const before = Date.now();
    const first = await client.getToken();
    expect(await client.getToken()).toEqual(first);
    expect(calls).toBe(1);

    expect(hits).toHaveLength(1);
    expect(hits[0].key).toBe('TokenClient:getToken:[]');
    expect(hits[0].caller).toMatchObject({className: 'TokenClient', methodName: 'getToken', args: []});
    expect(hits[0].expiresAt).toBeGreaterThanOrEqual(before + 120_000);
    expect(hits[0].expiresAt).toBeLessThanOrEqual(Date.now() + 120_000);
  });

  it('reports the key as stored, with prefix and cache version', async () => {
    const hits: MethodCacheHit[] = [];
    setMethodCacheObserver((hit) => { hits.push(hit); });

    const park = new VersionedPark();
    await park.getPOI('nl');
    await park.getPOI('nl');
    await park.getSchedule();
    await park.getSchedule();
    expect(calls).toBe(2);

    expect(hits.map((hit) => hit.key)).toEqual(['versioned:VersionedPark:getPOI:["nl"]:v3', 'versioned:schedule:v7']);
    expect(hits.map((hit) => hit.caller.methodName)).toEqual(['getPOI', 'getSchedule']);
    for (const hit of hits) expect(CacheLib.has(hit.key)).toBe(true);
  });

  it('tells the instance served from the cache apart from the one that filled it', async () => {
    const hits: MethodCacheHit[] = [];
    setMethodCacheObserver((hit) => { hits.push(hit); });

    const first = new Calendar();
    const second = new Calendar();
    await first.getMonth(2026, 12);
    await second.getMonth(2026, 12);
    await first.getMonth(2026, 12);

    expect(calls).toBe(1);
    expect(hits).toHaveLength(2);
    expect(hits[0].caller.instanceId).toBe(getHttpInstanceId(second));
    expect(hits[1].caller.instanceId).toBe(getHttpInstanceId(first));
    expect(hits[0].caller.instanceId).not.toBe(hits[1].caller.instanceId);
  });

  it('reports a CacheLib.wrap() hit with the caller it passes, or an empty one', async () => {
    const hits: MethodCacheHit[] = [];
    setMethodCacheObserver((hit) => { hits.push(hit); });
    const fn = vi.fn(() => 'value');

    await CacheLib.wrap('direct:with-caller', fn, 60, () => ({className: 'Direct', methodName: 'getValue'}));
    await CacheLib.wrap('direct:with-caller', fn, 60, () => ({className: 'Direct', methodName: 'getValue'}));
    await CacheLib.wrap('direct:without-caller', fn, 60);
    await CacheLib.wrap('direct:without-caller', fn, 60);

    expect(fn).toHaveBeenCalledTimes(2);
    expect(hits.map(({key, caller}) => ({key, caller}))).toEqual([
      {key: 'direct:with-caller', caller: {className: 'Direct', methodName: 'getValue'}},
      {key: 'direct:without-caller', caller: {}},
    ]);
  });

  it('is quiet once set to null', async () => {
    const hits: MethodCacheHit[] = [];
    setMethodCacheObserver((hit) => { hits.push(hit); });
    setMethodCacheObserver(null);

    const calendar = new Calendar();
    await calendar.getMonth(2027, 1);
    await calendar.getMonth(2027, 1);

    expect(calls).toBe(1);
    expect(hits).toHaveLength(0);
  });

  it('builds nothing for a hit without an observer', async () => {
    const expiresAt = vi.spyOn(CacheLib, 'expiresAt');
    try {
      const caller = vi.fn(() => ({className: 'Direct'}));
      await CacheLib.wrap('direct:no-observer', () => 'value', 60, caller);
      await CacheLib.wrap('direct:no-observer', () => 'value', 60, caller);
      expect(caller).not.toHaveBeenCalled();
      expect(expiresAt).not.toHaveBeenCalled();

      setMethodCacheObserver(() => {});
      await CacheLib.wrap('direct:no-observer', () => 'value', 60, caller);
      expect(caller).toHaveBeenCalledTimes(1);
      expect(expiresAt).toHaveBeenCalledTimes(1);
    } finally {
      expiresAt.mockRestore();
    }
  });

  it('numbers no instance for a hit without an observer', async () => {
    const before = getHttpInstanceId({});
    const calendar = new Calendar();
    await calendar.getMonth(2027, 4);
    await calendar.getMonth(2027, 4);

    expect(calls).toBe(1);
    expect(getHttpInstanceId({})).toBe(before + 1);
  });

  it('does not let a throwing observer fail the hit or run the method again', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      setMethodCacheObserver(() => {
        throw new Error('observer broke');
      });

      const calendar = new Calendar();
      await calendar.getMonth(2027, 2);
      expect(await calendar.getMonth(2027, 2)).toEqual(['2027-2-01', '2027-2-02']);

      expect(calls).toBe(1);
      expect(warn).toHaveBeenCalledWith('Method cache observer failed:', expect.any(Error));
    } finally {
      warn.mockRestore();
    }
  });

  it('does not let a caller that throws while the hit is built spoil it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const observer = vi.fn();
      setMethodCacheObserver(observer);
      const fn = vi.fn(() => 'value');
      const caller = () => {
        throw new Error('caller broke');
      };

      await CacheLib.wrap('direct:throwing-caller', fn, 60, caller);
      expect(await CacheLib.wrap('direct:throwing-caller', fn, 60, caller)).toBe('value');

      expect(fn).toHaveBeenCalledTimes(1);
      expect(observer).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith('Method cache observer failed:', expect.any(Error));
    } finally {
      warn.mockRestore();
    }
  });

  it('does not wait for an async observer, and logs one that rejects', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      setMethodCacheObserver(async () => {
        await gate;
        throw new Error('observer rejected');
      });

      const calendar = new Calendar();
      await calendar.getMonth(2027, 3);
      expect(await calendar.getMonth(2027, 3)).toEqual(['2027-3-01', '2027-3-02']);
      expect(calls).toBe(1);
      expect(warn).not.toHaveBeenCalled();

      release();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(warn).toHaveBeenCalledWith('Method cache observer failed:', expect.any(Error));
    } finally {
      warn.mockRestore();
    }
  });
});

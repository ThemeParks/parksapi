/**
 * The HTTP cache observer, set with `setHttpCacheObserver()`.
 *
 * A request served from the HTTP cache never reaches the transport (see
 * httpTransport.test.ts). The observer reports those hits instead: the
 * request, who makes it, the cached body and when it expires. The
 * cache is filled against a loopback server, see helpers/localHttpServer.ts,
 * and `CacheLib.expiresAt()` is checked once on its own.
 */
import {setHttpTransport, HttpCaller} from '../httpProxy.js';
import {http, HTTPObj, HttpCacheHit, setHttpCacheObserver, stopHttpQueue} from '../http.js';
import {CacheLib} from '../cache.js';
import {startLocalServer, LocalServer} from './helpers/localHttpServer.js';

const USERS = [
  {id: 1, name: 'Ada Lovelace'},
  {id: 2, name: 'Alan Turing'},
  {id: 3, name: 'Grace Hopper'},
  {id: 4, name: 'Edsger Dijkstra'},
];

class ObserverClient {
  constructor(private readonly baseURL: string) {}

  @http({cacheSeconds: 60})
  async fetchUsers(language: string): Promise<HTTPObj> {
    return {
      method: 'POST',
      url: `${this.baseURL}/users`,
      queryParams: {lang: language},
      body: {page: 1},
      options: {json: true},
      tags: ['users'],
    } as any as HTTPObj;
  }
}

describe('CacheLib.expiresAt', () => {
  it('returns the expiry of a live entry and null otherwise', () => {
    const before = Date.now();
    CacheLib.set('expiresAt:live', 'value', 60);
    const expiresAt = CacheLib.expiresAt('expiresAt:live');
    expect(expiresAt).not.toBeNull();
    expect(expiresAt!).toBeGreaterThanOrEqual(before + 60_000);
    expect(expiresAt!).toBeLessThanOrEqual(Date.now() + 60_000);

    expect(CacheLib.expiresAt('expiresAt:missing')).toBeNull();

    CacheLib.set('expiresAt:expired', 'value', -1);
    expect(CacheLib.expiresAt('expiresAt:expired')).toBeNull();
  });
});

describe('the HTTP cache observer', () => {
  let server: LocalServer;
  let savedUserAgent: string | undefined;

  beforeAll(async () => {
    savedUserAgent = process.env.DEFAULT_USER_AGENT;
    delete process.env.DEFAULT_USER_AGENT;
    server = await startLocalServer();
  });

  afterAll(async () => {
    if (savedUserAgent === undefined) delete process.env.DEFAULT_USER_AGENT;
    else process.env.DEFAULT_USER_AGENT = savedUserAgent;
    stopHttpQueue();
    await server.close();
  });

  afterEach(() => {
    setHttpCacheObserver(null);
    setHttpTransport(null);
  });

  it('reports a cache hit the transport does not see', async () => {
    const hits: HttpCacheHit[] = [];
    setHttpCacheObserver((hit) => { hits.push(hit); });
    let transportCalls = 0;
    setHttpTransport(async (request, _caller, send) => {
      transportCalls++;
      return send(request);
    });

    const client = new ObserverClient(server.baseURL);
    const before = Date.now();
    const first = await (await client.fetchUsers('de')).json();
    expect(first).toEqual(USERS);
    expect(transportCalls).toBe(1);
    expect(hits).toHaveLength(0);

    const second = await (await client.fetchUsers('de')).json();
    expect(second).toEqual(USERS);
    expect(transportCalls).toBe(1);
    expect(hits).toHaveLength(1);

    const [hit] = hits;
    expect(hit.request).toEqual({
      method: 'POST',
      url: `${server.baseURL}/users?lang=de`,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'user-agent': 'parksapi/2.0',
        'accept-encoding': 'gzip, deflate, br',
      },
      body: '{"page":1}',
    });
    expect(hit.caller).toEqual({className: 'ObserverClient', methodName: 'fetchUsers', args: ['de'], instanceId: expect.any(Number), retryCount: 0});
    expect(hit.body).toBe(JSON.stringify(USERS));
    expect(hit.expiresAt).toBeGreaterThanOrEqual(before + 60_000);
    expect(hit.expiresAt).toBeLessThanOrEqual(Date.now() + 60_000);
  });

  it('tells the instance served from the cache apart from the one that filled it', async () => {
    const hits: HttpCacheHit[] = [];
    setHttpCacheObserver((hit) => { hits.push(hit); });
    const callers: HttpCaller[] = [];
    setHttpTransport(async (request, caller, send) => {
      callers.push(caller);
      return send(request);
    });

    const first = new ObserverClient(server.baseURL);
    const second = new ObserverClient(server.baseURL);
    await first.fetchUsers('it');
    await second.fetchUsers('it');
    await first.fetchUsers('it');

    expect(callers).toHaveLength(1);
    expect(hits).toHaveLength(2);
    expect(callers[0].instanceId).toEqual(expect.any(Number));
    expect(hits[0].caller.instanceId).toEqual(expect.any(Number));
    expect(hits[0].caller.instanceId).not.toBe(callers[0].instanceId);
    expect(hits[1].caller.instanceId).toBe(callers[0].instanceId);
  });

  it('is quiet once set to null', async () => {
    const hits: HttpCacheHit[] = [];
    setHttpCacheObserver((hit) => { hits.push(hit); });
    setHttpCacheObserver(null);
    const before = server.requests.length;

    const client = new ObserverClient(server.baseURL);
    await client.fetchUsers('en');
    await client.fetchUsers('en');

    expect(server.requests).toHaveLength(before + 1);
    expect(hits).toHaveLength(0);
  });

  it('does not let a throwing observer spoil the cached response', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      setHttpCacheObserver(() => {
        throw new Error('observer broke');
      });
      const before = server.requests.length;

      const client = new ObserverClient(server.baseURL);
      await client.fetchUsers('fr');
      const result = await (await client.fetchUsers('fr')).json();

      expect(result).toEqual(USERS);
      expect(server.requests).toHaveLength(before + 1);
      expect(warn).toHaveBeenCalledWith('HTTP cache observer failed:', expect.any(Error));
    } finally {
      warn.mockRestore();
    }
  });

  it('logs an async observer that rejects and keeps the cached response', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      setHttpCacheObserver(async () => {
        throw new Error('observer rejected');
      });

      const client = new ObserverClient(server.baseURL);
      await client.fetchUsers('nl');
      const result = await (await client.fetchUsers('nl')).json();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(result).toEqual(USERS);
      expect(warn).toHaveBeenCalledWith('HTTP cache observer failed:', expect.any(Error));
    } finally {
      warn.mockRestore();
    }
  });
});

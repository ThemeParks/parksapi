/**
 * A cache lifetime set in the environment for one decorated method.
 *
 * `{CLASSNAME}_{METHODNAME}_CACHESECONDS` replaces the `ttlSeconds` of a
 * `@cache` method and the `cacheSeconds` of an `@http` method at call time;
 * `{PREFIX}_{METHODNAME}_CACHESECONDS` does the same for a prefix registered
 * with addConfigPrefix(). A `@cache` callback keeps deriving its own lifetime.
 * The resolver is exercised directly, then each decorator through the SQLite
 * cache and, for `@http`, the loopback server (helpers/localHttpServer.ts).
 */
import config from '../config';
import {cache, cacheSecondsFromEnv, database} from '../cache';
import {http, HTTPObj, stopHttpQueue} from '../http';
import {startLocalServer, LocalServer} from './helpers/localHttpServer';

const VARIABLES = [
  'PROBE_COMPUTE_CACHESECONDS',
  'CHILD_COMPUTE_CACHESECONDS',
  'SHARED_COMPUTE_CACHESECONDS',
  'CACHEDPROBE_COMPUTE_CACHESECONDS',
  'CACHEDPROBE_TOKEN_CACHESECONDS',
  'HTTPPROBE_FETCHUSERS_CACHESECONDS',
  'HTTPPROBE_FETCHPOSTS_CACHESECONDS',
];

/** Milliseconds until the cache row for `key` expires, or undefined without a row. */
function expiresIn(key: string): number | undefined {
  const row = database.prepare('SELECT timestamp FROM cache WHERE key = ?').get(key) as {timestamp: number} | undefined;
  return row ? row.timestamp - Date.now() : undefined;
}

/** Within a second of `seconds`, which covers the clock reads either side of a call. */
function closeTo(seconds: number) {
  return {min: seconds * 1000 - 1000, max: seconds * 1000 + 1000};
}

beforeEach(() => {
  for (const name of VARIABLES) delete process.env[name];
});

afterAll(() => {
  for (const name of VARIABLES) delete process.env[name];
});

describe('cacheSecondsFromEnv', () => {
  @config
  class Probe {
    config: {configPrefixes?: string[]} = {};
    async compute(): Promise<number> {
      return 1;
    }
  }

  class Child extends Probe {}

  it('is undefined when nothing is set', () => {
    expect(cacheSecondsFromEnv(new Probe(), 'compute')).toBeUndefined();
  });

  it('reads {CLASSNAME}_{METHODNAME}_CACHESECONDS', () => {
    process.env.PROBE_COMPUTE_CACHESECONDS = '120';
    expect(cacheSecondsFromEnv(new Probe(), 'compute')).toBe(120);
  });

  it('reads {PREFIX}_{METHODNAME}_CACHESECONDS for a registered prefix', () => {
    process.env.SHARED_COMPUTE_CACHESECONDS = '30';
    const probe = new Probe();
    expect(cacheSecondsFromEnv(probe, 'compute')).toBeUndefined();
    probe.config.configPrefixes = ['SHARED'];
    expect(cacheSecondsFromEnv(probe, 'compute')).toBe(30);
  });

  it('lets the class name win over a prefix', () => {
    process.env.PROBE_COMPUTE_CACHESECONDS = '120';
    process.env.SHARED_COMPUTE_CACHESECONDS = '30';
    const probe = new Probe();
    probe.config.configPrefixes = ['SHARED'];
    expect(cacheSecondsFromEnv(probe, 'compute')).toBe(120);
  });

  it('resolves a subclass under its own name', () => {
    process.env.CHILD_COMPUTE_CACHESECONDS = '45';
    expect(cacheSecondsFromEnv(new Child(), 'compute')).toBe(45);
    expect(cacheSecondsFromEnv(new Probe(), 'compute')).toBeUndefined();
  });

  it('accepts 0 and ignores a value that is not a non-negative number', () => {
    process.env.PROBE_COMPUTE_CACHESECONDS = '0';
    expect(cacheSecondsFromEnv(new Probe(), 'compute')).toBe(0);
    for (const value of ['', 'abc', '-1', 'Infinity']) {
      process.env.PROBE_COMPUTE_CACHESECONDS = value;
      expect(cacheSecondsFromEnv(new Probe(), 'compute'), `value "${value}"`).toBeUndefined();
    }
  });
});

describe('@cache with a lifetime from the environment', () => {
  let calls = 0;

  @config
  class CachedProbe {
    @cache({ttlSeconds: 3600})
    async compute(): Promise<number> {
      calls += 1;
      return calls;
    }

    @cache({callback: () => 900})
    async token(): Promise<string> {
      return 'token';
    }
  }

  const COMPUTE_KEY = 'CachedProbe:compute:[]';
  const TOKEN_KEY = 'CachedProbe:token:[]';

  beforeEach(() => {
    calls = 0;
    database.prepare('DELETE FROM cache WHERE key IN (?, ?)').run(COMPUTE_KEY, TOKEN_KEY);
  });

  it('keeps ttlSeconds when nothing is set', async () => {
    await new CachedProbe().compute();
    const {min, max} = closeTo(3600);
    expect(expiresIn(COMPUTE_KEY)).toBeGreaterThan(min);
    expect(expiresIn(COMPUTE_KEY)).toBeLessThan(max);
  });

  it('replaces ttlSeconds', async () => {
    process.env.CACHEDPROBE_COMPUTE_CACHESECONDS = '120';
    await new CachedProbe().compute();
    const {min, max} = closeTo(120);
    expect(expiresIn(COMPUTE_KEY)).toBeGreaterThan(min);
    expect(expiresIn(COMPUTE_KEY)).toBeLessThan(max);
  });

  it('runs the method every time at 0', async () => {
    process.env.CACHEDPROBE_COMPUTE_CACHESECONDS = '0';
    const probe = new CachedProbe();
    await probe.compute();
    await new Promise(resolve => setTimeout(resolve, 5));
    await probe.compute();
    expect(calls).toBe(2);
  });

  it('leaves a callback lifetime alone', async () => {
    process.env.CACHEDPROBE_TOKEN_CACHESECONDS = '120';
    await new CachedProbe().token();
    const {min, max} = closeTo(900);
    expect(expiresIn(TOKEN_KEY)).toBeGreaterThan(min);
    expect(expiresIn(TOKEN_KEY)).toBeLessThan(max);
  });
});

describe('@http with a lifetime from the environment', () => {
  let server: LocalServer;

  class HttpProbe {
    constructor(private readonly baseURL: string) {}

    @http({cacheSeconds: 60})
    async fetchUsers(): Promise<HTTPObj> {
      return {method: 'GET', url: `${this.baseURL}/users`, tags: ['users']} as HTTPObj;
    }

    @http()
    async fetchPosts(): Promise<HTTPObj> {
      return {method: 'GET', url: `${this.baseURL}/posts`, tags: ['posts']} as HTTPObj;
    }
  }

  beforeAll(async () => {
    server = await startLocalServer();
  });

  afterAll(async () => {
    stopHttpQueue();
    await server.close();
  });

  it('stops caching a cacheSeconds method at 0', async () => {
    process.env.HTTPPROBE_FETCHUSERS_CACHESECONDS = '0';
    const probe = new HttpProbe(server.baseURL);
    await probe.fetchUsers();
    await probe.fetchUsers();
    expect(server.requests.filter(path => path === '/users')).toHaveLength(2);
  });

  it('starts caching a method that sets no cacheSeconds', async () => {
    process.env.HTTPPROBE_FETCHPOSTS_CACHESECONDS = '300';
    const probe = new HttpProbe(server.baseURL);
    await probe.fetchPosts();
    await probe.fetchPosts();
    expect(server.requests.filter(path => path === '/posts')).toHaveLength(1);
  });
});

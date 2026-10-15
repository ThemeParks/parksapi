import {CacheLib as Cache, database} from '../cache.js';
import cache from '../cache.js';

// Silence the library's own console.error noise, like the other cache suites.
const originalConsoleError = console.error;
beforeEach(() => {
  console.error = vi.fn();
  Cache.clear({includePersistent: true});
});
afterEach(() => {
  console.error = originalConsoleError;
  Cache.clear({includePersistent: true});
});

const PKG = 'jp.tokyodisneyresort.portalapp';

describe('CacheLib.clearMatching', () => {
  describe('what it matches', () => {
    test('deletes only rows of that class whose key contains the substring', () => {
      Cache.set(`TestPark:getVersion:["${PKG}","1.0"]`, '3.12.3');
      Cache.set('TestPark:getToken:[]', 'tok');
      Cache.set(`OtherPark:getVersion:["${PKG}","1.0"]`, 'other');

      const result = Cache.clearMatching('TestPark', {contains: PKG});

      expect(result).toMatchObject({matched: 1, cleared: 1, capped: false});
      expect(Cache.has(`TestPark:getVersion:["${PKG}","1.0"]`)).toBe(false);
      expect(Cache.has('TestPark:getToken:[]')).toBe(true);
      expect(Cache.has(`OtherPark:getVersion:["${PKG}","1.0"]`)).toBe(true);
    });

    test('matches prefixed keys that carry the class name in the middle', () => {
      Cache.set(`attractionsio:1:AttractionsIOV3:getConfig:["${PKG}"]`, 'a');
      Cache.set(`attractionsio:2:AttractionsIOV3:getConfig:["${PKG}"]`, 'b');
      Cache.set(`attractionsio:1:SomethingElse:getConfig:["${PKG}"]`, 'c');

      const result = Cache.clearMatching('AttractionsIOV3', {contains: PKG});

      expect(result).toMatchObject({matched: 2, cleared: 2});
      expect(Cache.has(`attractionsio:1:SomethingElse:getConfig:["${PKG}"]`)).toBe(true);
    });

    test('a class name that is only the start of another class does not match', () => {
      Cache.set(`Tokyo:getVersion:["${PKG}"]`, 'a');
      Cache.set(`TokyoDisneyResort:getVersion:["${PKG}"]`, 'b');

      const result = Cache.clearMatching('Tokyo', {contains: PKG});

      expect(result.cleared).toBe(1);
      expect(Cache.has(`TokyoDisneyResort:getVersion:["${PKG}"]`)).toBe(true);
    });

    test('the substring is case-sensitive', () => {
      Cache.set('TestPark:getVersion:["ABCD"]', 'a');

      expect(Cache.clearMatching('TestPark', {contains: 'abcd'})).toMatchObject({matched: 0, cleared: 0});
      expect(Cache.has('TestPark:getVersion:["ABCD"]')).toBe(true);
      expect(Cache.clearMatching('TestPark', {contains: 'ABCD'})).toMatchObject({matched: 1, cleared: 1});
    });

    test('characters that are wildcards in SQL LIKE are literal', () => {
      Cache.set('TestPark:getVersion:["a_b"]', 'underscore');
      Cache.set('TestPark:getVersion:["axb"]', 'other');
      Cache.set('TestPark:getVersion:["100%"]', 'percent');

      expect(Cache.clearMatching('TestPark', {contains: 'a_b'}).cleared).toBe(1);
      expect(Cache.has('TestPark:getVersion:["axb"]')).toBe(true);
      expect(Cache.clearMatching('TestPark', {contains: '0%"'}).cleared).toBe(1);
    });

    test('does not count rows that have already expired', () => {
      Cache.set('TestPark:getVersion:["live"]', 'a', 60);
      Cache.set('TestPark:getVersion:["dead"]', 'b', 60);
      // Age the second row past its expiry without waiting.
      database.prepare('UPDATE cache SET timestamp = ? WHERE key = ?').run(Date.now() - 1000, 'TestPark:getVersion:["dead"]');

      const result = Cache.clearMatching('TestPark', {contains: 'getVersion'});

      expect(result).toMatchObject({matched: 1, cleared: 1});
    });
  });

  describe('persistent operational state', () => {
    // A flush means "refetch", never "forget what we have observed". The
    // protected list lives in cacheKeys.ts and is deliberately not exported, so
    // this method has to apply it itself.
    test('never matches, counts or deletes a persistent key even when the substring hits it', () => {
      Cache.set('TestPark:getToken:["abc"]', 'tok');
      Cache.set('TestPark:liveEntityRetirement:abc', {seen: 1});
      Cache.set('TestPark:accounts:refreshToken:abc', 'rt');
      Cache.set('TestPark:dlp:queueBearingHistory:abc', ['x']);

      const result = Cache.clearMatching('TestPark', {contains: 'abc'});

      expect(result).toMatchObject({matched: 1, cleared: 1});
      expect(Cache.has('TestPark:getToken:["abc"]')).toBe(false);
      expect(Cache.has('TestPark:liveEntityRetirement:abc')).toBe(true);
      expect(Cache.has('TestPark:accounts:refreshToken:abc')).toBe(true);
      expect(Cache.has('TestPark:dlp:queueBearingHistory:abc')).toBe(true);
    });

    test('a dry run does not count persistent keys either', () => {
      Cache.set('TestPark:liveEntityRetirement:abc', {seen: 1});

      expect(Cache.clearMatching('TestPark', {contains: 'abc', dryRun: true})).toMatchObject({matched: 0});
    });
  });

  describe('dryRun', () => {
    test('counts and groups the matches and deletes nothing', () => {
      Cache.set('TestPark:getVersion:["x1"]', 'a');
      Cache.set('TestPark:getVersion:["x2"]', 'b');
      Cache.set('TestPark:GET:https://example.test/x1:{}', 'c');

      const result = Cache.clearMatching('TestPark', {contains: 'x', dryRun: true});

      expect(result.matched).toBe(3);
      expect(result.cleared).toBe(0);
      expect(result.groups).toEqual([
        {group: 'TestPark:getVersion', rows: 2},
        {group: 'TestPark:GET', rows: 1},
      ]);
      expect(Cache.size()).toBe(3);
    });
  });

  describe('maxRows', () => {
    test('deletes nothing when more rows match than the cap, and reports the true count', () => {
      for (let i = 0; i < 5; i++) Cache.set(`TestPark:getVersion:["k${i}"]`, i);

      const result = Cache.clearMatching('TestPark', {contains: 'getVersion', maxRows: 4});

      expect(result).toMatchObject({matched: 5, cleared: 0, capped: true});
      expect(Cache.size()).toBe(5);
    });

    test('deletes when the match count equals the cap', () => {
      for (let i = 0; i < 4; i++) Cache.set(`TestPark:getVersion:["k${i}"]`, i);

      const result = Cache.clearMatching('TestPark', {contains: 'getVersion', maxRows: 4});

      expect(result).toMatchObject({matched: 4, cleared: 4, capped: false});
      expect(Cache.size()).toBe(0);
    });

    test('a dry run reports capped so the caller can predict a refusal', () => {
      for (let i = 0; i < 3; i++) Cache.set(`TestPark:getVersion:["k${i}"]`, i);

      expect(Cache.clearMatching('TestPark', {contains: 'getVersion', maxRows: 2, dryRun: true}))
        .toMatchObject({matched: 3, cleared: 0, capped: true});
    });

    test('no cap means no refusal', () => {
      for (let i = 0; i < 50; i++) Cache.set(`TestPark:getVersion:["k${i}"]`, i);

      expect(Cache.clearMatching('TestPark', {contains: 'getVersion'})).toMatchObject({matched: 50, cleared: 50, capped: false});
    });
  });

  describe('result never carries raw keys', () => {
    // HTTP-layer keys embed the request headers JSON, which can hold an API key.
    test('groups hold only the class and method or verb', () => {
      const secretKey = `TestPark:GET:https://example.test/v1/${PKG}:{"x-api-key":"SECRET-123","authorization":"Bearer ZZZ"}`;
      Cache.set(secretKey, 'body');

      const wire = JSON.stringify(Cache.clearMatching('TestPark', {contains: PKG, dryRun: true}));

      expect(wire).toContain('TestPark:GET');
      for (const leaked of ['SECRET-123', 'Bearer', 'x-api-key', 'example.test', PKG]) {
        expect(wire, `leaked ${leaked}`).not.toContain(leaked);
      }
    });

    test('a head that is not an identifier is reported as (other)', () => {
      Cache.set('TestPark:["weird head with spaces"]:abc', 'a');
      Cache.set(`TestPark:${'x'.repeat(80)}:abc`, 'b');

      const result = Cache.clearMatching('TestPark', {contains: 'abc', dryRun: true});

      expect(result.groups).toEqual([{group: 'TestPark:(other)', rows: 2}]);
    });

    test('at most 20 groups: the tail is rolled into (other)', () => {
      for (let i = 0; i < 30; i++) Cache.set(`TestPark:method${String(i).padStart(2, '0')}:abc`, i);

      const result = Cache.clearMatching('TestPark', {contains: 'abc', dryRun: true});

      expect(result.groups).toHaveLength(20);
      expect(result.groups.reduce((n, g) => n + g.rows, 0)).toBe(30);
      expect(result.groups.at(-1)).toEqual({group: 'TestPark:(other)', rows: 11});
    });
  });

  describe('argument checks', () => {
    // A cleared class is a worse failure than a thrown error, so a bad call
    // must throw rather than quietly match everything or nothing.
    test.each([
      ['empty substring', 'TestPark', {contains: ''}],
      ['missing substring', 'TestPark', {} as any],
      ['non-string substring', 'TestPark', {contains: 5 as any}],
      ['empty class name', '', {contains: 'abc'}],
      ['negative cap', 'TestPark', {contains: 'abc', maxRows: -1}],
      ['fractional cap', 'TestPark', {contains: 'abc', maxRows: 1.5}],
    ])('throws on %s', (_label, className, options) => {
      Cache.set('TestPark:getVersion:["abc"]', 'a');

      expect(() => Cache.clearMatching(className, options)).toThrow(/clearMatching: .* must be/);
      expect(Cache.has('TestPark:getVersion:["abc"]')).toBe(true);
    });
  });

  describe('against the real @cache decorator', () => {
    // The regression this exists for: a flush written against a hand-typed key
    // never matched the key the decorator really builds (it appends every
    // argument), so the stale value sat out its whole lifetime. This drives the
    // decorator, so the key shape under test is the real one.
    test('drops a value cached with extra arguments so the next call recomputes it', async () => {
      let calls = 0;
      class VersionLookup {
        @cache({ttlSeconds: 3600})
        async latest(packageId: string, fallback: string = ''): Promise<string> {
          calls++;
          return `${packageId}@${calls}${fallback}`;
        }
      }
      const lookup = new VersionLookup();

      expect(await lookup.latest(PKG, '3.0.16')).toBe(`${PKG}@1` + '3.0.16');
      expect(await lookup.latest(PKG, '3.0.16')).toBe(`${PKG}@1` + '3.0.16'); // served from cache
      expect(calls).toBe(1);

      const result = Cache.clearMatching('VersionLookup', {contains: PKG});

      expect(result).toMatchObject({matched: 1, cleared: 1});
      expect(await lookup.latest(PKG, '3.0.16')).toBe(`${PKG}@2` + '3.0.16');
      expect(calls).toBe(2);
    });
  });

  test('throws are not swallowed: a database failure reaches the caller', () => {
    const spy = vi.spyOn(database, 'prepare').mockImplementationOnce(() => {
      throw new Error('disk I/O error');
    });

    expect(() => Cache.clearMatching('TestPark', {contains: 'abc'})).toThrow('disk I/O error');
    spy.mockRestore();
    // The failed call must not leave a transaction open: a normal write still works.
    Cache.set('TestPark:after:["abc"]', 1);
    expect(Cache.has('TestPark:after:["abc"]')).toBe(true);
  });
});

import {CacheLib as Cache, database} from '../cache.js';
import cache from '../cache.js';
import {PERSISTENT_KEY_FRAGMENTS} from '../cacheKeys.js';

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
    // protected list lives in cacheKeys.ts and stays out of the package entry
    // point, so a caller cannot honour it itself: this method has to.
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
      // NaN would silently switch the cap off (`n > NaN` is false).
      ['NaN cap', 'TestPark', {contains: 'abc', maxRows: NaN}],
      ['infinite cap', 'TestPark', {contains: 'abc', maxRows: Infinity}],
      ['null cap', 'TestPark', {contains: 'abc', maxRows: null as any}],
      // A caller forwarding an unset flag must not get a destructive default.
      ['null dryRun', 'TestPark', {contains: 'abc', dryRun: null as any}],
      ['numeric dryRun', 'TestPark', {contains: 'abc', dryRun: 0 as any}],
      ['empty-string dryRun', 'TestPark', {contains: 'abc', dryRun: '' as any}],
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

describe('CacheLib.clearMatching: guards the first test file left open', () => {
  test('a class name only matches at a segment boundary, never as a suffix', () => {
    Cache.set('TokyoDisneyResort:getVersion:["abc"]', 'a');
    Cache.set('Resort:getVersion:["abc"]', 'b');

    expect(Cache.clearMatching('Resort', {contains: 'abc'}).cleared).toBe(1);
    expect(Cache.has('TokyoDisneyResort:getVersion:["abc"]')).toBe(true);
    expect(Cache.has('Resort:getVersion:["abc"]')).toBe(false);
  });

  test('a cap of 0 refuses as soon as anything matches', () => {
    Cache.set('TestPark:getVersion:["abc"]', 'a');

    expect(Cache.clearMatching('TestPark', {contains: 'abc', maxRows: 0})).toMatchObject({matched: 1, cleared: 0, capped: true});
    expect(Cache.has('TestPark:getVersion:["abc"]')).toBe(true);
  });

  test.each([
    ["a quote and a statement in the substring", 'TestPark', "'; DROP TABLE cache; --"],
    ["an always-true clause in the substring", 'TestPark', "x' OR '1'='1"],
    ["a quote in the class name", "Test'Park", 'abc'],
  ])('values are bound, never interpolated: %s', (_label, className, contains) => {
    Cache.set('TestPark:getVersion:["abc"]', 'a');

    expect(Cache.clearMatching(className, {contains})).toMatchObject({matched: 0, cleared: 0});
    expect(Cache.has('TestPark:getVersion:["abc"]')).toBe(true);
    expect(Cache.size()).toBe(1); // the table is still there
  });

  test('a failure part-way through the deletes leaves every row, no open transaction, and the next call works', () => {
    for (let i = 0; i < 4; i++) Cache.set(`TestPark:getVersion:["k${i}"]`, i);
    const realPrepare = database.prepare.bind(database);
    let removed = 0;
    const spy = vi.spyOn(database, 'prepare').mockImplementation(((sql: string) => {
      const statement: any = realPrepare(sql);
      if (!sql.startsWith('DELETE FROM cache WHERE key')) return statement;
      return new Proxy(statement, {
        get(target, prop) {
          if (prop === 'run') {
            return (...args: any[]) => {
              if (++removed === 3) throw new Error('disk full');
              return target.run(...args);
            };
          }
          const value = target[prop];
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    }) as any);

    expect(() => Cache.clearMatching('TestPark', {contains: 'getVersion'})).toThrow('disk full');
    spy.mockRestore();

    // The transaction rolled back as a whole, and is closed.
    expect(database.isTransaction).toBe(false);
    expect(Cache.size()).toBe(4);
    expect(Cache.clearMatching('TestPark', {contains: 'getVersion'})).toMatchObject({matched: 4, cleared: 4});
  });

  describe('persistent state', () => {
    test.each(PERSISTENT_KEY_FRAGMENTS.map(fragment => [fragment]))('honours the protected fragment %s', fragment => {
      const key = `TestPark${fragment}abc`;
      Cache.set(key, 'kept');
      Cache.set('TestPark:getVersion:["abc"]', 'dropped');

      const result = Cache.clearMatching('TestPark', {contains: 'abc'});

      expect(result).toMatchObject({matched: 1, cleared: 1});
      expect(Cache.has(key)).toBe(true);
    });

    test('protected rows never show up in the groups either', () => {
      Cache.set('TestPark:liveEntityRetirement:abc', {seen: 1});
      Cache.set('TestPark:dlp:queueBearingHistory:abc', ['x']);
      Cache.set('TestPark:getVersion:["abc"]', 'a');

      const result = Cache.clearMatching('TestPark', {contains: 'abc', dryRun: true});

      expect(result.groups).toEqual([{group: 'TestPark:getVersion', rows: 1}]);
    });

    // The sticky-SHOW record is a 30-day observation that is refreshed on every
    // sighting; losing it flips a show back to an attraction until the next one.
    test('protects the sticky-show record', () => {
      Cache.set('fantawild:seenAsShow:v1:5:1455', true, 60 * 60 * 24 * 30);
      Cache.set('fantawild:getParks:[]', ['x']);

      const result = Cache.clearMatching('fantawild', {contains: ':'});

      expect(result).toMatchObject({matched: 1, cleared: 1});
      expect(Cache.has('fantawild:seenAsShow:v1:5:1455')).toBe(true);
    });
  });

  test('a class name that recurs later in the key is still grouped by its first segment', () => {
    Cache.set('TestPark:getVersion:["TestPark:getOther"]', 'a');

    expect(Cache.clearMatching('TestPark', {contains: 'getOther', dryRun: true}).groups)
      .toEqual([{group: 'TestPark:getVersion', rows: 1}]);
  });

  test('a dry run takes no write lock, so it cannot block other writers', () => {
    Cache.set('TestPark:getVersion:["abc"]', 'a');
    const exec = vi.spyOn(database, 'exec');

    Cache.clearMatching('TestPark', {contains: 'abc', dryRun: true});
    const dryBegin = exec.mock.calls.map(c => c[0]).find(sql => String(sql).startsWith('BEGIN'));
    exec.mockClear();
    Cache.clearMatching('TestPark', {contains: 'abc'});
    const realBegin = exec.mock.calls.map(c => c[0]).find(sql => String(sql).startsWith('BEGIN'));
    exec.mockRestore();

    expect(dryBegin).toBe('BEGIN');
    expect(realBegin).toBe('BEGIN IMMEDIATE');
  });
});

describe('CacheLib.clearMatching: the substring cannot be used to read credentials out of a key', () => {
  // An HTTP-layer key is `Class:VERB:url:{headers}:body`, so the headers, the
  // query string and the body of a request are all in it. A caller that can
  // choose the substring and read the match count could recover a credential
  // one character at a time. The substring is therefore tested only against the
  // class, the verb and the URL up to its query string.
  const httpKey = (url: string, headers: object, body = '') =>
    `TestPark:GET:${url}:${JSON.stringify(headers)}:${body}`;

  beforeEach(() => {
    Cache.set(
      httpKey('https://api.example.test/v1/things?token=QUERYSECRET9', {authorization: 'Bearer tok_ABCDEF', 'x-api-key': 'KEYSECRET7'}, '{"password":"hunter2"}'),
      'body',
    );
  });

  test.each([
    ['a header value', 'Bearer tok_A'],
    ['a header name', 'x-api-key'],
    ['a header secret', 'KEYSECRET7'],
    ['a query string value', 'QUERYSECRET9'],
    ['the query string marker', '?token='],
    ['a body value', 'hunter2'],
  ])('does not match %s', (_label, probe) => {
    expect(Cache.clearMatching('TestPark', {contains: probe, dryRun: true})).toMatchObject({matched: 0, cleared: 0});
    expect(Cache.clearMatching('TestPark', {contains: probe})).toMatchObject({matched: 0, cleared: 0});
    expect(Cache.size()).toBe(1);
  });

  test.each([
    ['the host', 'api.example.test'],
    ['the path', '/v1/things'],
    ['the verb and URL as stored', 'TestPark:GET:https://api.example.test'],
  ])('still matches %s', (_label, probe) => {
    expect(Cache.clearMatching('TestPark', {contains: probe, dryRun: true})).toMatchObject({matched: 1});
  });

  test('a fixed-name key (no verb after the class) is still matched on the whole key', () => {
    Cache.set('TestPark:customName:abc-123', 'x');

    expect(Cache.clearMatching('TestPark', {contains: 'abc-123', dryRun: true})).toMatchObject({matched: 1});
  });

  test('method arguments of a decorated method are still matched', () => {
    Cache.set('TestPark:getVersion:["pkg.name","3.0.16"]', 'x');

    expect(Cache.clearMatching('TestPark', {contains: '3.0.16', dryRun: true})).toMatchObject({matched: 1});
  });

  test('a prefixed HTTP key is narrowed the same way', () => {
    Cache.set(`prefix:1:${httpKey('https://api.example.test/p', {authorization: 'Bearer PREFIXSECRET'})}`, 'x');

    expect(Cache.clearMatching('TestPark', {contains: 'PREFIXSECRET', dryRun: true}).matched).toBe(0);
    expect(Cache.clearMatching('TestPark', {contains: '/p', dryRun: true}).matched).toBe(1);
  });

  test('the real run deletes exactly the rows the dry run counted', () => {
    Cache.set(httpKey('https://api.example.test/v1/other', {authorization: 'Bearer different'}), 'y');

    const dry = Cache.clearMatching('TestPark', {contains: 'api.example.test', dryRun: true});
    const real = Cache.clearMatching('TestPark', {contains: 'api.example.test'});

    expect(dry.matched).toBe(2);
    expect(real).toMatchObject({matched: 2, cleared: 2});
  });

  test('a key with no recognisable header block exposes only its class and verb, never the tail', () => {
    Cache.set('TestPark:POST:https://api.example.test/x:BODYSECRET', 'x');

    expect(Cache.clearMatching('TestPark', {contains: 'BODYSECRET', dryRun: true}).matched).toBe(0);
  });
});

describe('CacheLib.clearMatching: credentials carried in the URL path', () => {
  // Some upstreams put the API key in the path itself
  // (`https://host/<32 hex>.json`). A path segment that looks like a token is
  // masked, so it cannot be recovered one character at a time either. This is a
  // heuristic: 16 or more letters, digits, `_` or `-` including at least one
  // digit (an extension such as `.json` is set aside first).
  const key = (url: string) => `TestPark:GET:${url}:${JSON.stringify({accept: 'application/json'})}:`;
  const HEX = '0123456789abcdef0123456789abcdef';

  beforeEach(() => {
    Cache.set(key(`https://live-data.attractions.example/${HEX}.json`), 'body');
  });

  test.each([
    ['the whole token', HEX],
    ['a prefix of the token', HEX.slice(0, 8)],
    ['the token with its extension', `${HEX}.json`],
    ['a slice from the middle', HEX.slice(10, 20)],
  ])('does not match %s', (_label, probe) => {
    expect(Cache.clearMatching('TestPark', {contains: probe, dryRun: true}).matched).toBe(0);
  });

  test.each([
    ['the host', 'live-data.attractions.example'],
    ['the extension', '.json'],
    ['the verb and host as stored', 'TestPark:GET:https://live-data.attractions.example/'],
  ])('still matches %s', (_label, probe) => {
    expect(Cache.clearMatching('TestPark', {contains: probe, dryRun: true}).matched).toBe(1);
  });

  test('ordinary path segments stay searchable, including long words and dotted ids', () => {
    Cache.set(key('https://api.example.test/appwatch/latest/jp.tokyodisneyresort.portalapp'), 'a');
    Cache.set(key('https://api.example.test/liveentertainmentservice/rides'), 'b');
    Cache.set(key('https://api.example.test/v2/parks/12345/rides'), 'c');

    expect(Cache.clearMatching('TestPark', {contains: 'jp.tokyodisneyresort.portalapp', dryRun: true}).matched).toBe(1);
    expect(Cache.clearMatching('TestPark', {contains: 'liveentertainmentservice', dryRun: true}).matched).toBe(1);
    expect(Cache.clearMatching('TestPark', {contains: '/parks/12345/rides', dryRun: true}).matched).toBe(1);
  });

  test('the length boundary: 16 characters with a digit is masked, 15 is not', () => {
    Cache.set(key('https://api.example.test/abcdefghijklmno1'), 'sixteen');
    Cache.set(key('https://api.example.test/abcdefghijklmn1'), 'fifteen');

    expect(Cache.clearMatching('TestPark', {contains: 'abcdefghijklmno1', dryRun: true}).matched).toBe(0);
    expect(Cache.clearMatching('TestPark', {contains: 'abcdefghijklmn1', dryRun: true}).matched).toBe(1);
  });

  test('credentials in the host part (user:password@) are not searchable', () => {
    Cache.set(key('https://svc-user:S3cretPassw0rd@host.example.test/path'), 'x');

    expect(Cache.clearMatching('TestPark', {contains: 'S3cretPassw0rd', dryRun: true}).matched).toBe(0);
    expect(Cache.clearMatching('TestPark', {contains: 'svc-user', dryRun: true}).matched).toBe(0);
    expect(Cache.clearMatching('TestPark', {contains: 'host.example.test/path', dryRun: true}).matched).toBe(1);
  });

  test('a real clear deletes exactly what the dry run counted', () => {
    Cache.set(key('https://live-data.attractions.example/other-path'), 'y');

    expect(Cache.clearMatching('TestPark', {contains: 'live-data.attractions.example', dryRun: true}).matched).toBe(2);
    expect(Cache.clearMatching('TestPark', {contains: 'live-data.attractions.example'})).toMatchObject({matched: 2, cleared: 2});
  });
});

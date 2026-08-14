import {describe, test, expect, beforeEach, afterEach, beforeAll, afterAll, vi} from 'vitest';
import {createServer, IncomingMessage, ServerResponse} from 'http';
import {AddressInfo} from 'net';
import {WalibiBelgium} from '../walibi.js';
import {CacheLib} from '../../../cache.js';
import type {HTTPObj} from '../../../http.js';

/**
 * The CMS serves one attractions feed per locale and those locales drift.
 * Walibi Belgium's `nl` feed silently omits VAMPIRE (waitingTimeName 34) — as
 * does `en`. Only `fr` lists it, so on `nl` the ride had no entity and its
 * wait time was dropped on the floor even though waitingtimes.v1.json reported
 * it open the whole time. The park now runs on `fr`; the merge covers the same
 * drift wherever it shows up next (today: Le Galion and Tam Tam Aventure on
 * Walibi Rhône-Alpes).
 *
 * These fixtures are trimmed from real captures of
 * https://www.walibi.be/api/wbe/{nl,fr,en}/attractions.v1.json.
 */

/** KONDAA — listed identically in every locale, the canary for these tests. */
const KONDAA = {
  title: 'KONDAA',
  waitingTimeName: '45',
  latitude: 50.7015,
  longitude: 4.5905,
  path: '/content/dam/wbe/nl/attractions/frissons-attractions/kondaa-files/kondaa',
};

/** VAMPIRE — present only in the `fr` feed. */
const VAMPIRE = {
  title: 'VAMPIRE',
  waitingTimeName: '34',
  path: '/content/dam/wbe/fr/attractions/frissons-attractions/vampire-files/vampire',
};

/**
 * FLASH-BACK — one ride, listed in two locales under a different title *and* a
 * different path. Only waitingTimeName is stable across locales, which is why
 * it is the merge key.
 */
const FLASHBACK_NL = {title: 'FLASH-BACK', waitingTimeName: '9', path: '/nl/flash-back'};
const FLASHBACK_FR = {title: 'FLASH BACK', waitingTimeName: '9', path: '/fr/flash-back'};

const FEEDS: Record<string, any[]> = {
  nl: [KONDAA, FLASHBACK_NL],
  // `en` deliberately does not re-list FLASH-BACK: otherwise a fallback that
  // overwrote the primary would still end on the `nl` spelling by accident,
  // and the precedence test below would pass under that mutation.
  fr: [KONDAA, FLASHBACK_FR, VAMPIRE],
  en: [KONDAA],
};

/**
 * A park whose per-locale attraction feeds come from `feeds`; a locale mapped
 * to `null` throws, standing in for a transient 5xx or a malformed response.
 */
function stubbedPark(feeds: Record<string, any[] | null> = FEEDS, waitTimes: any[] = []): WalibiBelgium {
  const park = new WalibiBelgium();
  // Pin the locale rather than inherit the park's configured one: these tests
  // cover the merge in WalibiBase, which must hold whichever locale a park is
  // set to. Walibi Belgium itself now runs on `fr`, the locale that does list
  // VAMPIRE — driving it from `nl` here reproduces the original gap.
  park.culture = 'nl';
  park.mergeCultures = ['nl', 'fr', 'en'];
  park.fetchAttractions = (async (culture: string) => {
    const feed = feeds[culture];
    if (feed === undefined) return {json: async () => []} as any as HTTPObj;
    if (feed === null) throw new Error(`upstream failure for locale: ${culture}`);
    return {json: async () => feed} as any as HTTPObj;
  }) as any;
  park.getRestaurants = async () => [];
  park.getWaitTimes = async () => waitTimes;
  return park;
}

describe('WalibiBase.getAttractions — merging CMS locales', () => {
  beforeEach(() => CacheLib.clear());
  afterEach(() => {
    CacheLib.clear();
    vi.restoreAllMocks();
  });

  test('publishes an attraction the configured locale omits but another locale lists', async () => {
    const entities = await stubbedPark().getEntities();

    expect(entities.find(e => e.id === '45')).toMatchObject({name: 'KONDAA', entityType: 'ATTRACTION'});
    expect(entities.find(e => e.id === '34')).toMatchObject({name: 'VAMPIRE', entityType: 'ATTRACTION'});
  });

  test('publishes live data for an attraction only a fallback locale lists', async () => {
    const waitTimes = [
      {id: '45', time: 1200, status: 'open'},
      {id: '34', time: 300, status: 'open'},
    ];

    const live = await stubbedPark(FEEDS, waitTimes).getLiveData();

    expect(live.find(l => l.id === '45')).toMatchObject({status: 'OPERATING', queue: {STANDBY: {waitTime: 20}}});
    expect(live.find(l => l.id === '34')).toMatchObject({status: 'OPERATING', queue: {STANDBY: {waitTime: 5}}});
  });

  test('keeps the configured locale name when a fallback locale spells it differently', async () => {
    const entities = await stubbedPark().getEntities();

    expect(entities.find(e => e.id === '9')?.name).toBe('FLASH-BACK');
  });

  test('matches locales on waitingTimeName, not on title or path, so one ride stays one entity', async () => {
    // FLASH-BACK differs in both title and path between `nl` and `fr`; keying
    // the merge on either would emit a second entity under the same id.
    const entities = await stubbedPark().getEntities();

    const flashback = entities.filter(e => e.id === '9');
    expect(flashback).toHaveLength(1);
    expect(entities.filter(e => e.entityType === 'ATTRACTION')).toHaveLength(3); // KONDAA, FLASH-BACK, VAMPIRE
  });

  test('a fallback locale that fails to load is skipped without sinking the merge', async () => {
    const entities = await stubbedPark({...FEEDS, en: null}).getEntities();

    expect(entities.find(e => e.id === '45')).toBeDefined();
    expect(entities.find(e => e.id === '34')).toBeDefined();
  });

  test('the configured locale failing propagates, rather than publishing an empty park', async () => {
    // The merge must not turn a transient upstream error into a clean, empty,
    // wrong answer — that would be cached for 24h and shared by every process.
    await expect(stubbedPark({...FEEDS, nl: null}).getEntities()).rejects.toThrow(/upstream failure/);
    await expect(stubbedPark({...FEEDS, nl: null}).getLiveData()).rejects.toThrow(/upstream failure/);
  });

  test('a wait time with no attraction in any locale is skipped, and warned about once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const park = stubbedPark(FEEDS, [{id: '45', time: 1200, status: 'open'}, {id: '999', time: 300, status: 'open'}]);

    const first = await park.getLiveData();
    const second = await park.getLiveData();

    expect(first.find(l => l.id === '999')).toBeUndefined();
    expect(second.find(l => l.id === '45')).toBeDefined();
    const orphanWarnings = warn.mock.calls.filter(c => String(c[0]).includes('999'));
    expect(orphanWarnings).toHaveLength(1);
  });

  test('reports orphaned wait times as one summarised line, and names each locale once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const waitTimes = Array.from({length: 12}, (_, i) => ({id: `90${i}`, time: 0, status: 'open'}));

    await stubbedPark(FEEDS, waitTimes).getLiveData();

    const orphanWarnings = warn.mock.calls.filter(c => String(c[0]).includes('not published'));
    expect(orphanWarnings).toHaveLength(1);
    const message = String(orphanWarnings[0][0]);
    expect(message).toContain('12 wait time id(s)');
    expect(message).toContain('(+2 more)');
    expect(message).toContain('[nl, fr, en]'); // primary locale listed once, not twice
  });
});

describe('WalibiBelgium — shipped locale', () => {
  test('is configured on the locale that lists VAMPIRE', () => {
    // `nl` and `en` both omit VAMPIRE; only `fr` lists it, and Wavre is
    // francophone. Reverting this to `nl` silently drops the ride again.
    expect(new WalibiBelgium().culture).toBe('fr');
  });
});

/**
 * The merge only works if each locale is actually requested from its own URL.
 * Stubbing fetchAttractions cannot see that, so drive the real @http method
 * against a local server that serves a different feed per path.
 */
describe('WalibiBase.fetchAttractions — per-locale URLs', () => {
  let server: ReturnType<typeof createServer>;
  let baseURL: string;
  const requestedPaths: string[] = [];

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      requestedPaths.push(req.url || '');
      const locale = (req.url || '').split('/')[3];
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify(FEEDS[locale] ?? []));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  });

  beforeEach(() => {
    CacheLib.clear();
    requestedPaths.length = 0;
  });
  afterEach(() => CacheLib.clear());

  test('requests each locale under its own path, so a fallback returns that locale', async () => {
    const park = new WalibiBelgium();
    park.baseURL = baseURL;
    park.culture = 'nl';
    park.mergeCultures = ['nl', 'fr', 'en'];

    const attractions = await park.getAttractions();

    expect(requestedPaths).toContain('/api/wbe/nl/attractions.v1.json');
    expect(requestedPaths).toContain('/api/wbe/fr/attractions.v1.json');
    expect(requestedPaths).toContain('/api/wbe/en/attractions.v1.json');
    // VAMPIRE exists only in the `fr` feed: it can only be here if the fallback
    // request actually carried its own culture.
    expect(attractions.find(a => a.waitingTimeName === '34')?.title).toBe('VAMPIRE');
    expect(attractions.find(a => a.waitingTimeName === '9')?.title).toBe('FLASH-BACK');
  });
});

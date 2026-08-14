import {describe, test, expect, beforeEach, afterEach, vi} from 'vitest';
import {WalibiBelgium} from '../walibi.js';
import {CacheLib} from '../../../cache.js';
import type {HTTPObj} from '../../../http.js';

/**
 * The CMS serves one attractions feed per locale and those locales drift.
 * Walibi Belgium is configured on `nl`, whose feed silently omits VAMPIRE
 * (waitingTimeName 34) — as does `en`. Only `fr` lists it. Because the ride
 * was missing from the configured feed, buildEntityList never emitted an
 * entity for it and buildLiveData dropped its wait time on the floor, even
 * though waitingtimes.v1.json reported it open the whole time.
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

/** FLASH-BACK — listed in both locales, spelled differently in each. */
const FLASHBACK_NL = {title: 'FLASH-BACK', waitingTimeName: '9', path: '/nl/flash-back'};
const FLASHBACK_FR = {title: 'FLASH BACK', waitingTimeName: '9', path: '/fr/flash-back'};

const FEEDS: Record<string, any[]> = {
  nl: [KONDAA, FLASHBACK_NL],
  fr: [{...KONDAA, title: 'KONDAA'}, FLASHBACK_FR, VAMPIRE],
  en: [KONDAA, FLASHBACK_NL],
};

/**
 * A park whose per-locale attraction feeds come from `feeds`; a locale mapped
 * to `null` throws, standing in for a 404 or a malformed response.
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
    if (feed === null) throw new Error(`no such locale: ${culture}`);
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

  test('a locale that fails to load is skipped without sinking the merge', async () => {
    const entities = await stubbedPark({...FEEDS, en: null}).getEntities();

    expect(entities.find(e => e.id === '45')).toBeDefined();
    expect(entities.find(e => e.id === '34')).toBeDefined();
  });

  test('a wait time with no attraction in any locale is skipped, and warned about once', async () => {
    const warn = vi.spyOn(console, 'log').mockImplementation(() => {});
    const park = stubbedPark(FEEDS, [{id: '45', time: 1200, status: 'open'}, {id: '999', time: 300, status: 'open'}]);

    const first = await park.getLiveData();
    const second = await park.getLiveData();

    expect(first.find(l => l.id === '999')).toBeUndefined();
    expect(second.find(l => l.id === '45')).toBeDefined();
    const orphanWarnings = warn.mock.calls.filter(c => String(c[0]).includes('999'));
    expect(orphanWarnings).toHaveLength(1);
  });
});

/**
 * Replay of Mid-America Parks as the site served it on 2026-10-17, with
 * Hurricane Harbor closed for the year: water-park listing 404, every water
 * ride page 404, the `hurricane-harbor` category present with no pages, and
 * a master listing of theme-park rides only.
 *
 * Before the off-season roster this shape rejected every entity build, and
 * with it the destination's live data, while the theme park was open.
 */
import {describe, test, expect} from 'vitest';
import type {EnchantedParks, WpPage} from '../enchantedparks.js';
import fixture from './fixtures/midamerica-offseason-2026-10-17.json' with {type: 'json'};

type Ride = [slug: string, name: string];
const card = ([slug, name]: Ride) => `
<article class="item parallax-banner">
  <a href="https://example.test/rides-and-experiences/attractions/${slug}/"><img class="parallax" src="x.webp" alt="${name}" /></a>
  <div class="container"><h3>${name}</h3></div>
  <div class="more"><a class="cta" href="https://example.test/rides-and-experiences/attractions/${slug}/">Details</a></div>
</article>`;
const listing = (rides: Ride[]) =>
  `<!doctype html><html><body><div class="col span6">${rides.map(card).join('</div><div class="col span6">')}</div></body></html>`;
const EMPTY = listing([]);
const MASTER = fixture.masterListing as Ride[];
const HH = fixture.waterParkRides as Ride[];
const wpPage = ([slug]: Ride): WpPage => ({slug, link: `https://example.test/rides-and-experiences/attractions/${slug}/`});

let run = 0;
async function replay(opts: {master: Ride[]; categoryPages: WpPage[]; roster?: string[] | null}) {
  const mod = await import('../midamericaparks.js');
  const ParkClass = Object.values(mod)[0] as new () => EnchantedParks;
  const park = new ParkClass() as any;
  const prefix = `replay-offseason-${Date.now()}-${run++}`;
  park.getCacheKeyPrefix = () => prefix;
  if (opts.roster !== undefined) park.waterPark.knownRides = opts.roster ?? undefined;
  const pages: Record<string, string> = {'attractions': listing(opts.master), 'dining': EMPTY, 'live-entertainment': EMPTY};
  park.fetchAttractionsPage = async (path: string) => {
    const body = pages[path];
    if (body === undefined) throw new Error(`GET https://example.test/rides-and-experiences/${path}/: HTTP request not OK: 404 Not Found`);
    return {text: async () => body};
  };
  park.fetchWpCategory = async () => ({json: async () => fixture.category});
  park.fetchWpCategoryPages = async () => ({
    json: async () => opts.categoryPages,
    response: {headers: new Headers({'x-wp-totalpages': String(opts.categoryPages.length ? 1 : fixture.categoryTotalPages)})},
  });
  const warn = console.warn;
  console.warn = () => {};
  try {
    return await park.buildEntityList() as any[];
  } finally {
    console.warn = warn;
  }
}
const ridesUnder = (entities: any[], parkId: string) =>
  entities.filter(e => e.entityType === 'ATTRACTION' && e.parentId === parkId).map(e => e.id.split('_').pop()).sort();

describe('Mid-America Parks off-season replay (2026-10-17)', () => {
  test('the fixture is the off-season shape: no water ride on the master listing', () => {
    const master = new Set(MASTER.map(r => r[0]));
    expect(MASTER).toHaveLength(33);
    expect(HH.filter(r => master.has(r[0]))).toEqual([]);
    expect(fixture.categoryPages).toEqual([]);
  });

  test('builds all 33 theme-park rides and no water-park ride', async () => {
    const entities = await replay({master: MASTER, categoryPages: []});
    expect(ridesUnder(entities, 'enchantedparks_park_MAP')).toEqual(MASTER.map(r => r[0]).sort());
    expect(ridesUnder(entities, 'enchantedparks_park_HH')).toEqual([]);
  });

  test('the shipped roster is the water park\'s last published rides', async () => {
    const mod = await import('../midamericaparks.js');
    const ParkClass = Object.values(mod)[0] as new () => EnchantedParks;
    expect([...(new ParkClass() as any).waterPark.knownRides].sort()).toEqual(HH.map(r => r[0]).sort());
  });

  test('without the roster the same day rejects, which is the outage this replays', async () => {
    await expect(replay({master: MASTER, categoryPages: [], roster: null})).rejects.toThrow(/no ride pages tagged/);
  });

  test('next season, rides republished and tagged with the listing still 404: each lands under its own park', async () => {
    const entities = await replay({master: [...MASTER, ...HH], categoryPages: HH.map(wpPage)});
    expect(ridesUnder(entities, 'enchantedparks_park_HH')).toEqual(HH.map(r => r[0]).sort());
    expect(ridesUnder(entities, 'enchantedparks_park_MAP')).toEqual(MASTER.map(r => r[0]).sort());
  });

  test('next season, rides republished but not yet tagged: the roster still keeps them off the theme park', async () => {
    const entities = await replay({master: [...MASTER, ...HH], categoryPages: []});
    expect(ridesUnder(entities, 'enchantedparks_park_HH')).toEqual(HH.map(r => r[0]).sort());
    expect(ridesUnder(entities, 'enchantedparks_park_MAP')).toEqual(MASTER.map(r => r[0]).sort());
  });
});

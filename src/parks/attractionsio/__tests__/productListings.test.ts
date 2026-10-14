/**
 * Records the Merlin app files under a published category that are not places:
 *
 *   - Alton Towers lists its paid queue-skip packages as items of its
 *     "Attractions" categories ("Fastrack Packages" under Thrills, "CBeebies
 *     Land Fastrack" under CBeebies Land, "Thrills Combi Fastrack"). They are
 *     off the map (VisibleOnMap and WayfindingEnabled false) and carry only
 *     "Buy ..." product call-to-actions. The rides they sell carry the same
 *     call-to-actions, and so does every ride, so no field on the record
 *     separates a package from a ride except its name.
 *
 *   - LEGOLAND Florida's Halloween season keeps a "Dining" category under the
 *     "Brick or Treat" event category. Its items are the season's menu
 *     specials ("Hex Wrap ... Served at Kick'n Chicken Co."), each sold at an
 *     outlet that is already a restaurant of its own.
 *
 * Near-misses are kept on purpose: rides that merely sell a package, food
 * outlets whose names contain "Express", and hotel restaurants nested under a
 * non-seasonal parent.
 *
 * The raw network methods are stubbed with payload-shaped fixtures; the real
 * subclasses build the entity list.
 */

import {describe, test, expect, beforeEach} from 'vitest';
import {
  AltonTowers,
  LegolandCalifornia,
  LegolandOrlando,
  AttractionsIOV1,
} from '../attractionsiov1.js';
import {CacheLib} from '../../../cache.js';

beforeEach(() => {
  // getCategoryIDs is @cache-decorated and keyed per destination.
  CacheLib.clearAll();
});

function stub(park: any, records: any, live: any = {entities: {Item: {records: []}}}): any {
  park.getPOIData = async () => records;
  park.fetchLiveData = async () => ({json: async () => live});
  return park;
}

// ---------------------------------------------------------------------------
// Alton Towers
// ---------------------------------------------------------------------------

// Shapes copied from the live asset pack: the three package records, the
// rides they sit beside, a ride that sells a package, and two near-misses.
const FASTRACK_COUNTER = '52.986806148209,-1.8841128253784';

function altonRecords(): any {
  return {
    Resort: [{_id: 49, Name: {'en-GB': 'Alton Towers Resort'}}],
    Category: [
      {_id: 498, Name: 'Attractions'},
      {_id: 506, Name: 'Laughs & Frights', Parent: 498},
      {_id: 507, Name: 'Thrills', Parent: 498},
      {_id: 508, Name: 'CBeebies Land', Parent: 498},
      {_id: 502, Name: 'Facilities'},
      {_id: 513, Name: 'Sales and Information', Parent: 502},
      {_id: 520, Name: 'Food & Drink'},
      {_id: 521, Name: 'Fast Food', Parent: 520},
    ],
    Item: [
      // The three packages Alton publishes as attractions.
      {_id: 47752, Name: 'Fastrack Packages', Summary: 'Reduce your waiting time and enjoy the most popular attractions!',
        Location: FASTRACK_COUNTER, VisibleOnMap: false, WayfindingEnabled: false, Category: 507,
        entityIds: [], Classifications: [],
        CallToActions: ['bbc25605-ebb4-4c0c-9d64-3377c3774b5b', 'dfd684eb-9a9a-4257-8cf7-ef515694e747']},
      {_id: 43139, Name: 'Thrills Combi Fastrack', Location: FASTRACK_COUNTER,
        VisibleOnMap: false, WayfindingEnabled: false, Category: 507, entityIds: [], Classifications: [],
        CallToActions: ['45e3ddd9-1da6-40b1-a1af-7b0a56b64d90']},
      {_id: 47829, Name: 'CBeebies Land Fastrack', AbbreviatedName: 'CBeebies Fastrack', Location: FASTRACK_COUNTER,
        VisibleOnMap: false, WayfindingEnabled: false, Category: 508, entityIds: [], Classifications: [],
        RelatedItems: [4205, 4206], CallToActions: ['8979aadc-5a98-4f17-87bb-4c7942452d64']},
      // Filed outside every published category already: stays unpublished.
      {_id: 50979, Name: 'Fastrack', Location: FASTRACK_COUNTER, VisibleOnMap: false, WayfindingEnabled: false,
        Category: 513, entityIds: [], Classifications: []},
      // Real rides. Spinball Whizzer sells three Fastrack products and its
      // summary says so; neither may cost it its place.
      {_id: 4194, Name: 'Spinball Whizzer', Summary: 'Skip the queue with Fastrack.', Location: '52.988940711567,-1.8945573472824',
        VisibleOnMap: true, WayfindingEnabled: true, Category: 506, entityIds: [], Classifications: [157, 119],
        MinimumHeightRequirement: 1.2, CallToActions: ['3517005a-3000-436e-afd4-4439f83bb2d1']},
      {_id: 4188, Name: 'Nemesis Reborn', Location: '52.986953084469,-1.8827529454079',
        VisibleOnMap: true, WayfindingEnabled: true, Category: 507, entityIds: [], Classifications: [160, 119],
        CallToActions: ['3517005a-3000-436e-afd4-4439f83bb2d1']},
      {_id: 4205, Name: 'Octonauts Rollercoaster Adventure', Location: '52.989321757166,-1.8945948982087',
        VisibleOnMap: true, WayfindingEnabled: true, Category: 508, entityIds: [], Classifications: [151, 120]},
      // A food outlet whose name carries a different "Express".
      {_id: 4276, Name: 'Eastern Express - Mutiny Bay', Location: '52.9890,-1.8895',
        VisibleOnMap: true, WayfindingEnabled: true, Category: 521, entityIds: [], Classifications: [156]},
    ],
  };
}

describe('Alton Towers: Fastrack packages are not attractions', () => {
  test('the three packages are not published, whichever category they are filed under', async () => {
    const entities = await stub(new AltonTowers(), altonRecords()).getEntities();
    const ids = entities.map((e: any) => e.id);
    for (const id of ['47752', '43139', '47829', '50979']) {
      expect(ids).not.toContain(id);
    }
    expect(entities.some((e: any) => /fastrack/i.test(e.name))).toBe(false);
  });

  test('rides that sell a package keep their place, type and height tag', async () => {
    const entities = await stub(new AltonTowers(), altonRecords()).getEntities();
    const whizzer = entities.find((e: any) => e.id === '4194');
    expect(whizzer).toMatchObject({name: 'Spinball Whizzer', entityType: 'ATTRACTION'});
    expect(whizzer.tags?.length).toBeGreaterThan(0);
    for (const id of ['4188', '4205']) {
      expect(entities.find((e: any) => e.id === id)?.entityType).toBe('ATTRACTION');
    }
  });

  test('a food outlet named "Express" is still a restaurant', async () => {
    const entities = await stub(new AltonTowers(), altonRecords()).getEntities();
    expect(entities.find((e: any) => e.id === '4276')).toMatchObject({
      name: 'Eastern Express - Mutiny Bay',
      entityType: 'RESTAURANT',
    });
  });

  test('every other entity survives: the only difference is the three packages', async () => {
    const entities = await stub(new AltonTowers(), altonRecords()).getEntities();
    expect(entities.map((e: any) => e.id).sort()).toEqual(
      ['4188', '4194', '4205', '4276', 'altontowers', 'altontowersresort'].sort(),
    );
  });

  test('live data is emitted for the rides and for none of the packages', async () => {
    const live = {
      entities: {
        Item: {
          records: [
            {_id: 4194, IsOperational: true, QueueTime: 1200},
            {_id: 47752, IsOperational: true, QueueTime: 0},
            {_id: 43139, IsOperational: false},
          ],
        },
      },
    };
    const rows = await stub(new AltonTowers(), altonRecords(), live).getLiveData();
    expect(rows.map((r: any) => r.id)).toEqual(['4194']);
  });

  test('other Merlin parks are untouched: the same record is still published elsewhere', async () => {
    const park = stub(new LegolandCalifornia(), altonRecords());
    const entities = await park.getEntities();
    expect(entities.find((e: any) => e.id === '47752')?.entityType).toBe('ATTRACTION');
  });
});

// ---------------------------------------------------------------------------
// LEGOLAND Florida
// ---------------------------------------------------------------------------

const BOT_SERVED_AT = 'Try this special Halloween treat only available throughout Brick or Treat season!';

function floridaRecords(): any {
  const special = (id: number, name: string, served: string) => ({
    _id: id, Name: name, Summary: `${BOT_SERVED_AT}\n\nServed at ${served}.`,
    VisibleOnMap: true, WayfindingEnabled: true, Category: 5823, entityIds: [], Classifications: [],
  });
  return {
    Resort: [{_id: 61, Name: {'en-US': 'LEGOLAND Florida'}}],
    Category: [
      {_id: 575, Name: {'en-US': 'Dining'}},
      {_id: 842, Name: {'en-US': 'American'}, Parent: 575},
      {_id: 578, Name: {'en-US': 'Rides'}},
      {_id: 579, Name: {'en-US': 'Shows'}},
      {_id: 657, Name: {'en-US': 'Brick or Treat'}},
      {_id: 4914, Name: {'en-US': 'Candy Stations'}, Parent: 657},
      {_id: 4917, Name: {'en-US': 'Show'}, Parent: 657},
      {_id: 5823, Name: {'en-US': 'Dining'}, Parent: 657},
      // A hotel's own dining category, nested under a non-seasonal parent.
      {_id: 700, Name: {'en-US': 'Hotel'}},
      {_id: 701, Name: {'en-US': 'Dining'}, Parent: 700},
    ],
    Item: [
      // The seven menu specials from the Halloween season.
      special(52588, 'Hex Wrap', "Kick'n Chicken Co."),
      special(52589, 'Green Machine', 'the Burger Kitchen'),
      special(52590, 'Pumpkin Pie Apple Fries ', "Granny's Apple Fries"),
      special(52591, 'Monster Loaded Fries ', 'Loop & Kernel'),
      special(52592, 'Spider Slush', 'LEGOLAND® Coffee Co.'),
      special(52593, 'Franken-slice  ', "Pepper & Roni's Pizza Stop"),
      special(52594, 'Broomstick Berry Shake ', 'Kingdom Cones'),
      // Real outlets: top-level Dining and a Dining sub-category.
      {_id: 11550, Name: 'Shipwreck Restaurant', Category: 575, entityIds: [], Classifications: [279, 632]},
      {_id: 5111, Name: "Kick'n Chicken Co.", Category: 842, entityIds: [], Classifications: [317]},
      // Dining nested under a hotel, not a season: a real restaurant.
      {_id: 5505, Name: 'Bricks Family Restaurant (LEGOLAND Hotel)', Category: 701, entityIds: [], Classifications: [280]},
      // The season's other content stays: a show with a schedule, and an
      // item in a category no list names.
      {_id: 25366, Name: 'Zombie Cheer Crew', Category: 4917,
        ShowTimes: JSON.stringify({type: 'period', offset_date: '2020-01-01 13:00:00', period_length: {day: 1}})},
      {_id: 25363, Name: 'Candy Station - The Beginning', Category: 4914},
      // A ride.
      {_id: 6307, Name: 'The Dragon', Category: 578},
    ],
  };
}

const MENU_IDS = ['52588', '52589', '52590', '52591', '52592', '52593', '52594'];

describe('LEGOLAND Florida: Brick or Treat menu specials are not restaurants', () => {
  test('none of the seven specials is published', async () => {
    const entities = await stub(new LegolandOrlando(), floridaRecords()).getEntities();
    const ids = entities.map((e: any) => e.id);
    for (const id of MENU_IDS) expect(ids).not.toContain(id);
  });

  test('real outlets stay RESTAURANTs, including a Dining category nested under a hotel', async () => {
    const entities = await stub(new LegolandOrlando(), floridaRecords()).getEntities();
    for (const id of ['11550', '5111', '5505']) {
      expect(entities.find((e: any) => e.id === id)?.entityType).toBe('RESTAURANT');
    }
  });

  test('the season keeps its shows and rides', async () => {
    const entities = await stub(new LegolandOrlando(), floridaRecords()).getEntities();
    expect(entities.find((e: any) => e.id === '25366')?.entityType).toBe('SHOW');
    expect(entities.find((e: any) => e.id === '6307')?.entityType).toBe('ATTRACTION');
    expect(entities.find((e: any) => e.id === '25363')).toBeUndefined(); // unlisted category, no schedule
  });

  test('no live data is emitted for a special even when the feed carries a row', async () => {
    const live = {
      entities: {
        Item: {
          records: [
            {_id: 52588, IsOpen: true},
            {_id: 5111, IsOpen: true},
          ],
        },
      },
    };
    const rows = await stub(new LegolandOrlando(), floridaRecords(), live).getLiveData();
    const ids = rows.map((r: any) => r.id);
    expect(ids).not.toContain('52588');
    expect(ids).toContain('5111'); // the outlet it is sold at
    expect(ids).toContain('25366'); // the season's show, with its showtimes
  });

  test('only Florida opts in: the same records elsewhere keep every restaurant', async () => {
    const entities = await stub(new LegolandCalifornia(), floridaRecords()).getEntities();
    const restaurants = entities.filter((e: any) => e.entityType === 'RESTAURANT').map((e: any) => e.id);
    for (const id of MENU_IDS) expect(restaurants).toContain(id);
  });
});

describe('the hooks are opt-in on the base class', () => {
  class Probe extends AttractionsIOV1 {
    constructor(records: any) {
      super({config: {destinationId: 'probe-resort', parkId: 'probe-park', timezone: 'America/New_York'}});
      (this as any).getPOIData = async () => records;
    }
  }

  test('a park that overrides nothing publishes a package listing', async () => {
    const entities = await new Probe(altonRecords()).getEntities();
    expect(entities.some((e: any) => e.id === '47752')).toBe(true);
  });

  test('a park that overrides nothing publishes a seasonal menu item', async () => {
    const entities = await new Probe(floridaRecords()).getEntities();
    expect(entities.some((e: any) => e.id === '52588')).toBe(true);
  });
});

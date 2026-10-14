/**
 * Records the Merlin app files under a published category that are not places:
 *
 *   - Alton Towers lists its paid queue-skip packages as items of its
 *     "Attractions" categories ("Fastrack Packages" under Thrills, "CBeebies
 *     Land Fastrack" under CBeebies Land, "Thrills Combi Fastrack"). They are
 *     off the map (VisibleOnMap and WayfindingEnabled false), have no
 *     classifications and carry only "Buy ..." product call-to-actions. The
 *     rides they sell carry the same call-to-actions. At Alton that
 *     combination of flags matches the three packages and nothing else, but
 *     real rides in other Merlin parks share it (LEGOLAND Billund's pirate
 *     boats, Djurs Sommerland's fireworks show), so it is no rule for the
 *     shared base class. The name the park gives the product is.
 *
 *   - LEGOLAND Florida's Halloween season keeps a "Dining" category under the
 *     "Brick or Treat" event category. Its items are the season's menu
 *     specials ("Hex Wrap ... Served at Kick'n Chicken Co."), each sold at an
 *     outlet that is already a restaurant of its own.
 *
 *   - Thorpe Park files two information pages ("Allergies & Intolerances",
 *     "Food & Drink Information") and three kiosks that only the queue of a ride
 *     can reach ("Q-line Kiosk (Colossus)", "... (The Swarm)", "... (SAW - The
 *     Ride)") among its restaurants. The app will not route a guest to any of
 *     them (WayfindingEnabled false); every real venue it lists can be routed to.
 *
 * Near-misses are kept on purpose: rides that merely sell a package, food
 * outlets whose names contain "Express", hotel restaurants nested under a
 * non-seasonal parent, and the Q-line kiosks the park does route to.
 *
 * The raw network methods are stubbed with payload-shaped fixtures; the real
 * subclasses build the entity list.
 */

import {describe, test, expect, beforeEach, afterEach, vi} from 'vitest';
import {
  AltonTowers,
  LegolandCalifornia,
  LegolandOrlando,
  ThorpePark,
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
      // A seasonal category no list names: only a scheduled item is picked up.
      {_id: 530, Name: 'Scarefest'},
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
      // Boundary cases (made up for this test): "fast" inside a longer word,
      // and Fastrack as the stem of one.
      {_id: 9001, Name: 'Breakfast Buffet', Category: 521, entityIds: [], Classifications: []},
      {_id: 9002, Name: 'Fastracker Karts', Category: 507, entityIds: [], Classifications: [119]},
      // A scheduled item in the unlisted category is a SHOW; one of the
      // packages listed there with a schedule must not be.
      {_id: 9003, Name: 'Scarefest Maze Show', Category: 530, ShowTimes: POINT_SHOW},
      {_id: 9004, Name: 'Scarefest Fastrack', Category: 530, ShowTimes: POINT_SHOW,
        VisibleOnMap: false, WayfindingEnabled: false, Classifications: []},
    ],
  };
}

const POINT_SHOW = JSON.stringify({type: 'period', offset_date: '2020-01-01 13:00:00', period_length: {day: 1}});

describe('Alton Towers: Fastrack packages are not attractions', () => {
  test('the three packages are not published, whichever category they are filed under', async () => {
    const entities = await stub(new AltonTowers(), altonRecords()).getEntities();
    const ids = entities.map((e: any) => e.id);
    for (const id of ['47752', '43139', '47829', '50979', '9004']) {
      expect(ids).not.toContain(id);
    }
    expect(entities.some((e: any) => /\bfastrack\b/i.test(e.name))).toBe(false);
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
      ['4188', '4194', '4205', '4276', '9001', '9002', '9003', 'altontowers', 'altontowersresort'].sort(),
    );
  });

  test('a package in an unlisted category is not rescued by its schedule, a real show there is', async () => {
    const entities = await stub(new AltonTowers(), altonRecords()).getEntities();
    expect(entities.find((e: any) => e.id === '9003')).toMatchObject({name: 'Scarefest Maze Show', entityType: 'SHOW'});
    expect(entities.find((e: any) => e.id === '9004')).toBeUndefined();
  });

  test('the name is matched as a whole word, in any case', async () => {
    const park: any = new AltonTowers();
    const listed = (name: any) => park.isPaidProductListing({_id: 1, Name: name});
    for (const name of ['Fastrack', 'fastrack packages', 'FASTRACK', 'Summer Passholder Fastrack', 'Buy Fastrack!',
      {'en-GB': 'Thrills Combi Fastrack'}]) {
      expect(listed(name)).toBe(true);
    }
    for (const name of ['Breakfast Buffet', 'Fastracker Karts', 'Unfastrack', 'Fast Food Court', 'Fast Track Racers',
      'Spinball Whizzer', '', undefined]) {
      expect(listed(name)).toBe(false);
    }
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
    const ids = (await stub(new AltonTowers(), altonRecords(), live).getLiveData()).map((r: any) => r.id);
    expect(ids).toContain('4194');
    expect(ids).not.toContain('47752');
    expect(ids).not.toContain('43139');
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

const BOT_TEASER = 'Try this special Halloween treat only available throughout Brick or Treat season!';

// Names and outlets are the ones in the live pack; descriptions are shortened.
function floridaRecords(): any {
  const special = (id: number, name: string, served: string) => ({
    _id: id, Name: name, Summary: `${BOT_TEASER}\n\nServed at ${served}.`,
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
      {_id: 4916, Name: {'en-US': 'Meet & Greet'}, Parent: 657},
      {_id: 4917, Name: {'en-US': 'Show'}, Parent: 657},
      {_id: 5823, Name: {'en-US': 'Dining'}, Parent: 657},
      // A hotel's own dining category, nested under a non-seasonal parent.
      {_id: 700, Name: {'en-US': 'Hotel'}},
      {_id: 701, Name: {'en-US': 'Dining'}, Parent: 700},
    ],
    Item: [
      // The seven menu specials from the Halloween season.
      special(52588, 'Hex Wrap', "Kick'n Chicken Co."),
      special(52589, 'Green Machine', 'Firehouse Ice Cream'),
      special(52590, 'Pumpkin Pie Apple Fries ', "Granny's Apple Fries"),
      special(52591, 'Monster Loaded Fries ', "Dragon's Den"),
      special(52592, 'Spider Slush', 'LEGOLAND® Coffee Co.'),
      special(52593, 'Franken-slice  ', "Brickolini's Pizza and Pasta"),
      special(52594, 'Broomstick Berry Shake ', 'Kingdom Cones'),
      // Real outlets: top-level Dining and a Dining sub-category.
      {_id: 11550, Name: 'Shipwreck Restaurant', Category: 575, entityIds: [], Classifications: [279, 632]},
      {_id: 5111, Name: "Kick'n Chicken Co.", Category: 842, entityIds: [], Classifications: [317]},
      // Dining nested under a hotel, not a season: a real restaurant.
      {_id: 5505, Name: 'Bricks Family Restaurant (LEGOLAND Hotel)', Category: 701, entityIds: [], Classifications: [280]},
      // The season's other content stays: a show with a schedule, and an
      // item in a category no list names.
      {_id: 25366, Name: 'Zombie Cheer Crew', Category: 4917, ShowTimes: POINT_SHOW},
      {_id: 25363, Name: 'Candy Station - The Beginning', Category: 4914},
      // A scheduled meet & greet in a season category no list names: a SHOW by
      // the fallback, though it sits below the same parent as the specials.
      {_id: 7003, Name: 'Meet LEGO® Mummy', Category: 4916, ShowTimes: POINT_SHOW},
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

  test('a scheduled meet & greet below the same parent is still a SHOW', async () => {
    const entities = await stub(new LegolandOrlando(), floridaRecords()).getEntities();
    expect(entities.find((e: any) => e.id === '7003')).toMatchObject({
      name: 'Meet LEGO® Mummy',
      entityType: 'SHOW',
    });
  });

  test('a special that carries a schedule is not promoted to a SHOW by the fallback', async () => {
    const records = floridaRecords();
    records.Item.find((item: any) => item._id === 52588).ShowTimes = POINT_SHOW;
    const entities = await stub(new LegolandOrlando(), records).getEntities();
    expect(entities.find((e: any) => e.id === '52588')).toBeUndefined();
    // The same schedule on a real show still makes it a SHOW.
    expect(entities.find((e: any) => e.id === '25366')?.entityType).toBe('SHOW');
  });

  test('only Florida opts in: the same records elsewhere keep every restaurant', async () => {
    const entities = await stub(new LegolandCalifornia(), floridaRecords()).getEntities();
    const restaurants = entities.filter((e: any) => e.entityType === 'RESTAURANT').map((e: any) => e.id);
    for (const id of MENU_IDS) expect(restaurants).toContain(id);
  });
});

// ---------------------------------------------------------------------------
// Thorpe Park
// ---------------------------------------------------------------------------

// Shapes copied from the live asset pack: the two information pages and the
// three queue-only kiosks, beside the kiosks and restaurants the park does
// route guests to. Locations and call-to-actions are shortened.
function thorpeRecords(): any {
  const SPOT = '51.405195,-0.513011'; // the pin both information pages share
  return {
    Resort: [{_id: 3, Name: 'Thorpe Park Resort'}],
    Category: [
      {_id: 459, Name: 'Rides & Shows'},
      {_id: 920, Name: 'Thrill Rides', Parent: 459},
      {_id: 460, Name: 'Food & Drink'},
      {_id: 1702, Name: 'Drinks & Snacks', Parent: 460},
      {_id: 925, Name: 'Restaurant'},
      {_id: 926, Name: 'Fast Food'},
    ],
    Item: [
      // The two information pages: off the map, no way to route to them.
      {_id: 32088, Name: 'Allergies & Intolerances', Location: SPOT, Category: 460,
        VisibleOnMap: false, WayfindingEnabled: false, entityIds: [], Classifications: []},
      {_id: 36913, Name: 'Food & Drink Information', Location: SPOT, Category: 460,
        VisibleOnMap: false, WayfindingEnabled: false, entityIds: [], Classifications: [60]},
      // The three kiosks inside a ride's queue: drawn on the map, not routable.
      {_id: 3885, Name: 'Q-line Kiosk (Colossus)', Summary: 'This kiosk can only be accessed by those in the Q-line for Colossus.',
        Location: '51.403289202108,-0.51280192527008', Category: 1702,
        VisibleOnMap: true, WayfindingEnabled: false, entityIds: [], Classifications: [61]},
      {_id: 3891, Name: 'Q-line Kiosk (The Swarm)', Location: '51.405589870052,-0.51553509625626', Category: 1702,
        VisibleOnMap: true, WayfindingEnabled: false, entityIds: [], Classifications: [61]},
      {_id: 3897, Name: 'Q-line Kiosk (SAW - The Ride)', Location: '51.4023571895,-0.51166869196129', Category: 1702,
        VisibleOnMap: true, WayfindingEnabled: false, entityIds: [], Classifications: [61]},
      // Near-miss: two more kiosks with the same name pattern that the park
      // does route to, one of them at the exit of a ride.
      {_id: 3849, Name: 'Q-line Kiosk (Nemesis Inferno)', Location: '51.403566961618,-0.51619626077843', Category: 1702,
        VisibleOnMap: true, WayfindingEnabled: true, entityIds: [], Classifications: [61]},
      {_id: 47032, Name: 'Q-line Kiosk (Fearless Fuel)', Location: '51.402240059103,-0.51339992030715', Category: 1702,
        VisibleOnMap: true, WayfindingEnabled: true, entityIds: [], Classifications: [61]},
      // Real venues, in the three restaurant categories the park uses.
      {_id: 10816, Name: 'Vibes Bar & Kitchen', Location: '51.404980831766,-0.51225475463105', Category: 460,
        VisibleOnMap: true, WayfindingEnabled: true, entityIds: [], Classifications: [60]},
      {_id: 3876, Name: 'KFC', Location: '51.4044,-0.5121', Category: 925,
        VisibleOnMap: true, WayfindingEnabled: true, entityIds: [], Classifications: [60]},
      {_id: 7034, Name: 'Boulevard Bites', Location: '51.4046,-0.5124', Category: 926,
        VisibleOnMap: true, WayfindingEnabled: true, entityIds: [], Classifications: [60]},
      // Made up for this test. A venue with "Information" in its name is kept:
      // the name is not the signal.
      {_id: 9101, Name: 'Information Point Cafe', Location: '51.4045,-0.5122', Category: 460,
        VisibleOnMap: true, WayfindingEnabled: true, entityIds: [], Classifications: []},
      // Made up for this test. A feed that does not carry the flags at all
      // (older packs) keeps its restaurants.
      {_id: 9102, Name: 'Flagless Grill', Location: '51.4047,-0.5125', Category: 460, entityIds: [], Classifications: []},
      // Made up for this test. A ride the app cannot route to stays a ride: the
      // rule belongs to the restaurant lists alone.
      {_id: 9103, Name: 'Pinless Ride', Location: '51.4033,-0.5130', Category: 920,
        VisibleOnMap: false, WayfindingEnabled: false, entityIds: [], Classifications: [119]},
    ],
  };
}

const THORPE_NOT_VENUES = ['32088', '36913', '3885', '3891', '3897'];

describe('Thorpe Park: information pages and queue-only kiosks are not restaurants', () => {
  test('the two pages and the three queue-only kiosks are not published', async () => {
    const entities = await stub(new ThorpePark(), thorpeRecords()).getEntities();
    const ids = entities.map((e: any) => e.id);
    for (const id of THORPE_NOT_VENUES) expect(ids).not.toContain(id);
    expect(entities.some((e: any) => /intolerances|food & drink information/i.test(e.name))).toBe(false);
  });

  test('every other entity survives: the only difference is those five records', async () => {
    const entities = await stub(new ThorpePark(), thorpeRecords()).getEntities();
    expect(entities.map((e: any) => e.id).sort()).toEqual(
      ['10816', '3849', '3876', '47032', '7034', '9101', '9102', '9103', 'thorpepark', 'thorpeparkresort'].sort(),
    );
  });

  test('kiosks the park does route to keep their place, whatever their name says', async () => {
    const entities = await stub(new ThorpePark(), thorpeRecords()).getEntities();
    for (const [id, name] of [['3849', 'Q-line Kiosk (Nemesis Inferno)'], ['47032', 'Q-line Kiosk (Fearless Fuel)']]) {
      expect(entities.find((e: any) => e.id === id)).toMatchObject({name, entityType: 'RESTAURANT'});
    }
  });

  test('real venues stay RESTAURANTs, in each restaurant category, and the name is not the signal', async () => {
    const entities = await stub(new ThorpePark(), thorpeRecords()).getEntities();
    for (const id of ['10816', '3876', '7034', '9101']) {
      expect(entities.find((e: any) => e.id === id)?.entityType).toBe('RESTAURANT');
    }
  });

  test('a record without the flag is kept: only an explicit false counts', async () => {
    const entities = await stub(new ThorpePark(), thorpeRecords()).getEntities();
    expect(entities.find((e: any) => e.id === '9102')?.entityType).toBe('RESTAURANT');
    const park: any = new ThorpePark();
    const listed = (flag: any) => park.isNonVenueRestaurantListing({_id: 1, Name: 'x', WayfindingEnabled: flag});
    expect(listed(false)).toBe(true);
    for (const flag of [true, undefined, null, 0, '', 'false']) expect(listed(flag)).toBe(false);
  });

  test('a ride the app cannot route to is still an ATTRACTION', async () => {
    const entities = await stub(new ThorpePark(), thorpeRecords()).getEntities();
    expect(entities.find((e: any) => e.id === '9103')?.entityType).toBe('ATTRACTION');
  });

  test('a page or kiosk with a schedule is not promoted to a SHOW by the fallback', async () => {
    const records = thorpeRecords();
    for (const item of records.Item) {
      if (['3885', '32088'].includes(String(item._id))) item.ShowTimes = POINT_SHOW;
    }
    const entities = await stub(new ThorpePark(), records).getEntities();
    expect(entities.find((e: any) => e.id === '3885')).toBeUndefined();
    expect(entities.find((e: any) => e.id === '32088')).toBeUndefined();
  });

  describe('live data', () => {
    beforeEach(() => {
      vi.useFakeTimers({toFake: ['Date']});
      vi.setSystemTime(new Date('2026-10-14T12:00:00Z'));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    test('no row is emitted for a page or a queue-only kiosk even when the feed carries one', async () => {
      const live = {
        entities: {
          Item: {
            records: [
              {_id: 32088, IsOpen: true},
              {_id: 36913, IsOpen: true},
              {_id: 3885, IsOpen: true},
              {_id: 3897, IsOpen: false},
              {_id: 3849, IsOpen: true},
              {_id: 10816, IsOpen: false},
            ],
          },
        },
      };
      const rows = await stub(new ThorpePark(), thorpeRecords(), live).getLiveData();
      const ids = rows.map((r: any) => r.id);
      for (const id of THORPE_NOT_VENUES) expect(ids).not.toContain(id);
      expect(rows.find((r: any) => r.id === '3849')?.status).toBe('OPERATING');
      expect(rows.find((r: any) => r.id === '10816')?.status).toBe('CLOSED');
    });
  });

  test('only Thorpe opts in: the same records elsewhere keep every restaurant', async () => {
    const entities = await stub(new AltonTowers(), thorpeRecords()).getEntities();
    const restaurants = entities.filter((e: any) => e.entityType === 'RESTAURANT').map((e: any) => e.id);
    for (const id of THORPE_NOT_VENUES) expect(restaurants).toContain(id);
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

  test('a park that overrides nothing publishes an information page and a queue-only kiosk', async () => {
    const ids = (await new Probe(thorpeRecords()).getEntities()).map((e: any) => e.id);
    for (const id of THORPE_NOT_VENUES) expect(ids).toContain(id);
  });
});

// ---------------------------------------------------------------------------
// How the seasonal parent is found
// ---------------------------------------------------------------------------

// One Dining category under a parent of the given name, holding one item.
function underParent(parentName: string, extraCategories: any[] = []): any {
  return {
    Resort: [{_id: 61, Name: {'en-US': 'LEGOLAND Florida'}}],
    Category: [
      {_id: 575, Name: {'en-US': 'Dining'}},
      {_id: 900, Name: {'en-US': parentName}},
      {_id: 901, Name: {'en-US': 'Dining'}, Parent: 900},
      ...extraCategories,
    ],
    Item: [
      {_id: 11550, Name: 'Shipwreck Restaurant', Category: 575},
      {_id: 53000, Name: 'Under The Parent', Category: 901},
    ],
  };
}

const published = async (park: any, records: any) =>
  (await stub(park, records).getEntities()).map((e: any) => e.id);

describe('LEGOLAND Florida: finding the seasonal parent', () => {
  test('a Dining category two levels below the parent is a list of specials too', async () => {
    const records = underParent('Brick or Treat');
    records.Category.push(
      {_id: 902, Name: {'en-US': 'Weekends'}, Parent: 900},
      {_id: 903, Name: {'en-US': 'Dining'}, Parent: 902},
    );
    records.Item.push({_id: 53001, Name: 'Two Levels Down', Category: 903});
    const ids = await published(new LegolandOrlando(), records);
    expect(ids).not.toContain('53000');
    expect(ids).not.toContain('53001');
    expect(ids).toContain('11550');
  });

  test('a parent link that loops back on itself ends the walk and keeps the item', async () => {
    const records = underParent('Brick or Treat', [
      {_id: 910, Name: {'en-US': 'Dining'}, Parent: 911},
      {_id: 911, Name: {'en-US': 'Loop'}, Parent: 910},
    ]);
    records.Item.push({_id: 53002, Name: 'Looping Outlet', Category: 910});
    const ids = await published(new LegolandOrlando(), records);
    expect(ids).toContain('53002');
    expect(ids).not.toContain('53000');
  });

  test.each([
    ['as published', 'Brick or Treat'],
    ['in capitals', 'BRICK OR TREAT'],
    ['in lower case', 'brick or treat'],
    ['with a double space', 'Brick  or Treat'],
    ['with no-break spaces', 'Brick\u00a0or\u00a0Treat'],
    ['padded, as Chessington\'s season categories are', ' Brick or Treat '],
    ['with a tab', 'Brick or\tTreat'],
  ])('a parent named %s is the seasonal parent', async (_label, name) => {
    const ids = await published(new LegolandOrlando(), underParent(name));
    expect(ids).not.toContain('53000');
    expect(ids).toContain('11550');
  });

  test.each([
    ['Brick or Treat Hotel'],      // longer name: whole-name match only
    ['The Brick or Treat'],
    ['Hotel'],
    ['Brick or Treats'],
  ])('a parent named %j is not', async name => {
    const ids = await published(new LegolandOrlando(), underParent(name));
    expect(ids).toContain('53000');
  });

  test('the name a park configures is compared the same way', async () => {
    class Padded extends LegolandOrlando {
      protected getSeasonalMenuParentCategories(): string[] {
        return ['  BRICK  or Treat '];
      }
    }
    const ids = await published(new Padded(), underParent('Brick or Treat'));
    expect(ids).not.toContain('53000');
    expect(ids).toContain('11550');
  });
});

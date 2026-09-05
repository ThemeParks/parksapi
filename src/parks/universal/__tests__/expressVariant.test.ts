/**
 * Hollywood publishes the express line of each Halloween Horror Nights maze
 * as its OWN `Ride` place — "Hellraiser - Express" alongside "Hellraiser" —
 * rather than as a queue on the maze. Left alone those surface as duplicate
 * attractions whose express wait is published as a STANDBY number, so the
 * site showed "Sinners - Express 45" next to a Sinners that was really 110,
 * and for a while the express twins were the only HHN rows the site carried
 * at all.
 *
 * The variants are dropped from the entity list and their wait is folded
 * onto the maze as PAID_STANDBY. The feed offers no link to pair on, so the
 * pairing is a slug heuristic — these tests pin both the detection rule
 * (which must not catch Panda Express or Hogwarts Express) and the
 * fail-safe: an ambiguous stem discards the wait rather than publishing it
 * against the wrong maze.
 */
import {describe, test, expect, vi, afterEach} from 'vitest';
import {
  UniversalStudios,
  isExpressQueueVariant,
  buildExpressVariantMap,
  isAccessibilityReturnTimeVariant,
  isNonPoiNamespace,
  type UniversalPlace,
} from '../universal.js';

function place(
  placeId: string,
  name: string,
  type = 'Ride',
  isEvent = 'false',
): UniversalPlace {
  return {
    place_id: placeId,
    name,
    venue_id: placeId.split('.').slice(0, 2).join('.'),
    place_type: {type, attributes: [{name: 'is_event', value: isEvent}]},
  } as any as UniversalPlace;
}

const HELLRAISER = place('ush.upper_lot.rides.hhn_2026_hellraiser', 'Hellraiser');
const HELLRAISER_EXPRESS = place(
  'ush.upper_lot.rides.hellraiser_express', 'Hellraiser - Express', 'Ride', 'true',
);

describe('isExpressQueueVariant', () => {
  test('matches an express-queue POI', () => {
    expect(isExpressQueueVariant(HELLRAISER_EXPRESS)).toBe(true);
  });

  test('does not match the maze itself', () => {
    expect(isExpressQueueVariant(HELLRAISER)).toBe(false);
  });

  test('does not match places that merely contain "Express"', () => {
    // Every real counter-example from both resorts' live feeds. Panda Express
    // is Dining with no " - " separator; the Hogwarts rides are real
    // attractions; the train variants are is_event=true but the suffix is the
    // train, not Express.
    const decoys: UniversalPlace[] = [
      place('ush.dining.panda_express', 'Panda Express', 'Dining'),
      place('uor.cw.dining.panda_express', 'Panda Express', 'Dining'),
      place('uor.ioa.rides.hogwarts_express_-_hogsmeade_station', 'Hogwarts Express™ - Hogsmeade™ Station'),
      place('uor.usf.rides.hogwarts_express_-_kings_cross_station', "Hogwarts Express™ - King's Cross Station"),
      place('uor.usf.rides.hogwarts_express_first_train', 'Hogwarts™ Express - First Train', 'Ride', 'true'),
      place('uor.usf.rides.hogwarts_express_last_train', 'Hogwarts™ Express - Last Train', 'Ride', 'true'),
    ];
    for (const decoy of decoys) {
      expect(isExpressQueueVariant(decoy), decoy.place_id).toBe(false);
    }
  });

  test('an express-named Dining place is never a queue variant', () => {
    // Belt and braces: even if a dining place were somehow event-flagged and
    // named with the separator, only Rides carry queues.
    expect(isExpressQueueVariant(
      place('ush.dining.something_express', 'Something - Express', 'Dining', 'true'),
    )).toBe(false);
  });
});

describe('buildExpressVariantMap', () => {
  test('pairs every real Hollywood variant to its maze', () => {
    // The eight live pairs, including the four whose express stem is only a
    // PREFIX of the maze slug, and Kill-Ceanera, whose separators differ
    // ("kill_ceanera" vs "killceanera_music_by_slash").
    const places = [
      place('ush.upper_lot.rides.hhn_2026_hellraiser', 'Hellraiser'),
      place('ush.upper_lot.rides.hhn_2026_sinners', 'Sinners'),
      place('ush.upper_lot.rides.hhn_2026_evil_dead_burn', 'Evil Dead Burn'),
      place('ush.lower_lot.rides.hhn_2026_dead_deader_deadest', 'Dead Deader Deadest'),
      place('ush.upper_lot.rides.hhn_2026_killer_klowns_outer_space', 'Killer Klowns from Outer Space'),
      place('ush.lower_lot.rides.hhn_2026_ozzy_osbourne_prince_of_darkness', 'Ozzy Osbourne: Prince of Darkness'),
      place('ush.lower_lot.rides.hhn_2026_stranger_things_5', 'Stranger Things 5'),
      place('ush.lower_lot.rides.hhn_2026_killceanera_music_by_slash', 'Killceañera: Music by SLASH'),
      place('ush.upper_lot.rides.hellraiser_express', 'Hellraiser - Express', 'Ride', 'true'),
      place('ush.upper_lot.rides.sinners_express', 'Sinners - Express', 'Ride', 'true'),
      place('ush.upper_lot.rides.evil_dead_burn_express', 'Evil Dead Burn - Express', 'Ride', 'true'),
      place('ush.lower_lot.rides.dead_deader_deadest_express', 'Dead, Deader, Deadest - Express', 'Ride', 'true'),
      // Note: upstream puts this variant in a DIFFERENT lot from its maze,
      // so venue cannot be used to disambiguate.
      place('ush.lower_lot.rides.killer_klowns_express', 'Killer Klowns - Express', 'Ride', 'true'),
      place('ush.lower_lot.rides.ozzy_osbourne_express', 'Ozzy Osbourne - Express', 'Ride', 'true'),
      place('ush.lower_lot.rides.stranger_things_express', 'Stranger Things - Express', 'Ride', 'true'),
      place('ush.upper_lot.rides.kill_ceanera_express', 'Kill-Ceanera - Express', 'Ride', 'true'),
    ];
    const pairs = buildExpressVariantMap(places);
    expect(pairs.size).toBe(8);
    expect(pairs.get('ush.upper_lot.rides.hellraiser_express'))
      .toBe('ush.upper_lot.rides.hhn_2026_hellraiser');
    expect(pairs.get('ush.lower_lot.rides.killer_klowns_express'))
      .toBe('ush.upper_lot.rides.hhn_2026_killer_klowns_outer_space');
    expect(pairs.get('ush.upper_lot.rides.kill_ceanera_express'))
      .toBe('ush.lower_lot.rides.hhn_2026_killceanera_music_by_slash');
    expect(pairs.get('ush.lower_lot.rides.stranger_things_express'))
      .toBe('ush.lower_lot.rides.hhn_2026_stranger_things_5');
  });

  test('an unmatched stem is dropped rather than guessed at', () => {
    const pairs = buildExpressVariantMap([
      place('ush.upper_lot.rides.hhn_2026_hellraiser', 'Hellraiser'),
      place('ush.upper_lot.rides.orphan_express', 'Orphan - Express', 'Ride', 'true'),
    ]);
    expect(pairs.size).toBe(0);
  });

  test('an ambiguous stem is dropped rather than attached to either', () => {
    // Two mazes share the stem, so the express wait cannot be assigned. A
    // wrong-but-plausible express time is worse than no express time.
    const pairs = buildExpressVariantMap([
      place('ush.upper_lot.rides.hhn_2026_sinners', 'Sinners'),
      place('ush.upper_lot.rides.hhn_2026_sinners_encore', 'Sinners Encore'),
      place('ush.upper_lot.rides.sinners_express', 'Sinners - Express', 'Ride', 'true'),
    ]);
    expect(pairs.size).toBe(0);
  });

  test('a feed with no variants costs nothing', () => {
    expect(buildExpressVariantMap([HELLRAISER]).size).toBe(0);
    expect(buildExpressVariantMap([]).size).toBe(0);
  });
});

describe('Universal buildLiveData — express waits fold onto the maze', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const PLACES = [HELLRAISER, HELLRAISER_EXPRESS];

  function stub(waitTimes: any[]): any {
    const park: any = new UniversalStudios();
    park._init = async () => undefined;
    park.getVirtualQueueStates = async () => [];
    park.getShowList = async () => [];
    park.getPlaces = async () => PLACES;
    park.getWaitTimes = async () => waitTimes;
    park.getVenueSchedule = async () => [];
    return park;
  }

  function waitRow(id: string, status: string, wait?: number) {
    return {
      wait_time_attraction_id: id,
      queues: [{queue_type: 'STANDBY', status, display_wait_time: wait}],
    };
  }

  test('the express wait becomes PAID_STANDBY on the maze, and the twin disappears', async () => {
    const rows = await stub([
      waitRow('ush.upper_lot.rides.hhn_2026_hellraiser', 'OPEN', 55),
      waitRow('ush.upper_lot.rides.hellraiser_express', 'OPEN', 5),
    ]).getLiveData();

    expect(rows.find((r: any) => r.id === 'ush.upper_lot.rides.hellraiser_express')).toBeUndefined();
    const maze = rows.find((r: any) => r.id === 'ush.upper_lot.rides.hhn_2026_hellraiser');
    expect(maze.queue.STANDBY.waitTime).toBe(55);
    expect(maze.queue.PAID_STANDBY.waitTime).toBe(5);
    expect(maze.status).toBe('OPERATING');
  });

  test('a shut express line publishes no PAID_STANDBY', async () => {
    const rows = await stub([
      waitRow('ush.upper_lot.rides.hhn_2026_hellraiser', 'OPEN', 55),
      waitRow('ush.upper_lot.rides.hellraiser_express', 'CLOSED'),
    ]).getLiveData();
    const maze = rows.find((r: any) => r.id === 'ush.upper_lot.rides.hhn_2026_hellraiser');
    expect(maze.queue.STANDBY.waitTime).toBe(55);
    expect(maze.queue.PAID_STANDBY).toBeUndefined();
  });

  test("the express line's state never decides the maze's status", async () => {
    // The maze is shut and only its express row is open. Folding must move
    // the number only — reporting the maze OPERATING because its express
    // queue answered would be exactly the inversion this change exists to
    // remove.
    const rows = await stub([
      waitRow('ush.upper_lot.rides.hhn_2026_hellraiser', 'CLOSED'),
      waitRow('ush.upper_lot.rides.hellraiser_express', 'OPEN', 5),
    ]).getLiveData();
    const maze = rows.find((r: any) => r.id === 'ush.upper_lot.rides.hhn_2026_hellraiser');
    expect(maze.status).toBe('CLOSED');
    expect(maze.queue?.PAID_STANDBY?.waitTime).toBe(5);
  });

  test("Universal's 995 not-available sentinel is not published as a wait", async () => {
    const rows = await stub([
      waitRow('ush.upper_lot.rides.hhn_2026_hellraiser', 'OPEN', 55),
      waitRow('ush.upper_lot.rides.hellraiser_express', 'OPEN', 995),
    ]).getLiveData();
    const maze = rows.find((r: any) => r.id === 'ush.upper_lot.rides.hhn_2026_hellraiser');
    expect(maze.queue.PAID_STANDBY).toBeUndefined();
  });

  test('a place-list failure costs the express waits, not the live build', async () => {
    // getPlaces is the entity feed. buildEntityList is allowed to fail loudly;
    // buildLiveData is not, or one bad entity fetch blanks every wait time.
    const park = stub([waitRow('ush.upper_lot.rides.hhn_2026_hellraiser', 'OPEN', 55)]);
    park.getPlaces = async () => { throw new Error('upstream 500'); };
    const rows = await park.getLiveData();
    const maze = rows.find((r: any) => r.id === 'ush.upper_lot.rides.hhn_2026_hellraiser');
    expect(maze.queue.STANDBY.waitTime).toBe(55);
  });
});

describe('isAccessibilityReturnTimeVariant', () => {
  // Orlando publishes each haunted house's accessibility return service as
  // its own Ride place. All ten houses are already live, so left alone these
  // surface as ten duplicate rides named after a queue.
  const HOUSE = 'uor.usf.rides.hhn_haunted_house_sinners';
  const DAAP = `${HOUSE}_daap`;
  const known = new Set([HOUSE, DAAP]);

  function daap(placeId: string, name: string): UniversalPlace {
    return place(placeId, name, 'Ride', 'true');
  }

  test('drops the variant when its house is in the feed', () => {
    expect(isAccessibilityReturnTimeVariant(
      daap(DAAP, 'Sinners Accessibility Return Time'), known,
    )).toBe(true);
  });

  test('keeps the house itself', () => {
    expect(isAccessibilityReturnTimeVariant(place(HOUSE, 'Sinners'), known)).toBe(false);
  });

  test('a non-breaking space in the name does not defeat the match', () => {
    // Exactly one of the ten real names separates the suffix with U+00A0
    // instead of a space ("MADLANDS: Caged Cannibals\u00a0Accessibility
    // Return Time"). It is invisible in a log and in a diff, and it silently
    // let that one variant through until the names were compared byte by
    // byte. Every name-based match in this file normalises first.
    expect(isAccessibilityReturnTimeVariant(
      daap(DAAP, 'Sinners\u00a0Accessibility Return Time'), known,
    )).toBe(true);
  });

  test('a variant with no house in the feed is kept, not silently dropped', () => {
    // Sloppy feed data is not a duplicate. Same discipline as
    // isEventVariantAlias, which keeps a share link pointing at a phantom id.
    expect(isAccessibilityReturnTimeVariant(
      daap('uor.usf.rides.hhn_haunted_house_ghost_daap', 'Ghost Accessibility Return Time'),
      new Set(['uor.usf.rides.hhn_haunted_house_ghost_daap']),
    )).toBe(false);
  });

  test('a _daap id without the return-time name is not assumed to be one', () => {
    expect(isAccessibilityReturnTimeVariant(daap(DAAP, 'Sinners'), known)).toBe(false);
  });
});

describe('isNonPoiNamespace', () => {
  test('drops passholder marketing typed as attractions', () => {
    // These arrive typed as real POIs: an Express Pass discount as a Ride,
    // character meet & greets as a Show, menu blurbs as Dining.
    const ads: UniversalPlace[] = [
      place('uor.pad.save.30.select.universal.express.passes', 'Save 30% on Select Universal Express Passes'),
      place('uor.pad.exclusive.menu.items.in.the.parks', 'Exclusive Menu Items in the Parks', 'Dining'),
      place('uor.pad.exclusive.menu.items.at.citywalk', 'Exclusive Menu Items at CityWalk', 'Dining'),
      place('uor.pan.character.meet.and.greets', 'Character Meet & Greets', 'Show'),
      place('uor.pan.exclusive.menu.items', 'Exclusive Passholder Nights Menu Items', 'Dining'),
    ];
    for (const ad of ads) expect(isNonPoiNamespace(ad), ad.place_id).toBe(true);
  });

  test('keeps every real namespace, including resort-wide categories', () => {
    // A deny-list, so the risk is over-matching. "dining" and "amenities" are
    // real second segments that must survive.
    const keep = [
      'uor.usf.rides.revenge_of_the_mummy',
      'uor.ioa.shows.darkartsathogwartscastle',
      'uor.vb.rides.krakatau_aqua_coaster',
      'ush.dining.panda_express',
      'ush.upper_lot.rides.hhn_2026_sinners',
      'uor.cw.dining.vivo_italian_kitchen',
      'uor.amenities.first_aid',
    ];
    for (const id of keep) expect(isNonPoiNamespace(place(id, 'x')), id).toBe(false);
  });
});

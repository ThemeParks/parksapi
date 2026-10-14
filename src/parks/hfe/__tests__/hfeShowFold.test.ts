/**
 * Silver Dollar City's activity feed lists an act once per stage and once per
 * season, all under the same title. "Arbour Season" is five records: the
 * Gazebo Stage twice (a spring one and a Christmas one, both categorised), the
 * Boatworks Theater (uncategorised, scheduled only while it plays) and two
 * more uncategorised stage copies that are never scheduled. Published as they
 * stand, the park carries several entities with identical names.
 *
 * What the feed gives us to work with:
 *
 *   - the stage is `showVenueLocation`, the id of another activity in the same
 *     payload ("Gazebo Stage", "Boatworks Theater", ...). It can be null, can
 *     name a record outside the venue list, and can name the show itself.
 *   - the season is only a category on the record ("Spring Break",
 *     "Christmas Entertainment"); `seasonalStartDate` / `seasonalEndDate` are
 *     set on a few records and are years stale on those.
 *   - every copy stays in the feed all year. What comes and goes is whether a
 *     copy clears the ghost filter: a categorised record always does, an
 *     uncategorised one only while the schedule lists it.
 *
 * One entity per act and stage, then: copies on the same stage fold into one,
 * copies on different stages stay apart, and the stage is added to the name
 * wherever the feed lists the title on more than one named stage. That count
 * is taken over every record in the feed, published or not, so a name never
 * moves with the schedule: a single-stage act whose title the feed also lists
 * on another stage carries its stage all year.
 *
 * The fixture keeps the real ids, titles, categories, venues and dates of the
 * records involved, captured 2026-09-12. Showtimes are built inline, because
 * the captured window had events for only one of the Arbour Season copies.
 */
import {describe, test, expect, afterEach, vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {
  SilverDollarCity,
  Dollywood,
  foldShowsByStage,
  type HFEActivity,
} from '../hfe.js';

const fixture: {activities: unknown[]} = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/silverdollarcity-shows-2026-09-12.json', import.meta.url)), 'utf8'),
);
const SHOW_LIST = '9e8b88c7-6a31-46e2-b696-aad5a5ecfe3d';
const ACTIVITIES = fixture.activities as unknown as HFEActivity[];
const byId = new Map(ACTIVITIES.map(a => [a.id, a]));
const rec = (id: string): HFEActivity => {
  const found = byId.get(id);
  if (!found) throw new Error(`fixture has no record ${id}`);
  return found;
};

const ARBOUR_GAZEBO_SPRING = 'c7095f82-45d6-4174-bfc5-f4c1145ad88e';
const ARBOUR_GAZEBO_XMAS = 'e9cba5ef-67a2-4667-aa37-d735e00f6ffc';
const ARBOUR_BOATWORKS = '13c2526d-cd86-41c4-8b44-538ece07c7b5';
const ARBOUR_DOCKSIDE = 'aafbc4c9-f15d-4125-85ae-e1f434093f08';
const ARBOUR_PLAZA = 'ca0dc3af-ae87-4750-9406-3585ece8afc9';

const KINFOLK = [
  '980730e3-6095-47b2-bd23-11a327e34cc5', // Plaza Stage
  'b9e56aa1-ec19-45bf-bd2d-1d1618bbfce2', // no stage
  'adebba7e-510a-4474-87bd-c40802816d7e', // Gazebo Stage
  'e2e74e56-dbf0-4f26-8c3e-61d6aeb2258f', // Dockside Theater
  'f7fe4ce7-44a5-4613-946d-dad3535b85ed', // Boatworks Theater
];

/** A show record, for the cases the captured payload does not contain. */
const show = (id: string, title: string, over: Partial<HFEActivity> = {}): HFEActivity => ({
  id,
  title,
  activityListId: SHOW_LIST,
  activityCategories: ['Shows Entertainment'],
  ...over,
} as HFEActivity);

const GAZEBO = 'fbc761ff-873e-4bc9-bf85-fe6018ab6865';
const BOATWORKS = '68f726da-3b5e-43e9-a3ef-a5fa25b258bc';

describe('foldShowsByStage', () => {
  describe('the Arbour Season records', () => {
    // The three the park keeps today. The other two are uncategorised and
    // never scheduled, so the ghost filter drops them before this runs; the
    // class-level tests below prove that part through the real filter.
    const emitted = [ARBOUR_GAZEBO_SPRING, ARBOUR_GAZEBO_XMAS, ARBOUR_BOATWORKS].map(rec);

    test('the two Gazebo copies fold into one entity, Boatworks stays apart', () => {
      const groups = foldShowsByStage(emitted, ACTIVITIES);
      expect(groups).toHaveLength(2);
      const gazebo = groups.find(g => g.members.some(m => m.id === ARBOUR_GAZEBO_SPRING))!;
      expect(gazebo.members.map(m => m.id).sort()).toEqual([ARBOUR_GAZEBO_SPRING, ARBOUR_GAZEBO_XMAS].sort());
      const boatworks = groups.find(g => g.canonical.id === ARBOUR_BOATWORKS)!;
      expect(boatworks.members).toHaveLength(1);
    });

    test('the stage is added to the name because the act plays on two', () => {
      const names = foldShowsByStage(emitted, ACTIVITIES).map(g => g.name).sort();
      expect(names).toEqual([
        'Arbour Season (Boatworks Theater)',
        'Arbour Season (Gazebo Stage)',
      ]);
    });

    test('the Gazebo entity keeps the id that is already published', () => {
      const gazebo = foldShowsByStage(emitted, ACTIVITIES)
        .find(g => g.members.length === 2)!;
      expect(gazebo.canonical.id).toBe(ARBOUR_GAZEBO_SPRING);
    });

    test('the name keeps its stage when the other stage\'s copy is off the schedule', () => {
      // The Boatworks copy has left the window, so only the Gazebo copies are
      // published. The feed still lists the title on other stages, so the name
      // is the one it has while Boatworks is scheduled.
      const groups = foldShowsByStage([ARBOUR_GAZEBO_SPRING, ARBOUR_GAZEBO_XMAS].map(rec), ACTIVITIES);
      expect(groups).toHaveLength(1);
      expect(groups[0].name).toBe('Arbour Season (Gazebo Stage)');
      expect(groups[0].canonical.id).toBe(ARBOUR_GAZEBO_SPRING);
    });

    test('all five records, were they all kept, still make one group per stage', () => {
      const all = [
        ARBOUR_GAZEBO_SPRING, ARBOUR_GAZEBO_XMAS, ARBOUR_BOATWORKS, ARBOUR_DOCKSIDE, ARBOUR_PLAZA,
      ].map(rec);
      const groups = foldShowsByStage(all, ACTIVITIES);
      expect(groups.map(g => g.name).sort()).toEqual([
        'Arbour Season (Boatworks Theater)',
        'Arbour Season (Dockside Theater)',
        'Arbour Season (Gazebo Stage)',
        'Arbour Season (Plaza Stage)',
      ]);
    });
  });

  describe('near misses that must NOT fold', () => {
    test('the same title on different stages stays one entity per stage', () => {
      const groups = foldShowsByStage(KINFOLK.map(rec), ACTIVITIES);
      expect(groups).toHaveLength(5);
      expect(groups.every(g => g.members.length === 1)).toBe(true);
    });

    test('Kinfolk Bluegrass Band: four named stages are suffixed, the unplaced record is not', () => {
      const names = foldShowsByStage(KINFOLK.map(rec), ACTIVITIES).map(g => g.name).sort();
      expect(names).toEqual([
        'Kinfolk Bluegrass Band',
        'Kinfolk Bluegrass Band (Boatworks Theater)',
        'Kinfolk Bluegrass Band (Dockside Theater)',
        'Kinfolk Bluegrass Band (Gazebo Stage)',
        'Kinfolk Bluegrass Band (Plaza Stage)',
      ]);
    });

    test('Spoken 4 Quartet plays three stages and keeps three entities', () => {
      const ids = [
        'cf8ba7bb-7ab4-45e3-a5c0-d1ab0523879e',
        'bb3bf7ce-611a-4e77-a738-f25d51eb4dc4',
        '3215eb58-6589-440b-afff-c4c5d8f8ee6b',
      ];
      const groups = foldShowsByStage(ids.map(rec), ACTIVITIES);
      expect(groups.map(g => g.name).sort()).toEqual([
        'Spoken 4 Quartet (Boatworks Theater)',
        'Spoken 4 Quartet (Gazebo Stage)',
        'Spoken 4 Quartet (Riverfront Playhouse)',
      ]);
    });

    test('different acts on the same stage never fold', () => {
      // Three different acts that all play the Gazebo Stage.
      const acts = [
        ARBOUR_GAZEBO_SPRING,
        'f133f71e-15cd-4575-b101-56a6546dda42', // Horse Creek Band
        'c982ad9d-c379-433b-b48d-2d1949151419', // David Howarth
      ].map(rec);
      const groups = foldShowsByStage(acts, ACTIVITIES);
      expect(groups).toHaveLength(3);
      expect(groups.map(g => g.name).sort()).toEqual([
        'Arbour Season (Gazebo Stage)',
        'David Howarth (Gazebo Stage)',
        'Horse Creek Band (Gazebo Stage)',
      ]);
    });

    test('an act the feed lists on one stage only keeps its plain name', () => {
      // Homestead Pickers has a second record, but on the same stage: still one.
      const [g] = foldShowsByStage([rec('afa2cd9f-3b39-46c8-ae3e-7a683f8da1eb')], ACTIVITIES);
      expect(g.name).toBe('Homestead Pickers');
    });

    // Published on one stage, but the feed also lists the title on another
    // stage (an uncategorised record that is never scheduled). The stage goes
    // in the name so it does not change if that record is ever scheduled.
    test.each([
      ['f133f71e-15cd-4575-b101-56a6546dda42', 'Horse Creek Band (Gazebo Stage)', 'Plaza Stage'],
      ['13b075b1-4b37-460d-8ef6-2fc79a209192', 'The Creek Rocks (Gazebo Stage)', 'Boatworks Theater and Dockside Theater'],
      ['8e7dfd0d-8978-46ca-be45-5a02de0318c2', 'Dawson Hollow (Dockside Theater)', 'Boatworks Theater'],
    ])('a single published stage still carries it: %s -> %s (ghost on %s)', (id, name) => {
      const [g] = foldShowsByStage([rec(id)], ACTIVITIES);
      expect(g.name).toBe(name);
    });

    test('a ghost on another stage does not join the group', () => {
      const [g] = foldShowsByStage([rec('f133f71e-15cd-4575-b101-56a6546dda42')], ACTIVITIES);
      expect(g.members.map(m => m.id)).toEqual(['f133f71e-15cd-4575-b101-56a6546dda42']);
    });

    test('titles that merely share words are not the same act', () => {
      const groups = foldShowsByStage([
        show('a1', 'Heart of Christmas with The Isaacs', {showVenueLocation: GAZEBO}),
        show('a2', 'Heart of Christmas with Rhonda Vincent', {showVenueLocation: GAZEBO}),
        show('a3', 'Heart of Christmas', {showVenueLocation: GAZEBO}),
      ], ACTIVITIES);
      expect(groups).toHaveLength(3);
    });

    test('a title with no letters or digits is never folded', () => {
      const groups = foldShowsByStage([
        show('b1', '???', {showVenueLocation: GAZEBO}),
        show('b2', '???', {showVenueLocation: GAZEBO}),
      ], ACTIVITIES);
      expect(groups).toHaveLength(2);
    });

    test('titles in other scripts are compared by their letters', () => {
      const groups = foldShowsByStage([
        show('c1', '音楽ショー', {showVenueLocation: GAZEBO}),
        show('c2', '花火ショー', {showVenueLocation: GAZEBO}),
        show('c3', '音楽ショー', {showVenueLocation: GAZEBO}),
      ], ACTIVITIES);
      expect(groups).toHaveLength(2);
      expect(groups.find(g => g.members.length === 2)!.canonical.id).toBe('c1');
    });
  });

  describe('what counts as the same title and the same stage', () => {
    test('case, punctuation and surrounding space do not make a different act', () => {
      const groups = foldShowsByStage([
        show('d1', 'Arbour Season', {showVenueLocation: GAZEBO}),
        show('d2', ' ARBOUR  season! ', {showVenueLocation: GAZEBO}),
      ], ACTIVITIES);
      expect(groups).toHaveLength(1);
      expect(groups[0].members).toHaveLength(2);
    });

    test('two venue records with the same name are one stage', () => {
      const twin = {...rec(GAZEBO), id: 'e0000000-0000-4000-8000-000000000001'};
      const groups = foldShowsByStage([
        show('f1', 'Duet', {showVenueLocation: GAZEBO}),
        show('f2', 'Duet', {showVenueLocation: twin.id}),
      ], [...ACTIVITIES, twin]);
      expect(groups).toHaveLength(1);
    });

    test('records with no stage fold with each other, and are not named by a stage', () => {
      const groups = foldShowsByStage([
        show('g1', 'Lantern Walk'),
        show('g2', 'Lantern Walk', {showVenueLocation: null}),
      ], ACTIVITIES);
      expect(groups).toHaveLength(1);
      expect(groups[0].name).toBe('Lantern Walk');
    });

    const DANGLING = '00000000-0000-4000-8000-00000000dead';

    test('a venue id that matches nothing in the payload is an unnamed stage', () => {
      const groups = foldShowsByStage([
        show('h1', 'Lantern Walk', {showVenueLocation: DANGLING}),
        show('h2', 'Lantern Walk', {showVenueLocation: GAZEBO}),
        show('h3', 'Lantern Walk', {showVenueLocation: BOATWORKS}),
      ], ACTIVITIES);
      expect(groups.map(g => g.name).sort()).toEqual([
        'Lantern Walk',
        'Lantern Walk (Boatworks Theater)',
        'Lantern Walk (Gazebo Stage)',
      ]);
    });

    test('a venue that points at the show itself names no stage', () => {
      // The Ferguson Family is its own venue in the feed.
      const own = rec('37912325-fd99-4a38-b052-1ba16c0b695b');
      expect(own.showVenueLocation).toBe(own.id);
      const groups = foldShowsByStage([
        own,
        show('i1', 'The Ferguson Family', {showVenueLocation: GAZEBO}),
        show('i2', 'The Ferguson Family', {showVenueLocation: BOATWORKS}),
      ], ACTIVITIES);
      expect(groups.map(g => g.name).sort()).toEqual([
        'The Ferguson Family',
        'The Ferguson Family (Boatworks Theater)',
        'The Ferguson Family (Gazebo Stage)',
      ]);
    });

    // A stage the feed does not name is no stage: it is never the "other
    // stage" that makes a single-stage act carry its own.
    test.each([
      ['points at the show itself', (id: string) => id],
      ['matches nothing in the payload', () => DANGLING],
      ['is null', () => null],
    ])('an act whose only other record has a venue that %s keeps its plain name', (_label, venueFor) => {
      const placed = show('k1', 'Porch Concert', {showVenueLocation: GAZEBO});
      const other = show('k2', 'Porch Concert', {activityCategories: [], showVenueLocation: venueFor('k2')});
      for (const published of [[placed], [placed, other]]) {
        const names = foldShowsByStage(published, [...ACTIVITIES, placed, other]).map(g => g.name);
        // With the other record published too there are two groups, and the
        // unnamed one does not make the named one a second stage.
        expect(names).toEqual(published.map(() => 'Porch Concert'));
      }
    });

    test('a stage the feed names counts even when only a ghost record has it', () => {
      const placed = show('m1', 'Porch Concert', {showVenueLocation: GAZEBO});
      const ghost = show('m2', 'Porch Concert', {activityCategories: [], showVenueLocation: BOATWORKS});
      const [g] = foldShowsByStage([placed], [...ACTIVITIES, placed, ghost]);
      expect(g.name).toBe('Porch Concert (Gazebo Stage)');
    });

    test('only records of the same list count as the same act', () => {
      // A restaurant that shares a show\'s title, on a named stage, is not the
      // show playing a second stage.
      const placed = show('n1', 'Porch Concert', {showVenueLocation: GAZEBO});
      const diner = show('n2', 'Porch Concert', {activityListId: 'dining', showVenueLocation: BOATWORKS});
      const [g] = foldShowsByStage([placed], [...ACTIVITIES, placed, diner]);
      expect(g.name).toBe('Porch Concert');
    });

    test('a stage can be a record from a different list than the venues', () => {
      const homestead = {...show('j0', "McHaffie's Homestead"), activityListId: 'attractions', activityCategories: ['Rides & Attractions']};
      const groups = foldShowsByStage([
        show('j1', 'Pickers', {showVenueLocation: 'j0'}),
        show('j2', 'Pickers', {showVenueLocation: GAZEBO}),
      ], [...ACTIVITIES, homestead]);
      expect(groups.map(g => g.name).sort()).toEqual([
        "Pickers (McHaffie's Homestead)",
        'Pickers (Gazebo Stage)',
      ].sort());
    });
  });

  describe('the canonical id', () => {
    const GAZEBO_PAIR = [ARBOUR_GAZEBO_SPRING, ARBOUR_GAZEBO_XMAS].map(rec);

    test('is the lowest id when nothing else separates the copies', () => {
      const [g] = foldShowsByStage(GAZEBO_PAIR, ACTIVITIES);
      expect(g.canonical.id).toBe(ARBOUR_GAZEBO_SPRING);
      expect(ARBOUR_GAZEBO_SPRING < ARBOUR_GAZEBO_XMAS).toBe(true);
    });

    test('does not depend on the order the records arrive in', () => {
      const forward = foldShowsByStage(GAZEBO_PAIR, ACTIVITIES);
      const backward = foldShowsByStage([...GAZEBO_PAIR].reverse(), ACTIVITIES);
      expect(backward.map(g => g.canonical.id)).toEqual(forward.map(g => g.canonical.id));
      expect(backward[0].members.map(m => m.id)).toEqual(forward[0].members.map(m => m.id));
    });

    // The off-season copy. A categorised record always clears the ghost
    // filter; an uncategorised one clears it only while it is scheduled, so it
    // comes and goes. A copy that comes and goes must not be able to move the
    // id, whatever its place in id order.
    const LOW_ID_VOLATILE = show('00000000-aaaa-4000-8000-000000000000', 'Arbour Season', {
      activityCategories: [],
      showVenueLocation: GAZEBO,
    });

    test('a categorised copy outranks a lower-id copy that is only here while scheduled', () => {
      const [g] = foldShowsByStage([LOW_ID_VOLATILE, ...GAZEBO_PAIR], ACTIVITIES);
      expect(g.members).toHaveLength(3);
      expect(g.canonical.id).toBe(ARBOUR_GAZEBO_SPRING);
    });

    test('the volatile copy leaving does not move the id', () => {
      const withCopy = foldShowsByStage([LOW_ID_VOLATILE, ...GAZEBO_PAIR], ACTIVITIES)[0].canonical.id;
      const without = foldShowsByStage(GAZEBO_PAIR, ACTIVITIES)[0].canonical.id;
      expect(without).toBe(withCopy);
    });

    test('a pinned id outranks a lower categorised id', () => {
      const [g] = foldShowsByStage(GAZEBO_PAIR, ACTIVITIES, {preferredIds: new Set([ARBOUR_GAZEBO_XMAS])});
      expect(g.canonical.id).toBe(ARBOUR_GAZEBO_XMAS);
    });

    test('a new categorised copy with a lower id cannot take a pinned id', () => {
      const newcomer = show('00000000-bbbb-4000-8000-000000000000', 'Arbour Season', {
        activityCategories: ['Summer'],
        showVenueLocation: GAZEBO,
      });
      const pinned = {preferredIds: new Set([ARBOUR_GAZEBO_SPRING])};
      expect(foldShowsByStage([newcomer, ...GAZEBO_PAIR], ACTIVITIES, pinned)[0].canonical.id)
        .toBe(ARBOUR_GAZEBO_SPRING);
      // The same newcomer with nothing pinned does take it. This is the flip
      // the pin exists to prevent, and the only one left for an id that is
      // not pinned: a new categorised copy that sorts lower.
      expect(foldShowsByStage([newcomer, ...GAZEBO_PAIR], ACTIVITIES)[0].canonical.id).toBe(newcomer.id);
    });

    test('a pinned id for some other group changes nothing', () => {
      const [g] = foldShowsByStage(GAZEBO_PAIR, ACTIVITIES, {preferredIds: new Set([ARBOUR_BOATWORKS])});
      expect(g.canonical.id).toBe(ARBOUR_GAZEBO_SPRING);
    });

    test('when the only categorised copy leaves the feed, the id moves to the lowest copy left', () => {
      // The one flip that cannot be designed away: the record the id came from
      // is gone. Pinned here so it is a decision and not a surprise.
      const before = foldShowsByStage([rec(ARBOUR_GAZEBO_XMAS), LOW_ID_VOLATILE], ACTIVITIES)[0];
      expect(before.canonical.id).toBe(ARBOUR_GAZEBO_XMAS);
      const after = foldShowsByStage([LOW_ID_VOLATILE], ACTIVITIES)[0];
      expect(after.canonical.id).toBe(LOW_ID_VOLATILE.id);
    });

    test('among copies that are all uncategorised, the lowest id leaving moves the id', () => {
      // Also not designable away: every copy is volatile, so whichever is
      // lowest among those present is the id. Named so a reader knows it.
      const a = show('10000000-0000-4000-8000-000000000000', 'Night Walk', {activityCategories: [], showVenueLocation: GAZEBO});
      const b = show('20000000-0000-4000-8000-000000000000', 'Night Walk', {activityCategories: [], showVenueLocation: GAZEBO});
      expect(foldShowsByStage([a, b], ACTIVITIES)[0].canonical.id).toBe(a.id);
      expect(foldShowsByStage([b], ACTIVITIES)[0].canonical.id).toBe(b.id);
    });
  });

  describe('invariants over the whole captured payload', () => {
    const shows = ACTIVITIES.filter(a => a.activityListId === SHOW_LIST);
    const fold = () => foldShowsByStage(shows, ACTIVITIES);

    test('every input record lands in exactly one group', () => {
      const members = fold().flatMap(g => g.members.map(m => m.id));
      expect(members.sort()).toEqual(shows.map(s => s.id).sort());
    });

    test('no two groups share a name', () => {
      const names = fold().map(g => g.name);
      expect(new Set(names).size).toBe(names.length);
    });

    test('the canonical record is one of its own members', () => {
      expect(fold().every(g => g.members.includes(g.canonical))).toBe(true);
    });

    test('an empty list gives no groups', () => {
      expect(foldShowsByStage([], ACTIVITIES)).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// Through the park: the real ghost filter, the real entity list, the real
// schedules.
// ---------------------------------------------------------------------------

type Ev = {from: string; to?: string | null};
const day = (date: string, perShow: Record<string, Ev[]> = {}) => ({
  date: `${date}T00:00:00`,
  parkHours: [],
  activities: Object.entries(perShow).map(([cmsKey, events]) => ({
    cmsKey,
    events: events.map(e => ({from: `${date}T${e.from}`, to: e.to ? `${date}T${e.to}` : null})),
  })),
});

/**
 * The records of the fixture the schedule listed in the 2026-09-12 capture.
 * Every other record is either categorised (kept regardless) or a ghost.
 */
const SCHEDULED_IN_CAPTURE = [
  ARBOUR_BOATWORKS,
  'a602f762-1b7b-4e58-83e3-f7cc09e80b13', // Casey & The Atta Boys, Boatworks
  '1655dade-179b-4d4f-9f8f-0e980bfc8b07', // Chris Stanley, Boatworks
  '7114c6e9-047a-4d57-96b7-a8fdf32aa0f0', // Chris Stanley, Dockside
  'c982ad9d-c379-433b-b48d-2d1949151419', // David Howarth, Gazebo
  'afa2cd9f-3b39-46c8-ae3e-7a683f8da1eb', // Homestead Pickers
  'f133f71e-15cd-4575-b101-56a6546dda42', // Horse Creek Band
  'e2e74e56-dbf0-4f26-8c3e-61d6aeb2258f', // Kinfolk, Dockside
  'f7fe4ce7-44a5-4613-946d-dad3535b85ed', // Kinfolk, Boatworks
  'cefda16a-954c-4146-9e69-aca791daf59e', // Lindley Creek
  '8e7dfd0d-8978-46ca-be45-5a02de0318c2', // Dawson Hollow, Dockside
  '3215eb58-6589-440b-afff-c4c5d8f8ee6b', // Spoken 4 Quartet, Boatworks
  'bb3bf7ce-611a-4e77-a738-f25d51eb4dc4', // Spoken 4 Quartet, Riverfront
];

/**
 * 2026-09-18 as captured: the Gazebo copies of Arbour Season and the Dockside
 * and Plaza copies are not listed at all.
 */
const DAYS_AS_CAPTURED = [
  day('2026-09-18', Object.fromEntries(SCHEDULED_IN_CAPTURE.map(id => [id, [{from: '17:30:00'}]]))),
];

function silverDollarCity(days: unknown[] = DAYS_AS_CAPTURED, activities = ACTIVITIES): any {
  const park: any = new SilverDollarCity();
  park.getActivities = async () => activities;
  park.getSchedule = async () => days;
  return park;
}

const showEntities = (entities: any[]) => entities.filter(e => e.entityType === 'SHOW');

afterEach(() => vi.useRealTimers());

describe('SilverDollarCity entity list', () => {
  test('keeps three of the five Arbour Season records, through the ghost filter', async () => {
    const entities = showEntities(await silverDollarCity().getEntities());
    const ids = entities.map((e: any) => e.id);
    // Gazebo spring + Christmas are categorised; Boatworks is scheduled; the
    // Dockside and Plaza copies are neither, so the filter drops them.
    expect(ids).toContain(ARBOUR_GAZEBO_SPRING);
    expect(ids).toContain(ARBOUR_BOATWORKS);
    expect(ids).not.toContain(ARBOUR_DOCKSIDE);
    expect(ids).not.toContain(ARBOUR_PLAZA);
  });

  test('publishes the two Gazebo copies as one entity, under the id already live', async () => {
    const entities = showEntities(await silverDollarCity().getEntities());
    expect(entities.map((e: any) => e.id)).not.toContain(ARBOUR_GAZEBO_XMAS);
    const gazebo = entities.find((e: any) => e.id === ARBOUR_GAZEBO_SPRING);
    expect(gazebo.name).toBe('Arbour Season (Gazebo Stage)');
    const boatworks = entities.find((e: any) => e.id === ARBOUR_BOATWORKS);
    expect(boatworks.name).toBe('Arbour Season (Boatworks Theater)');
  });

  test('no two shows share a name, whichever records are scheduled', async () => {
    const everything = [
      ...ACTIVITIES.filter(a => a.activityListId === SHOW_LIST).map(a => a.id),
    ];
    const days = [day('2026-09-18', Object.fromEntries(everything.map(id => [id, [{from: '12:00:00'}]])))];
    const names = showEntities(await silverDollarCity(days).getEntities()).map((e: any) => e.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test('Kinfolk Bluegrass Band publishes five entities with five names', async () => {
    const entities = showEntities(await silverDollarCity().getEntities())
      .filter((e: any) => e.name.startsWith('Kinfolk Bluegrass Band'));
    expect(entities.map((e: any) => e.id).sort()).toEqual([...KINFOLK].sort());
    expect(new Set(entities.map((e: any) => e.name)).size).toBe(5);
  });

  test('an act the feed lists on one stage only keeps its plain name and its id', async () => {
    const entities = showEntities(await silverDollarCity().getEntities());
    const pickers = entities.find((e: any) => e.id === 'afa2cd9f-3b39-46c8-ae3e-7a683f8da1eb');
    expect(pickers.name).toBe('Homestead Pickers');
  });

  test('an act published on one stage carries it when the feed lists the title on another', async () => {
    const entities = showEntities(await silverDollarCity().getEntities());
    const name = (id: string) => entities.find((e: any) => e.id === id)?.name;
    expect(name('f133f71e-15cd-4575-b101-56a6546dda42')).toBe('Horse Creek Band (Gazebo Stage)');
    expect(name('13b075b1-4b37-460d-8ef6-2fc79a209192')).toBe('The Creek Rocks (Gazebo Stage)');
    expect(name('8e7dfd0d-8978-46ca-be45-5a02de0318c2')).toBe('Dawson Hollow (Dockside Theater)');
  });

  test('the folded entity takes its location from the canonical record', async () => {
    const entities = showEntities(await silverDollarCity().getEntities());
    const gazebo = entities.find((e: any) => e.id === ARBOUR_GAZEBO_SPRING);
    expect(gazebo.location).toEqual({latitude: 36.668156, longitude: -93.339903});
  });

  test('when the Boatworks copy leaves the schedule, the Gazebo entity keeps its id and its name', async () => {
    // Seasonal: the Boatworks copy is only listed while it plays.
    const entities = showEntities(await silverDollarCity([day('2026-11-20')]).getEntities());
    const arbour = entities.filter((e: any) => e.name.startsWith('Arbour Season'));
    expect(arbour.map((e: any) => e.id)).toEqual([ARBOUR_GAZEBO_SPRING]);
    expect(arbour[0].name).toBe('Arbour Season (Gazebo Stage)');
  });

  test('with the schedule unavailable, categorised records are still folded', async () => {
    const park = silverDollarCity();
    park.getSchedule = async () => { throw new Error('schedule down'); };
    const entities = showEntities(await park.getEntities());
    const arbour = entities.filter((e: any) => e.name.startsWith('Arbour Season'));
    expect(arbour.map((e: any) => e.id)).toEqual([ARBOUR_GAZEBO_SPRING]);
    expect(arbour[0].name).toBe('Arbour Season (Gazebo Stage)');
  });
});

// A published name is a visible rename whenever it changes, so it must not
// move with the schedule. Any record that is not categorised is published only while the
// schedule lists it (and one that is not published today would be, once it
// is). Move each of them in or out of the schedule and nothing else may be
// renamed.
describe('SilverDollarCity names do not move with the schedule', () => {
  const uncategorised = ACTIVITIES.filter(
    a => a.activityListId === SHOW_LIST && (a.activityCategories?.length ?? 0) === 0,
  );

  const scheduleWith = (change: {add?: string; remove?: string}) => {
    const ids = new Set(SCHEDULED_IN_CAPTURE);
    if (change.add) ids.add(change.add);
    if (change.remove) ids.delete(change.remove);
    return [day('2026-09-18', Object.fromEntries([...ids].map(id => [id, [{from: '17:30:00'}]])))];
  };

  const published = async (days: unknown[]) =>
    new Map<string, string>(
      showEntities(await silverDollarCity(days).getEntities()).map((e: any) => [e.id, e.name]),
    );

  const toggle = (id: string) =>
    SCHEDULED_IN_CAPTURE.includes(id) ? {remove: id} : {add: id};

  test('the captured payload has uncategorised records on both sides of the schedule', () => {
    const scheduled = uncategorised.filter(a => SCHEDULED_IN_CAPTURE.includes(a.id));
    expect(scheduled.length).toBeGreaterThan(3);
    expect(uncategorised.length - scheduled.length).toBeGreaterThan(10);
  });

  test.each(uncategorised.map(a => [a.id, a.title]))(
    'moving %s (%s) in or out of the schedule renames no other show',
    async (id) => {
      const before = await published(scheduleWith({}));
      const after = await published(scheduleWith(toggle(id)));
      const renamed = [...before]
        .filter(([key, name]) => after.has(key) && after.get(key) !== name)
        .map(([key, name]) => `${name} -> ${after.get(key)}`);
      expect(renamed).toEqual([]);
    },
  );

  // The toggle has to bite for the check above to mean anything: these are the
  // records whose arrival or departure changes which stages are published.
  test.each([
    [ARBOUR_BOATWORKS, 'Arbour Season'],
    ['a602f762-1b7b-4e58-83e3-f7cc09e80b13', 'Casey & The Atta Boys'],
    ['fcd0a6c7-5a2a-49bb-9d4b-b61531e951ef', 'Horse Creek Band'],
    ['e0c02a9b-9838-4ecb-8b01-ce544836ee53', 'The Creek Rocks'],
    ['da0ce446-a160-4263-b94d-18e3485a45f7', 'The Creek Rocks'],
    ['26bee96c-a051-4cfb-9531-ed064a19dcc4', 'Dawson Hollow'],
  ])('%s (%s) changes what is published when it moves', async (id) => {
    const before = await published(scheduleWith({}));
    const after = await published(scheduleWith(toggle(id)));
    expect([...after.keys()].sort()).not.toEqual([...before.keys()].sort());
  });
});

describe('SilverDollarCity show schedules', () => {
  const schedulesOf = async (park: any) => {
    const all = await park.getSchedules();
    return new Map<string, any[]>(all.map((s: any) => [s.id, s.schedule]));
  };

  const DAYS = [
    day('2026-09-18', {
      // The spring copy plays 14:00 for 30 minutes (its record's duration);
      // the Christmas copy plays 11:00 and the same 14:00 slot, 15 minutes.
      [ARBOUR_GAZEBO_SPRING]: [{from: '14:00:00'}],
      [ARBOUR_GAZEBO_XMAS]: [{from: '14:00:00'}, {from: '11:00:00'}],
      [ARBOUR_BOATWORKS]: [{from: '17:30:00'}],
    }),
    day('2026-09-19', {[ARBOUR_GAZEBO_XMAS]: [{from: '11:00:00', to: '11:20:00'}]}),
  ];

  test('both Gazebo copies show their times on the one entity', async () => {
    const schedules = await schedulesOf(silverDollarCity(DAYS));
    const gazebo = schedules.get(ARBOUR_GAZEBO_SPRING)!;
    expect(gazebo.map(s => s.openingTime.slice(0, 16))).toEqual([
      '2026-09-18T11:00',
      '2026-09-18T14:00',
      '2026-09-19T11:00',
    ]);
  });

  test('a slot both copies list is published once', async () => {
    const gazebo = (await schedulesOf(silverDollarCity(DAYS))).get(ARBOUR_GAZEBO_SPRING)!;
    const at14 = gazebo.filter(s => s.openingTime.startsWith('2026-09-18T14:00'));
    expect(at14).toHaveLength(1);
  });

  test('each time keeps the duration of the record it came from', async () => {
    const gazebo = (await schedulesOf(silverDollarCity(DAYS))).get(ARBOUR_GAZEBO_SPRING)!;
    const mins = (s: any) => (Date.parse(s.closingTime) - Date.parse(s.openingTime)) / 60000;
    // 11:00 comes only from the Christmas copy (15 Minutes); the 19th has an
    // explicit end, 20 minutes.
    expect(mins(gazebo.find(s => s.openingTime.startsWith('2026-09-18T11:00')))).toBe(15);
    expect(mins(gazebo.find(s => s.openingTime.startsWith('2026-09-19T11:00')))).toBe(20);
  });

  test('where both copies list one start, the canonical record\'s duration wins', async () => {
    const gazebo = (await schedulesOf(silverDollarCity(DAYS))).get(ARBOUR_GAZEBO_SPRING)!;
    const at14 = gazebo.find(s => s.openingTime.startsWith('2026-09-18T14:00'))!;
    // The spring copy (30 Minutes) is canonical; the Christmas copy says 15.
    expect((Date.parse(at14.closingTime) - Date.parse(at14.openingTime)) / 60000).toBe(30);
  });

  test('the folded-away id gets no schedule of its own', async () => {
    const schedules = await schedulesOf(silverDollarCity(DAYS));
    expect(schedules.has(ARBOUR_GAZEBO_XMAS)).toBe(false);
    expect(schedules.has(ARBOUR_BOATWORKS)).toBe(true);
  });

  test('every show schedule belongs to a published entity', async () => {
    const park = silverDollarCity(DAYS);
    const entityIds = new Set((await park.getEntities()).map((e: any) => e.id));
    const orphans = [...(await schedulesOf(park)).keys()].filter(id => !entityIds.has(id));
    expect(orphans).toEqual([]);
  });

  test('a different stage is not merged into the Gazebo entity', async () => {
    const schedules = await schedulesOf(silverDollarCity(DAYS));
    const boatworks = schedules.get(ARBOUR_BOATWORKS)!;
    expect(boatworks).toHaveLength(1);
    expect(boatworks[0].openingTime.startsWith('2026-09-18T17:30')).toBe(true);
  });
});

describe('SilverDollarCity live data', () => {
  test('a show never gets a live row, folded or not', async () => {
    vi.useFakeTimers({toFake: ['Date']});
    vi.setSystemTime(new Date('2026-09-18T18:00:00Z'));
    const park = silverDollarCity();
    park.getWaitTimes = async () => [
      {rideId: null, rideName: 'Arbour Season', operationStatus: 'OPEN', waitTime: 5, waitTimeDisplay: ''},
    ];
    expect(await park.getLiveData()).toEqual([]);
  });
});

describe('parks that did not opt in', () => {
  const dollywoodShows = [
    show('11111111-0000-4000-8000-000000000001', 'Mountain Highway', {
      showVenueLocation: '22222222-0000-4000-8000-000000000001',
      activityListId: 'b9acfd27-0545-4bb2-a6e8-072fda3b06dd',
    }),
    show('11111111-0000-4000-8000-000000000002', 'Mountain Highway', {
      showVenueLocation: '22222222-0000-4000-8000-000000000002',
      activityListId: 'b9acfd27-0545-4bb2-a6e8-072fda3b06dd',
    }),
    show('11111111-0000-4000-8000-000000000003', 'Mountain Highway', {
      showVenueLocation: '22222222-0000-4000-8000-000000000002',
      activityListId: 'b9acfd27-0545-4bb2-a6e8-072fda3b06dd',
    }),
  ];

  test('Dollywood keeps every record as its own entity under the feed title', async () => {
    const park: any = new Dollywood();
    park.getActivities = async () => dollywoodShows;
    park.getSchedule = async () => [];
    const entities = showEntities(await park.getEntities());
    expect(entities.map((e: any) => e.id).sort()).toEqual(dollywoodShows.map(s => s.id).sort());
    expect(entities.every((e: any) => e.name === 'Mountain Highway')).toBe(true);
  });

  test('the same records in Silver Dollar City do fold, so the opt-in is what differs', async () => {
    const sdcShows = dollywoodShows.map(s => ({...s, activityListId: SHOW_LIST}));
    const venues = ['22222222-0000-4000-8000-000000000001', '22222222-0000-4000-8000-000000000002']
      .map((id, i) => show(id, i === 0 ? 'Back Porch Theater' : 'Valley Theater', {
        activityListId: 'venues',
        activityCategories: ['Venues'],
      }));
    const park = silverDollarCity([], [...venues, ...sdcShows]);
    const entities = showEntities(await park.getEntities());
    expect(entities).toHaveLength(2);
    expect(entities.map((e: any) => e.name).sort()).toEqual([
      'Mountain Highway (Back Porch Theater)',
      'Mountain Highway (Valley Theater)',
    ]);
  });
});

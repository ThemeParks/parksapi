/**
 * Unit tests for Ocean Park Hong Kong.
 *
 * The mobile app's API (sop.oceanpark.com.hk) was suspended along with the
 * app; this park now scrapes the public website's server-rendered pages.
 * These tests exercise the pure parsing helpers and the entity/live-data/
 * schedule builders offline, without hitting the real site. Full integration
 * is exercised via `npm run dev -- oceanparkhongkong`.
 */
import {describe, test, expect, vi, beforeEach, afterEach} from 'vitest';
import {
  OceanParkHongKong,
  extractRscArray,
  findMatchingBracket,
  slugFromUrl,
  slugify,
  groupShowsBySlug,
  parseQueueMinutes,
  parseHourRange,
  addDaysToDateString,
  computeAffineTransform,
} from '../oceanpark.js';

const TZ = 'Asia/Hong_Kong';

// ── extractRscArray / findMatchingBracket ────────────────────────────────────

describe('findMatchingBracket', () => {
  test('finds the matching close bracket for a simple array', () => {
    const str = '[1,2,3]tail';
    expect(findMatchingBracket(str, 0, '[', ']')).toBe(7);
  });

  test('ignores brackets that appear inside a quoted string', () => {
    const str = '[1,"a[b]c",3]tail';
    expect(findMatchingBracket(str, 0, '[', ']')).toBe(13);
  });

  test('honours escaped quotes so a string does not end early', () => {
    // The string value is: a"[not a real close]
    const str = String.raw`[1,"a\"[not a real close]",3]TAIL`;
    const end = findMatchingBracket(str, 0, '[', ']');
    expect(str.slice(end)).toBe('TAIL');
  });

  test('returns -1 when the bracket never closes', () => {
    expect(findMatchingBracket('[1,2,3', 0, '[', ']')).toBe(-1);
  });

  test('an escaped backslash immediately before a real closing quote does not extend the string', () => {
    // The string value is: a\  (a, then a literal backslash) — the quote right
    // after it is real and closes the string, so the following `]` is
    // structural, not part of the string content.
    const str = String.raw`[1,"a\\",3]TAIL`;
    const end = findMatchingBracket(str, 0, '[', ']');
    expect(str.slice(end)).toBe('TAIL');
  });
});

/**
 * Wrap decoded page content as a Next.js flight script chunk, letting
 * JSON.stringify handle the escaping (exactly as the real page does) instead
 * of hand-writing backslashes in fixtures.
 */
function wrapPush(decodedContent: string): string {
  return `<script>self.__next_f.push([1,${JSON.stringify(decodedContent)}])</script>`;
}

describe('extractRscArray', () => {
  test('extracts an array embedded in a single push() chunk', () => {
    const html = wrapPush('preamble junk\n"items":[{"nodeId":"abc"}]tail');
    const arr = extractRscArray(html, '"items":');
    expect(arr).toEqual([{nodeId: 'abc'}]);
  });

  test('skips non-matching push() chunks and finds the marker in a later one', () => {
    const html = wrapPush('unrelated chunk with no marker') +
      wrapPush('"items":[{"nodeId":"xyz"}]');
    const arr = extractRscArray(html, '"items":');
    expect(arr).toEqual([{nodeId: 'xyz'}]);
  });

  test('handles description text containing raw brackets without breaking the parse', () => {
    const html = wrapPush('"items":[{"description":"See the [Summit] show","nodeId":"1"}]');
    const arr = extractRscArray(html, '"items":') as any[];
    expect(arr).toHaveLength(1);
    expect(arr[0].description).toBe('See the [Summit] show');
  });

  test('returns null when there is no self.__next_f.push at all', () => {
    expect(extractRscArray('<html><body>no rsc here</body></html>', '"items":')).toBeNull();
  });

  test('returns null when the marker is never found', () => {
    const html = wrapPush(String.raw`"nothingHere":[1,2,3]`);
    expect(extractRscArray(html, '"items":')).toBeNull();
  });

  test('a validate callback rejects a same-named marker from the wrong widget and keeps scanning', () => {
    // First chunk's "items" array is a nav/breadcrumb list, not the target
    // shape; a validator checking for the expected key should skip it and
    // find the real one in a later chunk.
    const html = wrapPush('"items":[{"label":"Home"}]') +
      wrapPush('"items":[{"nodeId":"abc"}]');
    const arr = extractRscArray(html, '"items":', (a) => a.length === 0 || (typeof a[0] === 'object' && a[0] !== null && 'nodeId' in (a[0] as object)));
    expect(arr).toEqual([{nodeId: 'abc'}]);
  });

  test('caps scanning on a document larger than the size limit', () => {
    const huge = 'x'.repeat(2_000_001) + wrapPush('"items":[{"nodeId":"abc"}]');
    expect(extractRscArray(huge, '"items":')).toBeNull();
  });

  test('does not hang on many unterminated push() occurrences (quadratic-scan guard)', () => {
    // 500 unterminated push() calls back to back — well past MAX_PUSH_ATTEMPTS.
    // Without the attempt cap this would rescan to end-of-string 500 times.
    const malformed = 'self.__next_f.push(['.repeat(500);
    const start = Date.now();
    expect(extractRscArray(malformed, '"items":')).toBeNull();
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

// ── slugFromUrl / slugify ─────────────────────────────────────────────────

describe('slugFromUrl', () => {
  test('returns the last path segment', () => {
    expect(slugFromUrl('https://www.oceanpark.com.hk/en/a-day-at-the-park/attractions/arctic-blast'))
      .toBe('arctic-blast');
  });

  test('ignores a trailing slash', () => {
    expect(slugFromUrl('https://www.oceanpark.com.hk/en/a-day-at-the-park/dining-shopping/shopping/'))
      .toBe('shopping');
  });

  test('strips a query string before taking the last segment', () => {
    expect(slugFromUrl('https://www.oceanpark.com.hk/en/a-day-at-the-park/attractions/arctic-blast?utm=nav'))
      .toBe('arctic-blast');
  });

  test('strips a fragment before taking the last segment', () => {
    expect(slugFromUrl('https://www.oceanpark.com.hk/en/a-day-at-the-park/attractions/arctic-blast#reviews'))
      .toBe('arctic-blast');
  });
});

describe('slugify', () => {
  test('lowercases and hyphenates spaces/punctuation', () => {
    expect(slugify('Whiskers and Friends Meet (near Waterfront Gift Shop)'))
      .toBe('whiskers-and-friends-meet-near-waterfront-gift-shop');
  });

  test('strips accents', () => {
    expect(slugify('Café Ánimé')).toBe('cafe-anime');
  });

  test('trims leading/trailing hyphens produced by punctuation at the edges', () => {
    expect(slugify('"Marine Wonders"')).toBe('marine-wonders');
  });

  test('returns an empty string for punctuation-only input', () => {
    expect(slugify('!!!')).toBe('');
  });

  test('returns an empty string for empty input', () => {
    expect(slugify('')).toBe('');
  });
});

describe('groupShowsBySlug', () => {
  test('groups identical titles together under one slug', () => {
    const groups = groupShowsBySlug([
      {title: 'All Star Jam', timeSlot: ['11:00:00']},
      {title: 'All Star Jam', timeSlot: ['15:30:00']},
    ]);
    expect(groups.size).toBe(1);
    expect(groups.get('all-star-jam')!.items).toHaveLength(2);
  });

  test('two distinct titles that collide on slug keep only the first, and drop the second', () => {
    const groups = groupShowsBySlug([
      {title: 'Whiskers & Friends', timeSlot: ['11:00:00']},
      {title: 'Whiskers, Friends', timeSlot: ['15:00:00']},
    ]);
    // Both normalize to "whiskers-friends" — only one group must survive,
    // never two entries silently sharing the same id.
    expect(groups.size).toBe(1);
    expect(groups.get('whiskers-friends')!.title).toBe('Whiskers & Friends');
    expect(groups.get('whiskers-friends')!.items).toHaveLength(1);
  });

  test('a title that normalizes to an empty slug is dropped entirely', () => {
    const groups = groupShowsBySlug([{title: '!!!', timeSlot: ['11:00:00']}]);
    expect(groups.size).toBe(0);
  });

  test('distinct titles with distinct slugs both survive', () => {
    const groups = groupShowsBySlug([
      {title: 'All Star Jam', timeSlot: ['11:00:00']},
      {title: 'Animal Fun Talk', timeSlot: ['12:00:00']},
    ]);
    expect(groups.size).toBe(2);
  });
});

// ── parseQueueMinutes ─────────────────────────────────────────────────────

describe('parseQueueMinutes', () => {
  test('parses a normal wait', () => {
    expect(parseQueueMinutes(' 10  mins')).toBe(10);
  });

  test('parses zero distinctly from null (walk right on, not "no data")', () => {
    expect(parseQueueMinutes(' 0  mins')).toBe(0);
  });

  test('returns null for an explicit null (no queue mechanic / no signal)', () => {
    expect(parseQueueMinutes(null)).toBeNull();
  });

  test('returns null for undefined', () => {
    expect(parseQueueMinutes(undefined)).toBeNull();
  });

  test('returns null for text with no number', () => {
    expect(parseQueueMinutes('Closed')).toBeNull();
  });

  test('does not mistake an unrelated digit for a wait time', () => {
    // A status like "Reopens at 5pm" has a digit but isn't a wait-time
    // reading; only a number directly adjacent to "min" counts.
    expect(parseQueueMinutes('Reopens at 5pm')).toBeNull();
  });
});

// ── parseHourRange ────────────────────────────────────────────────────────

describe('parseHourRange', () => {
  test('parses a standard am-pm range to 24h', () => {
    expect(parseHourRange('10:00 am - 7:00 pm')).toEqual({open: '10:00', close: '19:00'});
  });

  test('handles 12:00 pm (noon) correctly', () => {
    expect(parseHourRange('12:00 pm - 8:30 pm')).toEqual({open: '12:00', close: '20:30'});
  });

  test('handles 12:00 am (midnight) correctly', () => {
    expect(parseHourRange('12:00 am - 6:00 am')).toEqual({open: '00:00', close: '06:00'});
  });

  test('returns null for an empty string (unpublished / closed day)', () => {
    expect(parseHourRange('')).toBeNull();
  });

  test('returns null for unparseable text', () => {
    expect(parseHourRange('Temporarily Closed')).toBeNull();
  });

  test('parses an overnight range with no day-rollover awareness (caller\'s job to roll it)', () => {
    // parseHourRange itself is date-agnostic — it just converts each side to
    // 24h. Rolling the close time to the next calendar date is buildSchedules'
    // responsibility (covered in the buildSchedules describe block below).
    expect(parseHourRange('6:00 pm - 12:30 am')).toEqual({open: '18:00', close: '00:30'});
  });
});

describe('addDaysToDateString', () => {
  test('adds days within the same month', () => {
    expect(addDaysToDateString('2026-07-07', 3)).toBe('2026-07-10');
  });

  test('rolls over a month boundary', () => {
    expect(addDaysToDateString('2026-07-31', 1)).toBe('2026-08-01');
  });

  test('rolls over a year boundary', () => {
    expect(addDaysToDateString('2026-12-31', 1)).toBe('2027-01-01');
  });

  test('adding zero days returns the same date', () => {
    expect(addDaysToDateString('2026-07-07', 0)).toBe('2026-07-07');
  });
});

// ── computeAffineTransform ────────────────────────────────────────────────

describe('computeAffineTransform', () => {
  test('recovers an exact linear mapping from noiseless reference points', () => {
    // lat = 0.001*x + 0*y + 22, lng = 0*x + 0.001*y + 114
    const refPoints = [
      {pixelX: 0, pixelY: 0, latitude: 22, longitude: 114},
      {pixelX: 1000, pixelY: 0, latitude: 23, longitude: 114},
      {pixelX: 0, pixelY: 1000, latitude: 22, longitude: 115},
      {pixelX: 1000, pixelY: 1000, latitude: 23, longitude: 115},
    ];
    const coeffs = computeAffineTransform(refPoints)!;
    expect(coeffs).toBeDefined();
    const lat = coeffs.a * 500 + coeffs.b * 500 + coeffs.c;
    const lng = coeffs.d * 500 + coeffs.e * 500 + coeffs.f;
    expect(lat).toBeCloseTo(22.5, 6);
    expect(lng).toBeCloseTo(114.5, 6);
  });

  test('returns null for collinear (degenerate) reference points', () => {
    const refPoints = [
      {pixelX: 0, pixelY: 0, latitude: 22, longitude: 114},
      {pixelX: 1, pixelY: 1, latitude: 22.1, longitude: 114.1},
      {pixelX: 2, pixelY: 2, latitude: 22.2, longitude: 114.2},
    ];
    expect(computeAffineTransform(refPoints)).toBeNull();
  });
});

// ── Class builders (stubbed network layer) ───────────────────────────────────

type CoordEntry = [string, {latitude: number; longitude: number}];

class Probe extends OceanParkHongKong {
  private readonly _attractions: any[];
  private readonly _diningTabs: any[];
  private readonly _scheduleItems: any[];
  private readonly _hoursByDate: Record<string, string | null>;
  private readonly _coordEntries: CoordEntry[];

  constructor(opts: {
    attractions?: any[];
    diningTabs?: any[];
    scheduleItems?: any[];
    hoursByDate?: Record<string, string | null>;
    coordEntries?: CoordEntry[];
  } = {}) {
    super();
    this._attractions = opts.attractions ?? [];
    this._diningTabs = opts.diningTabs ?? [];
    this._scheduleItems = opts.scheduleItems ?? [];
    this._hoursByDate = opts.hoursByDate ?? {};
    this._coordEntries = opts.coordEntries ?? [];
  }

  override async getAttractionItems(): Promise<any[]> {
    return this._attractions;
  }

  override async getDiningTabs(): Promise<any[]> {
    return this._diningTabs;
  }

  override async getDailyScheduleItems(_date: string): Promise<any[]> {
    return this._scheduleItems;
  }

  override async getParkOpeningHoursValue(date: string): Promise<string | null> {
    return this._hoursByDate[date] ?? null;
  }

  override async getCoordinateMapEntries(): Promise<CoordEntry[]> {
    return this._coordEntries;
  }

  public entities(): Promise<any[]> {
    return (this as any).buildEntityList();
  }

  public liveData(): Promise<any[]> {
    return (this as any).buildLiveData();
  }

  public schedules(): Promise<any[]> {
    return (this as any).buildSchedules();
  }
}

const mkAttraction = (overrides: Partial<any> = {}) => ({
  nodeId: 'node-1',
  nodeUrl: {label: 'Arctic Blast', url: 'https://www.oceanpark.com.hk/en/a-day-at-the-park/attractions/arctic-blast'},
  attractionTypes: [{id: 'thrill-rides', label: 'Thrill Rides'}],
  height: {min: 0, max: 300},
  queueTime: {text: ' 10  mins'},
  ...overrides,
});

describe('buildEntityList', () => {
  test('maps a ride attraction with a real height restriction', async () => {
    const probe = new Probe({
      attractions: [mkAttraction({height: {min: 100, max: 300}})],
    });
    const entities = await probe.entities();
    const attraction = entities.find((e) => e.id === 'attraction_node-1');
    expect(attraction).toBeDefined();
    expect(attraction.name).toBe('Arctic Blast');
    expect(attraction.attractionType).toBe('RIDE');
    expect(attraction.tags).toHaveLength(1);
    expect(attraction.tags[0].tag).toBe('MINIMUM_HEIGHT');
  });

  test('classifies in-park-transportation as TRANSPORT', async () => {
    const probe = new Probe({
      attractions: [mkAttraction({
        nodeId: 'node-2',
        attractionTypes: [{id: 'in-park-transportation', label: 'In-park Transportation'}],
      })],
    });
    const entities = await probe.entities();
    const attraction = entities.find((e) => e.id === 'attraction_node-2');
    expect(attraction.attractionType).toBe('TRANSPORT');
  });

  test('does not tag min/max height at the "no restriction" sentinel (0 / 300)', async () => {
    const probe = new Probe({attractions: [mkAttraction({height: {min: 0, max: 300}})]});
    const entities = await probe.entities();
    const attraction = entities.find((e) => e.id === 'attraction_node-1');
    expect(attraction.tags).toBeUndefined();
  });

  test('tags a real maximum height restriction', async () => {
    const probe = new Probe({attractions: [mkAttraction({height: {min: 0, max: 150}})]});
    const entities = await probe.entities();
    const attraction = entities.find((e) => e.id === 'attraction_node-1');
    expect(attraction.tags).toHaveLength(1);
    expect(attraction.tags[0].tag).toBe('MAXIMUM_HEIGHT');
  });

  test('defaults to RIDE when attractionTypes is empty', async () => {
    const probe = new Probe({attractions: [mkAttraction({attractionTypes: []})]});
    const entities = await probe.entities();
    const attraction = entities.find((e) => e.id === 'attraction_node-1');
    expect(attraction.attractionType).toBe('RIDE');
  });

  test('defaults to RIDE when attractionTypes is missing entirely', async () => {
    const {attractionTypes, ...rest} = mkAttraction();
    const probe = new Probe({attractions: [rest]});
    const entities = await probe.entities();
    const attraction = entities.find((e) => e.id === 'attraction_node-1');
    expect(attraction.attractionType).toBe('RIDE');
  });

  test('skips an attraction item missing nodeUrl instead of crashing the whole build', async () => {
    const {nodeUrl, ...malformed} = mkAttraction();
    const probe = new Probe({
      attractions: [malformed, mkAttraction({nodeId: 'node-2', nodeUrl: {label: 'Bumper Blaster', url: '.../bumper-blaster'}})],
    });
    const entities = await probe.entities();
    expect(entities.find((e) => e.id === 'attraction_node-1')).toBeUndefined();
    expect(entities.find((e) => e.id === 'attraction_node-2')).toBeDefined();
  });

  test('skips an attraction item missing nodeId instead of producing an "attraction_undefined" id', async () => {
    const {nodeId, ...malformed} = mkAttraction();
    const probe = new Probe({attractions: [malformed]});
    const entities = await probe.entities();
    expect(entities.find((e) => e.entityType === 'ATTRACTION')).toBeUndefined();
  });

  test('skips a restaurant item missing nodeUrl instead of crashing the whole build', async () => {
    const probe = new Probe({
      diningTabs: [{
        tab: {id: 'restaurants', label: 'Restaurants'},
        pageItems: [
          {} as any,
          {nodeUrl: {label: "Neptune's Restaurant", url: '.../neptune-s-restaurant'}},
        ],
      }],
    });
    const entities = await probe.entities();
    const restaurants = entities.filter((e) => e.entityType === 'RESTAURANT');
    expect(restaurants).toHaveLength(1);
    expect(restaurants[0].name).toBe("Neptune's Restaurant");
  });

  test('restaurant coordinates join by URL slug and fall back to the default when unmatched', async () => {
    const probe = new Probe({
      diningTabs: [{
        tab: {id: 'restaurants', label: 'Restaurants'},
        pageItems: [{nodeUrl: {label: "Neptune's Restaurant", url: 'https://www.oceanpark.com.hk/en/a-day-at-the-park/dining-shopping/restaurants/neptune-s-restaurant'}}],
      }],
      coordEntries: [['neptune-s-restaurant', {latitude: 3, longitude: 4}]],
    });
    const entities = await probe.entities();
    const restaurant = entities.find((e) => e.entityType === 'RESTAURANT');
    expect(restaurant.location).toEqual({latitude: 3, longitude: 4});
  });

  test('restaurant falls back to the default location when no coordinate match exists', async () => {
    const probe = new Probe({
      diningTabs: [{
        tab: {id: 'restaurants', label: 'Restaurants'},
        pageItems: [{nodeUrl: {label: "Neptune's Restaurant", url: 'https://www.oceanpark.com.hk/en/a-day-at-the-park/dining-shopping/restaurants/neptune-s-restaurant'}}],
      }],
      coordEntries: [],
    });
    const entities = await probe.entities();
    const restaurant = entities.find((e) => e.entityType === 'RESTAURANT');
    expect(restaurant.location.latitude).toBeCloseTo(22.2465, 4);
  });

  test('show coordinates join by slugified title and fall back to the default when unmatched', async () => {
    const probe = new Probe({
      scheduleItems: [{title: 'All Star Jam', timeSlot: ['11:00:00']}],
      coordEntries: [['all-star-jam', {latitude: 5, longitude: 6}]],
    });
    const entities = await probe.entities();
    const show = entities.find((e) => e.entityType === 'SHOW');
    expect(show.location).toEqual({latitude: 5, longitude: 6});
  });

  test('show falls back to the default location when no coordinate match exists', async () => {
    const probe = new Probe({
      scheduleItems: [{title: 'All Star Jam', timeSlot: ['11:00:00']}],
      coordEntries: [],
    });
    const entities = await probe.entities();
    const show = entities.find((e) => e.entityType === 'SHOW');
    expect(show.location.latitude).toBeCloseTo(22.2465, 4);
  });

  test('two shows whose titles collide on slug do not produce duplicate entity ids', async () => {
    const probe = new Probe({
      scheduleItems: [
        {title: 'Whiskers & Friends', timeSlot: ['11:00:00']},
        {title: 'Whiskers, Friends', timeSlot: ['15:00:00']},
      ],
    });
    const entities = await probe.entities();
    const shows = entities.filter((e) => e.entityType === 'SHOW');
    const ids = shows.map((e: any) => e.id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicate ids
    expect(shows).toHaveLength(1);
  });

  test('joins attraction coordinates by URL slug', async () => {
    const probe = new Probe({
      attractions: [mkAttraction()],
      coordEntries: [['arctic-blast', {latitude: 1, longitude: 2}]],
    });
    const entities = await probe.entities();
    const attraction = entities.find((e) => e.id === 'attraction_node-1');
    expect(attraction.location).toEqual({latitude: 1, longitude: 2});
  });

  test('falls back to the default location when no coordinate match exists', async () => {
    const probe = new Probe({attractions: [mkAttraction()], coordEntries: []});
    const entities = await probe.entities();
    const attraction = entities.find((e) => e.id === 'attraction_node-1');
    expect(attraction.location.latitude).toBeCloseTo(22.2465, 4);
  });

  test('only the "restaurants" tab becomes RESTAURANT entities; other tabs are ignored', async () => {
    const probe = new Probe({
      diningTabs: [
        {
          tab: {id: 'restaurants', label: 'Restaurants'},
          pageItems: [{nodeUrl: {label: "Neptune's Restaurant", url: 'https://www.oceanpark.com.hk/en/a-day-at-the-park/dining-shopping/restaurants/neptune-s-restaurant'}}],
        },
        {
          tab: {id: 'food-kiosks', label: 'Food Kiosks'},
          cardItems: [{title: 'Popcorn Cart'}],
        },
      ],
    });
    const entities = await probe.entities();
    const restaurants = entities.filter((e) => e.entityType === 'RESTAURANT');
    expect(restaurants).toHaveLength(1);
    expect(restaurants[0].id).toBe('restaurant_neptune-s-restaurant');
    expect(entities.find((e) => e.name === 'Popcorn Cart')).toBeUndefined();
  });

  test('shows are deduplicated by title and get a slugified id', async () => {
    const probe = new Probe({
      scheduleItems: [
        {title: 'All Star Jam', timeSlot: ['11:00:00']},
        {title: 'All Star Jam', timeSlot: ['15:30:00']},
      ],
    });
    const entities = await probe.entities();
    const shows = entities.filter((e) => e.entityType === 'SHOW');
    expect(shows).toHaveLength(1);
    expect(shows[0].id).toBe('show_all-star-jam');
  });

  test('always includes the PARK entity', async () => {
    // buildEntityList() never returns a DESTINATION entity — that comes from
    // getDestinations() below, merged in separately by the base class.
    const probe = new Probe();
    const entities = await probe.entities();
    const park = entities.find((e) => e.entityType === 'PARK');
    expect(park).toBeDefined();
    expect(park!.id).toBe('oceanpark');
  });

  test('an attractions-fetch failure degrades to zero attractions instead of throwing the whole build', async () => {
    const probe = new Probe({
      diningTabs: [{
        tab: {id: 'restaurants', label: 'Restaurants'},
        pageItems: [{nodeUrl: {label: "Neptune's Restaurant", url: '.../neptune-s-restaurant'}}],
      }],
    });
    (probe as any).getAttractionItems = () => Promise.reject(new Error('attractions page down'));

    const entities = await probe.entities();
    expect(entities.find((e) => e.entityType === 'ATTRACTION')).toBeUndefined();
    // The unrelated dining source still comes through.
    expect(entities.find((e) => e.entityType === 'RESTAURANT')).toBeDefined();
    expect(entities.find((e) => e.entityType === 'PARK')).toBeDefined();
  });

  test('a dining-fetch failure degrades to zero restaurants without losing attractions', async () => {
    const probe = new Probe({attractions: [mkAttraction()]});
    (probe as any).getDiningTabs = () => Promise.reject(new Error('dining page down'));

    const entities = await probe.entities();
    expect(entities.find((e) => e.entityType === 'RESTAURANT')).toBeUndefined();
    expect(entities.find((e) => e.id === 'attraction_node-1')).toBeDefined();
  });
});

describe('getDestinations', () => {
  test('returns a single DESTINATION entity with the expected id, type, and timezone', async () => {
    const probe = new Probe();
    const destinations = await probe.getDestinations();
    expect(destinations).toHaveLength(1);
    expect(destinations[0].id).toBe('oceanparkresort');
    expect(destinations[0].entityType).toBe('DESTINATION');
    expect(destinations[0].timezone).toBe(TZ);
  });
});

describe('buildLiveData', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Fixed at 2026-07-07T12:00:00+08:00 (noon HK, no DST) so a ±1h window
    // never crosses a calendar day boundary.
    vi.setSystemTime(new Date('2026-07-07T04:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('a numeric queueTime maps to OPERATING with that standby wait', async () => {
    const probe = new Probe({attractions: [mkAttraction({queueTime: {text: ' 10  mins'}})]});
    const live = await probe.liveData();
    const entry = live.find((l) => l.id === 'attraction_node-1');
    expect(entry.status).toBe('OPERATING');
    expect(entry.queue.STANDBY.waitTime).toBe(10);
  });

  test('a "0 mins" queueTime is OPERATING with a zero wait, not CLOSED', async () => {
    const probe = new Probe({attractions: [mkAttraction({queueTime: {text: ' 0  mins'}})]});
    const live = await probe.liveData();
    const entry = live.find((l) => l.id === 'attraction_node-1');
    expect(entry.status).toBe('OPERATING');
    expect(entry.queue.STANDBY.waitTime).toBe(0);
  });

  test('an explicit null queueTime (no queue mechanic / no signal) is CLOSED with no queue', async () => {
    const probe = new Probe({attractions: [mkAttraction({queueTime: null})]});
    const live = await probe.liveData();
    const entry = live.find((l) => l.id === 'attraction_node-1');
    expect(entry.status).toBe('CLOSED');
    expect(entry.queue).toBeUndefined();
  });

  test('a show with only future showtimes today is OPERATING and lists them', async () => {
    const probe = new Probe({
      scheduleItems: [{title: 'All Star Jam', timeSlot: ['13:00:00']}], // 1pm, after our noon "now"
    });
    const live = await probe.liveData();
    const entry = live.find((l) => l.id === 'show_all-star-jam');
    expect(entry.status).toBe('OPERATING');
    expect(entry.showtimes).toHaveLength(1);
    expect(entry.showtimes[0].startTime.startsWith('2026-07-07T13:00')).toBe(true);
  });

  test('a show with only past showtimes today is CLOSED with no showtimes', async () => {
    const probe = new Probe({
      scheduleItems: [{title: 'All Star Jam', timeSlot: ['11:00:00']}], // 11am, before our noon "now"
    });
    const live = await probe.liveData();
    const entry = live.find((l) => l.id === 'show_all-star-jam');
    expect(entry.status).toBe('CLOSED');
    expect(entry.showtimes).toBeUndefined();
  });

  test('a show with one past and one future slot keeps only the future one', async () => {
    const probe = new Probe({
      scheduleItems: [{title: 'All Star Jam', timeSlot: ['11:00:00', '13:00:00']}],
    });
    const live = await probe.liveData();
    const entry = live.find((l) => l.id === 'show_all-star-jam');
    expect(entry.status).toBe('OPERATING');
    expect(entry.showtimes).toHaveLength(1);
    expect(entry.showtimes[0].startTime.startsWith('2026-07-07T13:00')).toBe(true);
  });

  test('two shows colliding on slug do not clobber each other into one merged live-data row under one id', async () => {
    const probe = new Probe({
      scheduleItems: [
        {title: 'Whiskers & Friends', timeSlot: ['13:00:00']},
        {title: 'Whiskers, Friends', timeSlot: ['14:00:00']},
      ],
    });
    const live = await probe.liveData();
    const showEntries = live.filter((l) => l.id.startsWith('show_'));
    const ids = showEntries.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicate ids in the emitted array
  });

  test('a shows-fetch failure degrades to no show live data without losing attraction wait times', async () => {
    const probe = new Probe({attractions: [mkAttraction({queueTime: {text: ' 10  mins'}})]});
    (probe as any).getDailyScheduleItems = () => Promise.reject(new Error('daily schedule route down'));

    const live = await probe.liveData();
    expect(live.find((l) => l.id.startsWith('show_'))).toBeUndefined();
    const attraction = live.find((l) => l.id === 'attraction_node-1');
    expect(attraction.status).toBe('OPERATING');
    expect(attraction.queue.STANDBY.waitTime).toBe(10);
  });

  test('an attractions-fetch failure degrades to no attraction wait times without losing show live data', async () => {
    const probe = new Probe({scheduleItems: [{title: 'All Star Jam', timeSlot: ['13:00:00']}]});
    (probe as any).getAttractionItems = () => Promise.reject(new Error('attractions page down'));

    const live = await probe.liveData();
    expect(live.find((l) => l.id.startsWith('attraction_'))).toBeUndefined();
    const show = live.find((l) => l.id === 'show_all-star-jam');
    expect(show.status).toBe('OPERATING');
  });
});

describe('buildSchedules', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-07T04:00:00Z')); // noon HK
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('emits an OPERATING entry for a date with published hours', async () => {
    const probe = new Probe({hoursByDate: {'2026-07-07': '10:00 am - 7:00 pm'}});
    const scheds = await probe.schedules();
    const entry = scheds[0].schedule.find((s: any) => s.date === '2026-07-07');
    expect(entry).toBeDefined();
    expect(entry.type).toBe('OPERATING');
    expect(entry.openingTime.startsWith('2026-07-07T10:00')).toBe(true);
    expect(entry.closingTime.startsWith('2026-07-07T19:00')).toBe(true);
  });

  test('skips a date with no published hours (empty string) rather than emitting a bogus entry', async () => {
    const probe = new Probe({hoursByDate: {'2026-07-07': ''}});
    const scheds = await probe.schedules();
    expect(scheds[0].schedule.find((s: any) => s.date === '2026-07-07')).toBeUndefined();
  });

  test('skips a date with no data at all (beyond the published window)', async () => {
    const probe = new Probe({hoursByDate: {}});
    const scheds = await probe.schedules();
    expect(scheds[0].schedule).toHaveLength(0);
  });

  test('rolls an overnight closing time to the next calendar date instead of before the opening time', async () => {
    const probe = new Probe({hoursByDate: {'2026-07-07': '6:00 pm - 12:30 am'}});
    const scheds = await probe.schedules();
    const entry = scheds[0].schedule.find((s: any) => s.date === '2026-07-07');
    expect(entry).toBeDefined();
    expect(entry.openingTime.startsWith('2026-07-07T18:00')).toBe(true);
    expect(entry.closingTime.startsWith('2026-07-08T00:30')).toBe(true);
    expect(new Date(entry.closingTime).getTime()).toBeGreaterThan(new Date(entry.openingTime).getTime());
  });

  test('a normal same-day range is not rolled forward (no regression)', async () => {
    const probe = new Probe({hoursByDate: {'2026-07-07': '10:00 am - 7:00 pm'}});
    const scheds = await probe.schedules();
    const entry = scheds[0].schedule.find((s: any) => s.date === '2026-07-07');
    expect(entry.closingTime.startsWith('2026-07-07T19:00')).toBe(true);
  });

  test('logs a warning when a date has non-empty but unparseable hours text', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const probe = new Probe({hoursByDate: {'2026-07-07': '10:00 - 19:00'}}); // 24h format, not the expected am/pm
    const scheds = await probe.schedules();
    expect(scheds[0].schedule.find((s: any) => s.date === '2026-07-07')).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('2026-07-07'));
    warnSpy.mockRestore();
  });

  test('one failed date request degrades to fewer days instead of zeroing the entire schedule', async () => {
    const probe = new Probe({hoursByDate: {'2026-07-08': '10:00 am - 7:00 pm'}});
    const originalGet = probe.getParkOpeningHoursValue.bind(probe);
    (probe as any).getParkOpeningHoursValue = (date: string) => {
      if (date === '2026-07-07') return Promise.reject(new Error('transient 502'));
      return originalGet(date);
    };

    const scheds = await probe.schedules();
    expect(scheds[0].schedule.find((s: any) => s.date === '2026-07-07')).toBeUndefined();
    expect(scheds[0].schedule.find((s: any) => s.date === '2026-07-08')).toBeDefined();
  });
});

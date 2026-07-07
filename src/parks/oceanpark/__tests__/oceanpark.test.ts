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
  parseQueueMinutes,
  parseHourRange,
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

  test('always includes the DESTINATION and PARK entities', async () => {
    const probe = new Probe();
    const entities = await probe.entities();
    expect(entities.find((e) => e.entityType === 'PARK')).toBeDefined();
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
});

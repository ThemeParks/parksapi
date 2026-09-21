import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {Valleyfair} from '../valleyfair.js';
import {CacheLib} from '../../../cache.js';
import type {WithRaw} from '../../../destination.js';
import type {HTTPObj} from '../../../http.js';
import type {TribeEventsResponse} from '../enchantedparks.js';

/**
 * With `includeRaw` on, every live row carries the feed item its status came
 * from, every entity carries the listing stub it was scraped from, and every
 * schedule day carries its Tribe event — or, when the REST endpoint lists
 * nothing, the VEVENT block of the iCal fallback. The destination and the two
 * parks come from configuration and carry nothing. Off, nothing carries
 * anything.
 */
const NOW = new Date('2026-09-21T15:00:00Z');
const SITE = '146a4170-9ef0-4fbd-936f-1d1544c8ce88';

// Rows of the live feed's `listFeatures.items`, in the feed's own field names
const wildThingItem = {name: 'VF - Wild Thing', parentAssignmentId: SITE, operationalStatus: 'Open'};
const renegadeItem = {name: 'VF - Renegade', parentAssignmentId: SITE, operationalStatus: 'Temporarily Closed'};
const cascadeItem = {name: 'VFW - Cascade Falls', parentAssignmentId: SITE, operationalStatus: 'Closed'};
const ticketSalesItem = {name: 'VF - Ticket Sales', parentAssignmentId: SITE, operationalStatus: 'Open'};

// Stubs of the listing pages. The master rides page repeats the waterpark ride,
// which the waterpark page has already claimed.
const cascadeStub = {slug: 'cascade-falls', name: 'Cascade Falls'};
const cascadeStubOnRidesPage = {slug: 'cascade-falls', name: 'Cascade Falls'};
const wildThingStub = {slug: 'wild-thing', name: 'Wild Thing'};
const renegadeStub = {slug: 'renegade', name: 'Renegade'};
const diningStub = {slug: 'pizza-stop', name: 'Pizza Stop'};
const showStub = {slug: 'high-dive-show', name: 'High Dive Show'};

const parkHoursEvent = {
  start_date: '2026-09-21 10:00:00',
  end_date: '2026-09-21 20:00:00',
  all_day: false,
  categories: [{name: 'Park Hours'}],
};
const waterparkHoursEvent = {
  start_date: '2026-09-21 11:00:00',
  end_date: '2026-09-21 18:00:00',
  all_day: false,
  categories: [{name: 'Waterpark Hours'}],
};
const tribeEvents: TribeEventsResponse = {events: [parkHoursEvent, waterparkHoursEvent], total_pages: 1};

// The VEVENT block the iCal parser works on: everything between its BEGIN and
// END lines.
const parkHoursBlock = [
  '',
  'DTSTART;TZID=America/Chicago:20260922T100000',
  'DTEND;TZID=America/Chicago:20260922T200000',
  'CATEGORIES:Park Hours',
  'SUMMARY:Park Hours',
  '',
].join('\n');
const iCalFeed = `BEGIN:VCALENDAR\nBEGIN:VEVENT${parkHoursBlock}END:VEVENT\nEND:VCALENDAR\n`;

function stubbedPark(includeRaw: boolean, tribeResponse: TribeEventsResponse = tribeEvents): Valleyfair {
  const park = new Valleyfair();
  park.includeRaw = includeRaw;
  (park as any).subdomain = 'https://valleyfair.example.invalid';
  (park as any).liveStatusEndpoint = 'https://example.invalid/graphql';
  (park as any).liveStatusApiKey = 'test-key';
  vi.spyOn(park as any, 'fetchFeatures').mockResolvedValue({
    json: async () => ({
      data: {
        listFeatures: {
          items: [wildThingItem, renegadeItem, cascadeItem, ticketSalesItem],
          nextToken: null,
        },
      },
    }),
  } as any as HTTPObj);
  vi.spyOn(park as any, 'scrapeAttractions').mockImplementation(async (ridesPath: any) =>
    ridesPath === 'superior-shores-waterpark'
      ? [cascadeStub]
      : [wildThingStub, renegadeStub, cascadeStubOnRidesPage]);
  vi.spyOn(park as any, 'scrapeDining').mockResolvedValue([diningStub]);
  vi.spyOn(park as any, 'scrapeShows').mockResolvedValue([showStub]);
  vi.spyOn(park as any, 'fetchTribeEvents').mockResolvedValue({
    json: async () => tribeResponse,
  } as any as HTTPObj);
  vi.spyOn(park as any, 'fetchICalFeed').mockResolvedValue({
    text: async () => iCalFeed,
  } as any as HTTPObj);
  return park;
}

const rawOf = (element: object) => (element as WithRaw<object>).raw;

describe('Enchanted Parks raw upstream pieces', () => {
  beforeEach(() => {
    CacheLib.clear();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    CacheLib.clear();
  });

  it('attaches the feed item to each live row', async () => {
    const live = await stubbedPark(true).getLiveData();
    // The waterpark rides come first, then the master page's rides minus the
    // waterpark ones. Ticket Sales matches no ride entity and is dropped.
    expect(live.map((l) => l.id)).toEqual([
      'enchantedparks_attraction_VFW_cascade-falls',
      'enchantedparks_attraction_VF_wild-thing',
      'enchantedparks_attraction_VF_renegade',
    ]);

    expect(live[0].status).toBe('CLOSED');
    expect(rawOf(live[0])).toEqual({features: cascadeItem});
    expect(rawOf(live[0])!.features).toBe(cascadeItem);

    expect(live[1].status).toBe('OPERATING');
    expect(rawOf(live[1])!.features).toBe(wildThingItem);

    expect(live[2].status).toBe('DOWN');
    expect(rawOf(live[2])!.features).toBe(renegadeItem);
  });

  it('attaches the listing stub to each entity, nothing to the parks or the destination', async () => {
    const entities = await stubbedPark(true).getEntities();
    const byId = new Map(entities.map((e) => [e.id, e]));

    // The waterpark page claimed the slug, so its stub is the piece behind the
    // entity and the master page's repeat produced nothing.
    const cascade = byId.get('enchantedparks_attraction_VFW_cascade-falls')!;
    expect(rawOf(cascade)).toEqual({attractionsPage: cascadeStub});
    expect(rawOf(cascade)!.attractionsPage).toBe(cascadeStub);
    expect(byId.has('enchantedparks_attraction_VF_cascade-falls')).toBe(false);

    const wildThing = byId.get('enchantedparks_attraction_VF_wild-thing')!;
    expect(wildThing.name).toBe('Wild Thing');
    expect(rawOf(wildThing)!.attractionsPage).toBe(wildThingStub);

    const pizzaStop = byId.get('enchantedparks_restaurant_VF_pizza-stop')!;
    expect(pizzaStop.entityType).toBe('RESTAURANT');
    expect(rawOf(pizzaStop)).toEqual({attractionsPage: diningStub});
    expect(rawOf(pizzaStop)!.attractionsPage).toBe(diningStub);

    const highDive = byId.get('enchantedparks_show_VF_high-dive-show')!;
    expect(highDive.entityType).toBe('SHOW');
    expect(rawOf(highDive)!.attractionsPage).toBe(showStub);

    for (const id of ['enchantedparks_valleyfair', 'enchantedparks_park_VF', 'enchantedparks_park_VFW']) {
      expect(rawOf(byId.get(id)!)).toBeUndefined();
    }
  });

  it('attaches the Tribe event to the day it produced', async () => {
    const schedules = await stubbedPark(true).getSchedules();
    expect(schedules.map((s) => s.id)).toEqual(['enchantedparks_park_VF', 'enchantedparks_park_VFW']);

    const [themePark, waterPark] = schedules;
    expect(themePark.schedule.map((d) => d.date)).toEqual(['2026-09-21']);
    expect(themePark.schedule[0].closingTime).toBe('2026-09-21T20:00:00-05:00');
    expect(rawOf(themePark.schedule[0])).toEqual({tribeEvents: parkHoursEvent});
    expect(rawOf(themePark.schedule[0])!.tribeEvents).toBe(parkHoursEvent);

    expect(waterPark.schedule[0].openingTime).toBe('2026-09-21T11:00:00-05:00');
    expect(rawOf(waterPark.schedule[0])!.tribeEvents).toBe(waterparkHoursEvent);
  });

  it('attaches the VEVENT block when the Tribe endpoint lists nothing', async () => {
    const park = stubbedPark(true, {events: [], total_pages: 1});
    const [themePark, waterPark] = await park.getSchedules();

    expect(themePark.schedule.map((d) => d.date)).toEqual(['2026-09-22']);
    expect(themePark.schedule[0].openingTime).toBe('2026-09-22T10:00:00-05:00');
    expect(rawOf(themePark.schedule[0])).toEqual({iCalFeed: parkHoursBlock});

    // Neither source carries the waterpark category.
    expect(waterPark.schedule).toEqual([]);
  });

  it('carries nothing when includeRaw is off', async () => {
    const park = stubbedPark(false);
    for (const element of await park.getLiveData()) expect(rawOf(element)).toBeUndefined();
    for (const element of await park.getEntities()) expect(rawOf(element)).toBeUndefined();
    for (const schedule of await park.getSchedules()) {
      for (const element of schedule.schedule) expect(rawOf(element)).toBeUndefined();
    }
  });
});

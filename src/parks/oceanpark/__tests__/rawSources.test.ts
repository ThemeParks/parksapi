import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {OceanParkHongKong} from '../oceanpark.js';
import type {WithRaw} from '../../../destination.js';

/**
 * With `includeRaw` on, every element carries the upstream piece it was
 * built from: the attractions-page card or dining-page card for its own
 * entity/live row, the daily-schedule rows of its show's group for a show
 * entity/live row, and the opening-hours text for a schedule day. Off,
 * nothing carries anything.
 */
const NOW = new Date('2026-09-21T04:00:00Z');

const attractionOpen = {
  nodeId: 'node-1',
  nodeUrl: {label: 'Arctic Blast', url: 'https://www.oceanpark.com.hk/en/a-day-at-the-park/attractions/arctic-blast'},
  attractionTypes: [{id: 'thrill-rides', label: 'Thrill Rides'}],
  height: {min: 100, max: 200},
  queueTime: {text: '15 mins'},
};

const attractionClosed = {
  nodeId: 'node-2',
  nodeUrl: {label: 'Bumper Blaster', url: 'https://www.oceanpark.com.hk/en/a-day-at-the-park/attractions/bumper-blaster'},
  attractionTypes: [] as {id: string}[],
  height: {min: 0, max: 300},
  queueTime: null,
};

const restaurantItem = {
  nodeUrl: {label: 'Bay View Restaurant', url: 'https://www.oceanpark.com.hk/en/a-day-at-the-park/dining-shopping/bay-view-restaurant'},
};

const diningTabs = [
  {tab: {id: 'restaurants', label: 'Restaurants'}, pageItems: [restaurantItem]},
  {tab: {id: 'food-kiosks', label: 'Food Kiosks'}, pageItems: [{nodeUrl: {label: 'Kiosk', url: 'https://www.oceanpark.com.hk/en/kiosk'}}]},
];

const showSlot1 = {title: 'Ocean Wonders', timeSlot: ['14:30:00'], locations: [{location: {id: 'aqua-city'}}]};
const showSlot2 = {title: 'Ocean Wonders', timeSlot: ['17:00:00'], locations: [{location: {id: 'aqua-city'}}]};
const scheduleItems = [showSlot1, showSlot2];

function stubbedPark(includeRaw: boolean): OceanParkHongKong {
  const park = new OceanParkHongKong();
  park.includeRaw = includeRaw;
  vi.spyOn(park as any, 'getAttractionItems').mockResolvedValue([attractionOpen, attractionClosed]);
  vi.spyOn(park as any, 'getDiningTabs').mockResolvedValue(diningTabs);
  vi.spyOn(park as any, 'getDailyScheduleItems').mockResolvedValue(scheduleItems);
  vi.spyOn(park as any, 'getCoordinateMapEntries').mockResolvedValue([]);
  vi.spyOn(park as any, 'getParkOpeningHoursValue').mockImplementation(async (date: unknown) => {
    if (date === '2026-09-21') return '10:00 am - 7:00 pm';
    if (date === '2026-09-22') return '10:00 am - 8:00 pm';
    return null;
  });
  return park;
}

const rawOf = (element: object) => (element as WithRaw<object>).raw;

describe('OceanParkHongKong raw upstream pieces', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('attaches the attractions-page card to each attraction, the show\'s daily-schedule rows to its live row', async () => {
    const live = await stubbedPark(true).getLiveData();
    expect(live.map((l) => l.id)).toEqual(['attraction_node-1', 'attraction_node-2', 'show_ocean-wonders']);

    expect(rawOf(live[0])).toEqual({attractionsPage: attractionOpen});
    expect(rawOf(live[0])!.attractionsPage).toBe(attractionOpen);
    expect(live[0].queue).toEqual({STANDBY: {waitTime: 15}});

    expect(live[1].status).toBe('CLOSED');
    expect(rawOf(live[1])).toEqual({attractionsPage: attractionClosed});

    expect(live[2].status).toBe('OPERATING');
    const showRaw = rawOf(live[2])!.dailySchedule as unknown[];
    expect(showRaw).toEqual([showSlot1, showSlot2]);
    expect(showRaw[0]).toBe(showSlot1);
    expect(showRaw[1]).toBe(showSlot2);
    expect(live[2].showtimes).toHaveLength(2);
  });

  it('attaches the attractions-page/dining-page card and the show group to each entity, nothing to the destination or park', async () => {
    const entities = await stubbedPark(true).getEntities();
    expect(entities.map((e) => e.id)).toEqual([
      'oceanparkresort', 'oceanpark', 'attraction_node-1', 'attraction_node-2', 'restaurant_bay-view-restaurant', 'show_ocean-wonders',
    ]);

    expect(rawOf(entities[0])).toBeUndefined();
    expect(rawOf(entities[1])).toBeUndefined();

    expect(rawOf(entities[2])).toEqual({attractionsPage: attractionOpen});
    expect(rawOf(entities[2])!.attractionsPage).toBe(attractionOpen);

    expect(rawOf(entities[3])).toEqual({attractionsPage: attractionClosed});

    expect(rawOf(entities[4])).toEqual({diningPage: restaurantItem});
    expect(rawOf(entities[4])!.diningPage).toBe(restaurantItem);

    const entityShowRaw = rawOf(entities[5])!.dailySchedule as unknown[];
    expect(entityShowRaw).toEqual([showSlot1, showSlot2]);
    expect(entityShowRaw[0]).toBe(showSlot1);
  });

  it('attaches the opening-hours text to each schedule day', async () => {
    const [parkSchedule] = await stubbedPark(true).getSchedules();
    expect(parkSchedule.schedule.map((e) => e.date)).toEqual(['2026-09-21', '2026-09-22']);

    expect(rawOf(parkSchedule.schedule[0])).toEqual({parkOpeningHours: '10:00 am - 7:00 pm'});
    expect(rawOf(parkSchedule.schedule[1])).toEqual({parkOpeningHours: '10:00 am - 8:00 pm'});
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

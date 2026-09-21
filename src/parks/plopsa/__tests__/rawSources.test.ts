import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {Plopsaland} from '../plopsa.js';
import {CacheLib} from '../../../cache.js';
import type {HTTPObj} from '../../../http.js';
import type {WithRaw} from '../../../destination.js';

/**
 * With `includeRaw` on, a ride row carries the three inputs its status came
 * out of: the bare reading of the wait-times map, the POI entry with the
 * temporarily-closed flag and today's park hours. A show row carries its
 * entertainments item. Entities carry the POI entry or the entertainments
 * item of the language that listed them first, while the destination and the
 * park, built from constants, carry nothing. A park day carries its calendar
 * slot, a show day the day of the entertainments schedule, the same object on
 * every performance of that day. Off, nothing carries anything.
 */
const NOW = new Date('2026-09-21T10:00:00Z');
const TODAY = '2026-09-21';

const anubis = {id: '42', plopsa_id: '42', title: 'Anubis The Ride', type: 'attraction', schedule_info: {temporarily_closed: false}};
const anubisDutch = {id: '42', plopsa_id: '42', title: 'Anubis The Ride NL', type: 'attraction', schedule_info: {temporarily_closed: true}};
const splash = {id: '43', plopsa_id: '43', title: 'SuperSplash', type: 'attraction', schedule_info: {temporarily_closed: true}};
const diner = {id: '44', plopsa_id: '44', title: 'Plopsa Diner', type: 'foods_and_drinks'};
const draconis = {id: '45', plopsa_id: '45', title: 'Draconis', type: 'attraction', schedule_info: {temporarily_closed: false}};

const poiEnglish = {items: [{id: 'poi-1', title: 'Rides', type: {label: 'Attraction'}, contains: [anubis, splash, diner]}]};
const poiDutch = {items: [{id: 'poi-1', title: 'Attracties', type: {label: 'Attractie'}, contains: [anubisDutch, draconis]}]};

const waitTimes = {'42': 15, '43': 0, '45': 0};
const todayHours = {date: TODAY, timeslots: [{type: 'open', start_time: '10:00', end_time: '18:00'}]};

const showDay = {date: TODAY, timeslots: [{type: 'open', start_time: '14:00', end_time: null}, {type: 'open', start_time: '16:30', end_time: null}]};
const show = {id: 's1', plopsa_id: '700', title: 'Mega Mindy Show', type: {label: 'Show'}, schedule_info: {schedule: [showDay]}};
const meetDay = {date: TODAY, timeslots: [{type: 'open', start_time: '11:00', end_time: '11:30'}]};
const meet = {id: 's2', plopsa_id: '701', title: 'Meet Maya', type: {label: 'Meet&Greet'}, schedule_info: {schedule: [meetDay]}};

const entertainmentsEnglish = {items: [show]};
const entertainmentsDutch = {items: [meet]};

const openSlot = {type: 'open', start_time: '2026-09-21T10:00:00+02:00', end_time: '2026-09-21T18:00:00+02:00'};
const lateSlot = {type: 'open', start_time: '2026-09-22T10:00:00+02:00', end_time: '2026-09-22T22:00:00+02:00'};
const calendar = {
  schedule: {
    '2026-09': {
      '2026-09-21': {slots: [openSlot]},
      '2026-09-22': {slots: [lateSlot]},
      '2026-09-23': {sold_out: true, slots: [{type: 'open', start_time: '2026-09-23T10:00:00+02:00', end_time: '2026-09-23T18:00:00+02:00'}]},
    },
  },
};

function stubbedPark(includeRaw: boolean): Plopsaland {
  const park = new Plopsaland();
  park.includeRaw = includeRaw;
  vi.spyOn(park as any, 'fetchPOI').mockImplementation(async (language: any) => ({
    json: async () => (language === 'nl' ? poiDutch : poiEnglish),
  } as any as HTTPObj));
  vi.spyOn(park as any, 'fetchEntertainments').mockImplementation(async (language: any) => ({
    json: async () => (language === 'nl' ? entertainmentsDutch : entertainmentsEnglish),
  } as any as HTTPObj));
  vi.spyOn(park as any, 'fetchWaitTimes').mockResolvedValue({json: async () => waitTimes} as any as HTTPObj);
  vi.spyOn(park as any, 'fetchTodayHours').mockResolvedValue({json: async () => todayHours} as any as HTTPObj);
  vi.spyOn(park as any, 'fetchCalendar').mockResolvedValue({json: async () => calendar} as any as HTTPObj);
  return park;
}

const rawOf = (element: object) => (element as WithRaw<object>).raw;

describe('Plopsaland raw upstream pieces', () => {
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

  it('attaches the reading, the POI entry and today hours to a ride, the item to a show', async () => {
    const live = await stubbedPark(true).getLiveData();
    expect(live.map((l) => l.id)).toEqual(['42', '43', '45', '700', '701']);

    // The English feed listed Anubis first, so its entry is the one that
    // decided the flag and the one that is attached.
    expect(rawOf(live[0])).toEqual({waitTimes: 15, poi: anubis, todayHours});
    expect(rawOf(live[0])!.poi).toBe(anubis);
    expect(rawOf(live[0])!.todayHours).toBe(todayHours);
    expect(live[0].queue).toEqual({STANDBY: {waitTime: 15}});

    // A ride the Dutch feed alone lists carries that feed's entry.
    expect(rawOf(live[2])!.poi).toBe(draconis);
    expect(rawOf(live[2])!.waitTimes).toBe(0);
    expect(live[1].status).toBe('DOWN');

    expect(rawOf(live[3])).toEqual({entertainments: show});
    expect(rawOf(live[3])!.entertainments).toBe(show);
    expect(live[3].showtimes).toHaveLength(2);
    expect(rawOf(live[4])!.entertainments).toBe(meet);
  });

  it('attaches the POI entry or the entertainments item to each entity, nothing to the destination and the park', async () => {
    const entities = await stubbedPark(true).getEntities();
    expect(entities.map((e) => e.id)).toEqual([
      'plopsaland-de-panne', 'plopsaland', '42', '43', '44', '45', '700', '701',
    ]);

    expect(rawOf(entities[0])).toBeUndefined();
    expect(rawOf(entities[1])).toBeUndefined();
    expect(rawOf(entities[2])).toEqual({poi: anubis});
    expect(rawOf(entities[2])!.poi).toBe(anubis);
    expect(entities[2].name).toBe('Anubis The Ride');
    expect(rawOf(entities[4])!.poi).toBe(diner);
    expect(rawOf(entities[5])!.poi).toBe(draconis);
    expect(rawOf(entities[6])).toEqual({entertainments: show});
    expect(rawOf(entities[7])!.entertainments).toBe(meet);
  });

  it('attaches the calendar slot to a park day and the schedule day to every performance of a show day', async () => {
    const schedules = await stubbedPark(true).getSchedules();
    expect(schedules.map((s) => s.id)).toEqual(['plopsaland', '700', '701']);

    const park = schedules[0].schedule;
    expect(park.map((e) => e.date)).toEqual(['2026-09-21', '2026-09-22']);
    expect(rawOf(park[0])).toEqual({calendar: openSlot});
    expect(rawOf(park[0])!.calendar).toBe(openSlot);
    expect(park[0].closingTime).toBe('2026-09-21T18:00:00+02:00');
    expect(rawOf(park[1])!.calendar).toBe(lateSlot);

    // Two performances of the same day come out of the one day object.
    const showSchedule = schedules[1].schedule;
    expect(showSchedule).toHaveLength(2);
    expect(rawOf(showSchedule[0])).toEqual({entertainments: showDay});
    expect(rawOf(showSchedule[0])!.entertainments).toBe(showDay);
    expect(rawOf(showSchedule[1])!.entertainments).toBe(showDay);
    expect(showSchedule[1].openingTime).toBe('2026-09-21T16:30:00+02:00');

    expect(rawOf(schedules[2].schedule[0])!.entertainments).toBe(meetDay);
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

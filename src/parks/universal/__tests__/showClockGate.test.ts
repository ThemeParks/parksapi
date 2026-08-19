/**
 * Regression for programme#86 ("USH: 25 shows never leave OPERATING, so the
 * rows never get written and read as stale").
 *
 * show-list.json's show_times[] lists the WHOLE day's ENABLED performances
 * from midnight, so `hasFutureShowtimes` (parseShowTimes) stays true all
 * night once the feed rolls to the next operating day — a show sampled at
 * 03:00 with the park shut for hours still has a slot hours away. Before the
 * fix, mapUniversalShowStatus's CLOSED/CANCELED/unknown default branch read
 * that as OPERATING with no reference to park hours, so the status (and
 * therefore the wiki row) never changed across the overnight closure and
 * `lastUpdated` froze.
 *
 * These tests drive the full buildLiveData → getLiveData pipeline (not just
 * the pure mapUniversalShowStatus helper) so the venue-schedule lookup and
 * resolveScheduleVenue wiring are covered too, using UniversalStudios (a
 * single-park resort — venue place_id 'ush.ush', legacy venue id '13825')
 * to match the reported incident directly.
 */
import {describe, test, expect, vi, afterEach} from 'vitest';
import {UniversalStudios, UniversalOrlando, type UniversalShowListEntry} from '../universal.js';

// Real wall-clock hours from the incident: EXTRA_HOURS 08:00-09:00 PDT,
// general open 09:00-19:00 PDT. All offsets are -07:00 (Pacific, no DST
// re-projection needed since these are already Pacific-local strings for
// this fixture — see isParkOperatingNow, which compares absolute instants).
const USH_SCHEDULE_FIXTURE = [
  {
    Date: '2026-08-18',
    VenueStatus: 'Open',
    OpenTimeString: '2026-08-18T09:00:00-07:00',
    CloseTimeString: '2026-08-18T19:00:00-07:00',
    EarlyEntryString: '2026-08-18T08:00:00-07:00',
  },
];

const SHOW: UniversalShowListEntry = {
  show_id: 'ush.cw.entertainment.meet_mario_and_luigi',
  resort_area_code: 'USH',
  venue_id: 'ush.ush',
  name: 'Meet Mario and Luigi',
  // Not OPEN/RIDE_NOW/a delay/an explicit long closure — falls into the
  // default branch that used to ignore park hours entirely.
  status: 'CLOSED',
  show_externally: true,
  show_times: [
    // "Today's" full day of slots, as the feed actually serves it from
    // midnight — some already past by any of the sampled times below, one
    // still ahead of both.
    {show_time_id: 'a', status: 'ENABLED', start_time: '2026-08-18T16:30:00.000Z'}, // 09:30 PDT
    {show_time_id: 'b', status: 'ENABLED', start_time: '2026-08-19T01:00:00.000Z'}, // 18:00 PDT
  ],
};

function stubPark<T extends UniversalStudios | UniversalOrlando>(park: T, showList: UniversalShowListEntry[]): T {
  (park as any)._init = async () => undefined;
  (park as any).getWaitTimes = async () => [];
  (park as any).getVirtualQueueStates = async () => [];
  (park as any).getShowList = async () => showList;
  (park as any).getVenueSchedule = async () => USH_SCHEDULE_FIXTURE;
  return park;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Universal buildLiveData — show status clock-gated against park hours', () => {
  test('overnight, park shut: show reads CLOSED even though a slot is still hours away', async () => {
    // 03:00 PDT, 2026-08-18 — before EarlyEntryString (08:00 PDT). This is
    // the incident window: park closed since ~19:12 PDT the prior evening,
    // both show_times slots technically "in the future" relative to now.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-18T10:00:00.000Z'));

    const park = stubPark(new UniversalStudios(), [SHOW]);
    const liveData = await park.getLiveData();
    const entry = liveData.find((d) => d.id === 'ush.cw.entertainment.meet_mario_and_luigi');

    expect(entry).toBeDefined();
    expect(entry!.status).toBe('CLOSED'); // was 'OPERATING' before the fix
  });

  test('during EXTRA_HOURS, park open: the same show reads OPERATING', async () => {
    // 08:25 PDT, 2026-08-18 — inside EarlyEntryString..OpenTimeString.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-18T15:25:00.000Z'));

    const park = stubPark(new UniversalStudios(), [SHOW]);
    const liveData = await park.getLiveData();
    const entry = liveData.find((d) => d.id === 'ush.cw.entertainment.meet_mario_and_luigi');

    expect(entry).toBeDefined();
    expect(entry!.status).toBe('OPERATING');
  });

  test('during general operating hours, park open: the same show reads OPERATING', async () => {
    // 12:00 PDT, 2026-08-18 — well inside OpenTimeString..CloseTimeString.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-18T19:00:00.000Z'));

    const park = stubPark(new UniversalStudios(), [SHOW]);
    const liveData = await park.getLiveData();
    const entry = liveData.find((d) => d.id === 'ush.cw.entertainment.meet_mario_and_luigi');

    expect(entry).toBeDefined();
    expect(entry!.status).toBe('OPERATING');
  });

  // Live evidence, not just theory: sampled at 03:24 PDT with USH's own
  // schedule confirming the park shut, 25 of 31 externally-shown show-list
  // entries carried `status: "OPEN"` outright. The status field itself is
  // stale overnight, same as the ride wait-time feed (parksapi #316), so an
  // explicit OPEN is gated exactly like the showtimes-derived default.
  test('explicit OPEN status IS clock-gated: closed park overrides it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-18T10:00:00.000Z')); // overnight, park shut

    const openShow: UniversalShowListEntry = {...SHOW, status: 'OPEN'};
    const park = stubPark(new UniversalStudios(), [openShow]);
    const liveData = await park.getLiveData();
    const entry = liveData.find((d) => d.id === 'ush.cw.entertainment.meet_mario_and_luigi');

    expect(entry!.status).toBe('CLOSED'); // was 'OPERATING' before the fix — the observed incident
  });

  test('explicit OPEN status during EXTRA_HOURS: park open, reads OPERATING', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-18T15:25:00.000Z')); // 08:25 PDT, EXTRA_HOURS

    const openShow: UniversalShowListEntry = {...SHOW, status: 'OPEN'};
    const park = stubPark(new UniversalStudios(), [openShow]);
    const liveData = await park.getLiveData();
    const entry = liveData.find((d) => d.id === 'ush.cw.entertainment.meet_mario_and_luigi');

    expect(entry!.status).toBe('OPERATING');
  });

  test('venue schedule lookup failure degrades to ungated (old behaviour), not a thrown error', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-18T10:00:00.000Z')); // overnight, park shut

    const park = stubPark(new UniversalStudios(), [SHOW]);
    (park as any).getVenueSchedule = async () => { throw new Error('upstream 500'); };

    const liveData = await park.getLiveData();
    const entry = liveData.find((d) => d.id === 'ush.cw.entertainment.meet_mario_and_luigi');

    expect(entry!.status).toBe('OPERATING');
  });

  test('a show at CityWalk (no schedule-bearing venue) is not gated', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-18T10:00:00.000Z')); // overnight, USH park shut

    const cityWalkShow: UniversalShowListEntry = {
      ...SHOW,
      show_id: 'ush.cw.entertainment.5_towers_stage',
      venue_id: 'ush.cw',
    };
    const park = stubPark(new UniversalStudios(), [cityWalkShow]);
    const liveData = await park.getLiveData();
    const entry = liveData.find((d) => d.id === 'ush.cw.entertainment.5_towers_stage');

    expect(entry!.status).toBe('OPERATING'); // hours unknown -> ungated, same as before the fix
  });
});

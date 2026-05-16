/**
 * buildSchedules timezone regression.
 *
 * Universal's `/api/venues/{id}/hours` endpoint stamps every entry with the
 * server-side offset (Orlando / Eastern Time) — even for Hollywood venues
 * (e.g. id=13825). Without re-projecting to the destination's own timezone,
 * the schedule for Hollywood goes out the door as wall-clock Eastern times
 * (e.g. 13:00-21:00) when the actual Pacific-local hours are 10:00-18:00.
 */
import {describe, test, expect, beforeEach} from 'vitest';
import {UniversalStudios, UniversalOrlando} from '../universal.js';

const HOLLYWOOD_VENUE_ID = '13825';
const HOLLYWOOD_PARK = {Id: 13825, MblDisplayName: 'Universal Studios', AdmissionRequired: true};

// Real shape returned by services.universalorlando.com on 2026-05-16 for
// Hollywood venue 13825. All offsets are -04:00 (the API server is in
// Orlando). The actual park wall-clock hours are: 10:00-18:00 (Mon-Tue
// regular open, with 09:00 early entry) and 13:00 = 10am PT for Mon May 18.
const HOLLYWOOD_SCHEDULE_FIXTURE = [
  {
    Date: '2026-05-18',
    VenueStatus: 'Open',
    OpenTimeString: '2026-05-18T13:00:00-04:00',     // 10:00 PT
    CloseTimeString: '2026-05-18T21:00:00-04:00',    // 18:00 PT
    EarlyEntryString: '2026-05-18T12:00:00-04:00',   // 09:00 PT
  },
  {
    Date: '2026-05-19',
    VenueStatus: 'Open',
    OpenTimeString: '2026-05-19T13:00:00-04:00',
    CloseTimeString: '2026-05-19T21:00:00-04:00',
    EarlyEntryString: '2026-05-19T12:00:00-04:00',
  },
];

const ORLANDO_PARK = {Id: 10010, MblDisplayName: 'Universal Studios Florida', AdmissionRequired: true};
const ORLANDO_SCHEDULE_FIXTURE = [
  {
    Date: '2026-05-18',
    VenueStatus: 'Open',
    OpenTimeString: '2026-05-18T09:00:00-04:00',
    CloseTimeString: '2026-05-18T21:00:00-04:00',
    EarlyEntryString: '2026-05-18T08:30:00-04:00',
  },
];

function stubPark<T extends UniversalStudios | UniversalOrlando>(
  park: T,
  parksFixture: any[],
  scheduleFixture: any[],
): T {
  (park as any).getParks = async () => parksFixture;
  (park as any).getVenueSchedule = async () => scheduleFixture;
  (park as any)._init = async () => undefined;
  return park;
}

describe('Universal buildSchedules', () => {
  test('Hollywood: Eastern-stamped API times re-projected to Pacific', async () => {
    const park = stubPark(new UniversalStudios(), [HOLLYWOOD_PARK], HOLLYWOOD_SCHEDULE_FIXTURE);

    const schedules = await park.getSchedules();
    const main = schedules.find((s) => s.id === HOLLYWOOD_VENUE_ID);
    expect(main, 'schedule for Hollywood venue').toBeDefined();

    const may18Op = main!.schedule.find((d: any) => d.date === '2026-05-18' && d.type === 'OPERATING');
    expect(may18Op).toBeDefined();
    expect(may18Op!.openingTime).toBe('2026-05-18T10:00:00-07:00');
    expect(may18Op!.closingTime).toBe('2026-05-18T18:00:00-07:00');

    const may18Extra = main!.schedule.find((d: any) => d.date === '2026-05-18' && d.type === 'EXTRA_HOURS');
    expect(may18Extra).toBeDefined();
    expect(may18Extra!.openingTime).toBe('2026-05-18T09:00:00-07:00');
    expect(may18Extra!.closingTime).toBe('2026-05-18T10:00:00-07:00');
  });

  test('Orlando: Eastern-stamped API times preserved as Eastern', async () => {
    const park = stubPark(new UniversalOrlando(), [ORLANDO_PARK], ORLANDO_SCHEDULE_FIXTURE);

    const schedules = await park.getSchedules();
    const main = schedules.find((s) => s.id === String(ORLANDO_PARK.Id));
    const may18Op = main!.schedule.find((d: any) => d.date === '2026-05-18' && d.type === 'OPERATING');
    expect(may18Op!.openingTime).toBe('2026-05-18T09:00:00-04:00');
    expect(may18Op!.closingTime).toBe('2026-05-18T21:00:00-04:00');
  });
});

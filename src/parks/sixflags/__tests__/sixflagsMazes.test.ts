import {describe, test, expect, beforeEach, afterEach, vi} from 'vitest';
import {SixFlags} from '../sixflags.js';
import {CacheLib} from '../../../cache.js';
import type {Entity, LiveData, EntitySchedule} from '@themeparks/typelib';

/**
 * Coverage for venue 3 — the vendor's seasonal haunt mazes (Knott's Scary
 * Farm, Fright Fest, HalloWeekends, Halloween Haunt).
 *
 * Six Flags publishes mazes in all four feeds it publishes rides in: /poi
 * carries the roster and coordinates, /venue-status the open/closed status,
 * /wait-times a standby wait, and /operating-hours the event window. Until
 * this change the module read venues 1, 2 and 4 and ignored venue 3
 * entirely, so 194 maze rows across 17 parks reached the wiki as nothing at
 * all — no entity, no status, no wait time.
 *
 * Shapes below mirror responses captured on 2026-09-16.
 */

/** Park 4 = Knott's Berry Farm, park 906 = Six Flags Magic Mountain. */
const KNOTTS = 4;

function poiRow(fimsId: string, name: string, venueId: number | undefined, parkId = KNOTTS, lat = '33.84', lng = '-118.00') {
  return {fimsId, name, parkId, venueId, location: {latitude: lat, longitude: lng}};
}

const POI = [
  poiRow('RIDE-004-00172', '<p>GhostRider</p>', 1),
  poiRow('SHOW-004-00019', 'Native American Dancer', 2),
  poiRow('MAZE-004-00039', 'NEW! Inked', 3),
  poiRow('MAZE-004-00022', 'Origins: The Curse of Calico', 3),
  // Kings Dominion pads names with runs of tabs.
  poiRow('MAZE-004-00050', 'F.E.A.R. presented by SKITTLES\t\t\t \t\t\t', 3),
  // Great America uses a "RETURNING!" badge and Carowinds a "NEW:" colon.
  poiRow('MAZE-004-00051', 'RETURNING! Necropolis', 3),
  poiRow('MAZE-004-00052', 'NEW: Metal Massacre', 3),
  // A stripped badge can leave a double space behind.
  poiRow('MAZE-004-00053', "NEW!  Finklestein's House of Fun", 3),
  // Frontier City appends a literal "N/A".
  poiRow('MAZE-004-00054', 'Little Monster Maze N/A', 3),
  // Canada's Wonderland files the event entrance pin in venue 3, at (0, 0).
  poiRow('MAZE-004-00055', 'Front Gate', 3, KNOTTS, '0.000000', '0.000000'),
  // ...but a real maze may legitimately mention a gate.
  poiRow('MAZE-004-00056', 'Gates of Terror', 3),
  // Six Flags Over Georgia files haunt meet-and-greets in venue 3, at (0, 0).
  poiRow('MAZE-004-00057', 'Looney Tunes Meet and Greet', 3, KNOTTS, '0.000000', '0.000000'),
  poiRow('RESTAURANT-004-00002', 'Baja Taqueria', 4),
  poiRow('RESTROOM-004-00060', 'Build A Bear Restroom', 5),
  poiRow('RETAIL-004-00208', 'Berry Market', 6),
  // The vendor ships event rows with no venueId at all.
  poiRow('EVENT-004-00136', 'Knott’s Scary Farm', undefined),
];

class Probe extends SixFlags {
  public venueStatus: unknown = {venues: []};
  public waitTimes: unknown = {venues: []};
  public hours: Record<string, unknown> = {};

  override async getParkData(): Promise<any> {
    return [{parkId: KNOTTS, code: 'KB', name: "Knott's Berry Farm", waterParks: []}];
  }

  override async getPOI(): Promise<any> {
    return POI;
  }

  override async getVenueStatus(): Promise<any> {
    return this.venueStatus;
  }

  override async getWaitTimes(): Promise<any> {
    return this.waitTimes;
  }

  override async getOperatingHours(_parkId: number, month: string): Promise<any> {
    return this.hours[month] ?? {dates: []};
  }

  public entitiesForTest(): Promise<Entity[]> {
    return this.getEntities();
  }

  public liveForTest(): Promise<LiveData[]> {
    return this.getLiveData();
  }

  public schedulesForTest(): Promise<EntitySchedule[]> {
    return this.getSchedules();
  }
}

function makeProbe(): Probe {
  const probe = new Probe();
  // Coordinates drive the timezone lookup; the POI fixture is in California.
  return probe;
}

beforeEach(() => {
  CacheLib.clearByClassName('Probe');
  CacheLib.clearByClassName('SixFlags');
});

describe('maze entities', () => {
  test('publishes venue 3 rows that were previously dropped entirely', async () => {
    const entities = await makeProbe().entitiesForTest();
    const ids = entities.map(e => e.id);

    expect(ids).toContain('MAZE-004-00039');
    expect(ids).toContain('MAZE-004-00022');
  });

  test('publishes a maze as an ATTRACTION with a standby-queue attraction type', async () => {
    const entities = await makeProbe().entitiesForTest();
    const maze = entities.find(e => e.id === 'MAZE-004-00022');

    expect(maze?.entityType).toBe('ATTRACTION');
    expect((maze as any).attractionType).toBe('RIDE');
  });

  test('parents a maze to its park, not to the destination', async () => {
    const entities = await makeProbe().entitiesForTest();
    const maze = entities.find(e => e.id === 'MAZE-004-00022');

    expect(maze?.parkId).toBe('sixflags_park_KB');
    expect(maze?.destinationId).toBe('sixflags_destination_KB');
  });

  test.each([
    ['MAZE-004-00039', 'Inked'],
    ['MAZE-004-00051', 'Necropolis'],
    ['MAZE-004-00052', 'Metal Massacre'],
    ['MAZE-004-00053', "Finklestein's House of Fun"],
  ])('strips the season badge from %s', async (id, expected) => {
    const entities = await makeProbe().entitiesForTest();

    expect(entities.find(e => e.id === id)?.name).toBe(expected);
  });

  test('strips the tab padding the vendor ships on maze names', async () => {
    const entities = await makeProbe().entitiesForTest();

    expect(entities.find(e => e.id === 'MAZE-004-00050')?.name)
      .toBe('F.E.A.R. presented by SKITTLES');
  });

  test('drops a trailing literal N/A', async () => {
    const entities = await makeProbe().entitiesForTest();

    expect(entities.find(e => e.id === 'MAZE-004-00054')?.name).toBe('Little Monster Maze');
  });

  test('drops the event entrance pin filed in the maze venue', async () => {
    const entities = await makeProbe().entitiesForTest();

    expect(entities.map(e => e.id)).not.toContain('MAZE-004-00055');
  });

  test('keeps a real maze whose name merely mentions a gate', async () => {
    const entities = await makeProbe().entitiesForTest();
    const maze = entities.find(e => e.id === 'MAZE-004-00056');

    expect(maze?.name).toBe('Gates of Terror');
    expect((maze as any).attractionType).toBe('RIDE');
  });

  test('publishes a haunt meet-and-greet as MEET_AND_GREET, not as a maze', async () => {
    const entities = await makeProbe().entitiesForTest();
    const mg = entities.find(e => e.id === 'MAZE-004-00057');

    expect(mg?.entityType).toBe('ATTRACTION');
    expect((mg as any).attractionType).toBe('MEET_AND_GREET');
  });

  test('falls back to the park centroid for a maze shipped at (0, 0)', async () => {
    const entities = await makeProbe().entitiesForTest();
    const mg = entities.find(e => e.id === 'MAZE-004-00057');

    // (0, 0) is a placeholder, never a real location — it must not reach the
    // wiki as a park sitting in the Gulf of Guinea.
    expect(mg?.location?.latitude).toBeCloseTo(33.84, 2);
    expect(mg?.location?.longitude).toBeCloseTo(-118.0, 2);
  });

  test('still leaves restrooms, retail and venue-less event rows unpublished', async () => {
    const entities = await makeProbe().entitiesForTest();
    const ids = entities.map(e => e.id);

    expect(ids).not.toContain('RESTROOM-004-00060');
    expect(ids).not.toContain('RETAIL-004-00208');
    expect(ids).not.toContain('EVENT-004-00136');
  });
});

describe('maze live data', () => {
  test('emits a maze rostered in venue-status with its standby wait', async () => {
    const probe = makeProbe();
    probe.venueStatus = {
      venues: [{venueId: 3, details: [{fimsId: 'MAZE-004-00022', status: 'Open'}]}],
    };
    probe.waitTimes = {
      venues: [{venueId: 3, details: [{fimsId: 'MAZE-004-00022', regularWaittime: {waitTime: 45}}]}],
    };

    const maze = (await probe.liveForTest()).find(l => l.id === 'MAZE-004-00022');

    expect(maze?.status).toBe('OPERATING');
    expect(maze?.queue?.STANDBY?.waitTime).toBe(45);
  });

  test('maps a closed maze to CLOSED and drops its wait time', async () => {
    const probe = makeProbe();
    probe.venueStatus = {
      venues: [{venueId: 3, details: [{fimsId: 'MAZE-004-00022', status: 'Not Scheduled'}]}],
    };
    probe.waitTimes = {
      venues: [{venueId: 3, details: [{fimsId: 'MAZE-004-00022', regularWaittime: {waitTime: 0}}]}],
    };

    const maze = (await probe.liveForTest()).find(l => l.id === 'MAZE-004-00022');

    expect(maze?.status).toBe('CLOSED');
    expect(maze?.queue?.STANDBY?.waitTime).toBeUndefined();
  });

  test('emits a maze present only in wait-times', async () => {
    // Kings Island and Discovery Kingdom publish maze waits with no maze
    // roster in venue-status at all. Enumerating venue-status alone would
    // drop every maze at those parks.
    const probe = makeProbe();
    probe.venueStatus = {venues: [{venueId: 1, details: []}]};
    probe.waitTimes = {
      venues: [{venueId: 3, details: [{fimsId: 'MAZE-004-00022', regularWaittime: {waitTime: 30}}]}],
    };

    const maze = (await probe.liveForTest()).find(l => l.id === 'MAZE-004-00022');

    expect(maze?.status).toBe('OPERATING');
    expect(maze?.queue?.STANDBY?.waitTime).toBe(30);
  });

  test('carries a maze Fast Lane wait through as PAID_STANDBY', async () => {
    const probe = makeProbe();
    probe.venueStatus = {
      venues: [{venueId: 3, details: [{fimsId: 'MAZE-004-00022', status: 'Open'}]}],
    };
    probe.waitTimes = {
      venues: [{
        venueId: 3,
        details: [{
          fimsId: 'MAZE-004-00022',
          regularWaittime: {waitTime: 45},
          isFastLane: true,
          fastlaneWaittime: {waitTime: 5},
        }],
      }],
    };

    const maze = (await probe.liveForTest()).find(l => l.id === 'MAZE-004-00022');

    expect(maze?.queue?.PAID_STANDBY?.waitTime).toBe(5);
  });

  test('maps a maze reported Temp Closed to DOWN', async () => {
    const probe = makeProbe();
    probe.venueStatus = {
      venues: [{venueId: 3, details: [{fimsId: 'MAZE-004-00022', status: 'Temp Closed'}]}],
    };

    const maze = (await probe.liveForTest()).find(l => l.id === 'MAZE-004-00022');

    expect(maze?.status).toBe('DOWN');
  });

  test('does not duplicate a maze present in both feeds', async () => {
    const probe = makeProbe();
    probe.venueStatus = {
      venues: [{venueId: 3, details: [{fimsId: 'MAZE-004-00022', status: 'Open'}]}],
    };
    probe.waitTimes = {
      venues: [{venueId: 3, details: [{fimsId: 'MAZE-004-00022', regularWaittime: {waitTime: 45}}]}],
    };

    const rows = (await probe.liveForTest()).filter(l => l.id === 'MAZE-004-00022');

    expect(rows).toHaveLength(1);
  });
});

describe('an unstatused row with a zero wait is not evidence of operation', () => {
  /**
   * The wait-times feed is not gated on park hours: it serves a roster of
   * zeros around the clock. Sampled 2026-09-16 at 03:20 Pacific with every
   * park in the estate shut, all 1,000-plus wait-times rows across 26 parks
   * read exactly 0 — and the old `waitTime >= 0` fallback reported 21 rides
   * open in the middle of the night. Folding ~30 wait-times-only mazes into
   * the same enumeration would have multiplied that.
   */
  test('a wait-times-only row posting 0 is CLOSED, not OPERATING', async () => {
    const probe = makeProbe();
    probe.venueStatus = {venues: [{venueId: 1, details: []}]};
    probe.waitTimes = {
      venues: [
        {venueId: 1, details: [{fimsId: 'RIDE-004-00172', regularWaittime: {waitTime: 0}}]},
        {venueId: 3, details: [{fimsId: 'MAZE-004-00022', regularWaittime: {waitTime: 0}}]},
      ],
    };

    const live = await probe.liveForTest();

    expect(live.find(l => l.id === 'RIDE-004-00172')?.status).toBe('CLOSED');
    expect(live.find(l => l.id === 'MAZE-004-00022')?.status).toBe('CLOSED');
  });

  test('a wait-times-only row posting a real wait is still OPERATING', async () => {
    // The union exists to recover rides like Canada's Wonderland's "The
    // Daredeviler", which was serving 60 minutes while missing from
    // venue-status. Those must keep working.
    const probe = makeProbe();
    probe.venueStatus = {venues: [{venueId: 1, details: []}]};
    probe.waitTimes = {
      venues: [{venueId: 1, details: [{fimsId: 'RIDE-004-00172', regularWaittime: {waitTime: 60}}]}],
    };

    const live = await probe.liveForTest();

    expect(live.find(l => l.id === 'RIDE-004-00172')?.status).toBe('OPERATING');
    expect(live.find(l => l.id === 'RIDE-004-00172')?.queue?.STANDBY?.waitTime).toBe(60);
  });

  test('a rostered row reported Open with a 0 wait is still OPERATING', async () => {
    // A genuine walk-on. The zero rule applies only to rows with no status
    // at all — a vendor-stated "Open" is never overridden by the wait.
    const probe = makeProbe();
    probe.venueStatus = {
      venues: [{venueId: 3, details: [{fimsId: 'MAZE-004-00022', status: 'Open'}]}],
    };
    probe.waitTimes = {
      venues: [{venueId: 3, details: [{fimsId: 'MAZE-004-00022', regularWaittime: {waitTime: 0}}]}],
    };

    const maze = (await probe.liveForTest()).find(l => l.id === 'MAZE-004-00022');

    expect(maze?.status).toBe('OPERATING');
    expect(maze?.queue?.STANDBY?.waitTime).toBe(0);
  });
});

describe('haunt event schedules', () => {
  // buildSchedules() walks the current month plus two, so the clock decides
  // which month keys it asks for. Pin it.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-16T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function schedulesFor(hours: Record<string, unknown>) {
    const probe = makeProbe();
    probe.hours = hours;
    return probe.schedulesForTest();
  }

  const parkDay = (date: string, extra: Record<string, unknown>) => ({
    date,
    isParkClosed: false,
    venues: [],
    operatings: [{
      operatingTypeId: 24,
      operatingTypeName: 'Park',
      items: [{timeFrom: '09:00', timeTo: '17:00'}],
    }],
    ...extra,
  });

  test('emits the park-level Haunt window as a TICKETED_EVENT', async () => {
    // Knott's shape: Scary Farm lives in `operatings` type 25 and the maze
    // detailHours are empty all season, so this is the only place the
    // window exists.
    const schedules = await schedulesFor({
      '202609': {
        dates: [parkDay('09/17/2026', {
          operatings: [
            {operatingTypeId: 24, operatingTypeName: 'Park', items: [{timeFrom: '09:00', timeTo: '17:00'}]},
            {operatingTypeId: 25, operatingTypeName: 'Haunt', items: [{timeFrom: '19:00', timeTo: '01:00'}]},
          ],
        })],
      },
    });

    const day = schedules[0].schedule.filter(s => s.date === '2026-09-17');
    const event = day.find(s => s.type === 'TICKETED_EVENT');

    expect(event?.description).toBe('Haunt');
    expect(event?.openingTime).toBe('2026-09-17T19:00:00-07:00');
    // Scary Farm runs to 01:00 the NEXT morning.
    expect(event?.closingTime).toBe('2026-09-18T01:00:00-07:00');
  });

  test('leaves the regular park window alongside it, unchanged', async () => {
    const schedules = await schedulesFor({
      '202609': {
        dates: [parkDay('09/17/2026', {
          operatings: [
            {operatingTypeId: 24, operatingTypeName: 'Park', items: [{timeFrom: '09:00', timeTo: '17:00'}]},
            {operatingTypeId: 25, operatingTypeName: 'Haunt', items: [{timeFrom: '19:00', timeTo: '01:00'}]},
          ],
        })],
      },
    });

    const operating = schedules[0].schedule.filter(s => s.date === '2026-09-17' && s.type === 'OPERATING');

    expect(operating).toHaveLength(1);
    expect(operating[0].openingTime).toBe('2026-09-17T09:00:00-07:00');
    expect(operating[0].closingTime).toBe('2026-09-17T17:00:00-07:00');
  });

  test('derives the window from per-maze hours when there is no Haunt block', async () => {
    // Magic Mountain / Cedar Point / Kings Island shape.
    const schedules = await schedulesFor({
      '202609': {
        dates: [parkDay('09/18/2026', {
          venues: [{
            venueId: 3,
            detailHours: [
              {operatingTimeFrom: '19:00', operatingTimeTo: '23:00'},
              {operatingTimeFrom: '19:00', operatingTimeTo: '23:00'},
            ],
          }],
        })],
      },
    });

    const event = schedules[0].schedule.find(s => s.date === '2026-09-18' && s.type === 'TICKETED_EVENT');

    expect(event?.openingTime).toBe('2026-09-18T19:00:00-07:00');
    expect(event?.closingTime).toBe('2026-09-18T23:00:00-07:00');
  });

  test('takes the latest close across mazes, counting midnight as next-day', async () => {
    // Cedar Point schedules 20:00-23:00 and 20:00-00:00 on the same night.
    // A plain string sort picks "23:00" and closes the event an hour early.
    const schedules = await schedulesFor({
      '202609': {
        dates: [parkDay('09/19/2026', {
          venues: [{
            venueId: 3,
            detailHours: [
              {operatingTimeFrom: '20:00', operatingTimeTo: '23:00'},
              {operatingTimeFrom: '20:00', operatingTimeTo: '00:00'},
              {operatingTimeFrom: '18:00', operatingTimeTo: '00:00'},
            ],
          }],
        })],
      },
    });

    const event = schedules[0].schedule.find(s => s.date === '2026-09-19' && s.type === 'TICKETED_EVENT');

    expect(event?.openingTime).toBe('2026-09-19T18:00:00-07:00');
    expect(event?.closingTime).toBe('2026-09-20T00:00:00-07:00');
  });

  test('keeps an afternoon event window on the same day', async () => {
    // Cedar Point's daytime family haunt runs 17:00-20:00 — no rollover.
    const schedules = await schedulesFor({
      '202609': {
        dates: [parkDay('09/20/2026', {
          venues: [{venueId: 3, detailHours: [{operatingTimeFrom: '17:00', operatingTimeTo: '20:00'}]}],
        })],
      },
    });

    const event = schedules[0].schedule.find(s => s.date === '2026-09-20' && s.type === 'TICKETED_EVENT');

    expect(event?.openingTime).toBe('2026-09-20T17:00:00-07:00');
    expect(event?.closingTime).toBe('2026-09-20T20:00:00-07:00');
  });

  test('ignores maze hours that open before the park itself opens', async () => {
    // Fiesta Texas shape, every Friday of the 2026 season: the park opens
    // 17:00, eight mazes open 19:15, and six are filed as 06:00-23:00. A
    // haunt maze cannot admit guests eleven hours before the park does, and
    // taking the earliest start published the whole event from 06:00.
    const schedules = await schedulesFor({
      '202609': {
        dates: [parkDay('09/25/2026', {
          operatings: [{operatingTypeId: 24, operatingTypeName: 'Park', items: [{timeFrom: '17:00', timeTo: '23:00'}]}],
          venues: [{
            venueId: 3,
            detailHours: [
              ...Array.from({length: 6}, () => ({operatingTimeFrom: '06:00', operatingTimeTo: '23:00'})),
              ...Array.from({length: 8}, () => ({operatingTimeFrom: '19:15', operatingTimeTo: '23:00'})),
            ],
          }],
        })],
      },
    });

    const event = schedules[0].schedule.find(s => s.date === '2026-09-25' && s.type === 'TICKETED_EVENT');

    expect(event?.openingTime).toBe('2026-09-25T19:15:00-07:00');
    expect(event?.closingTime).toBe('2026-09-25T23:00:00-07:00');
  });

  test('opens the event with the park when every maze is filed before it', async () => {
    // The mazes still say the event runs tonight; only their start is wrong.
    const schedules = await schedulesFor({
      '202609': {
        dates: [parkDay('09/26/2026', {
          operatings: [{operatingTypeId: 24, operatingTypeName: 'Park', items: [{timeFrom: '19:00', timeTo: '01:00'}]}],
          venues: [{
            venueId: 3,
            detailHours: [
              {operatingTimeFrom: '18:00', operatingTimeTo: '01:00'},
              {operatingTimeFrom: '18:00', operatingTimeTo: '00:00'},
            ],
          }],
        })],
      },
    });

    const event = schedules[0].schedule.find(s => s.date === '2026-09-26' && s.type === 'TICKETED_EVENT');

    expect(event?.openingTime).toBe('2026-09-26T19:00:00-07:00');
    expect(event?.closingTime).toBe('2026-09-27T01:00:00-07:00');
  });

  test('leaves a vendor-stated Haunt block alone even when it starts before the park', async () => {
    // A stated block is the vendor's own event window, not an inference, so
    // it is published as given.
    const schedules = await schedulesFor({
      '202609': {
        dates: [parkDay('09/27/2026', {
          operatings: [
            {operatingTypeId: 24, operatingTypeName: 'Park', items: [{timeFrom: '19:00', timeTo: '23:00'}]},
            {operatingTypeId: 25, operatingTypeName: 'Haunt', items: [{timeFrom: '18:30', timeTo: '23:00'}]},
          ],
        })],
      },
    });

    const event = schedules[0].schedule.find(s => s.date === '2026-09-27' && s.type === 'TICKETED_EVENT');

    expect(event?.openingTime).toBe('2026-09-27T18:30:00-07:00');
  });

  test('prefers the vendor-stated Haunt block over the inferred maze envelope', async () => {
    const schedules = await schedulesFor({
      '202609': {
        dates: [parkDay('09/21/2026', {
          operatings: [
            {operatingTypeId: 24, operatingTypeName: 'Park', items: [{timeFrom: '09:00', timeTo: '17:00'}]},
            {operatingTypeId: 25, operatingTypeName: 'Haunt', items: [{timeFrom: '19:00', timeTo: '02:00'}]},
          ],
          venues: [{venueId: 3, detailHours: [{operatingTimeFrom: '20:00', operatingTimeTo: '23:00'}]}],
        })],
      },
    });

    const event = schedules[0].schedule.find(s => s.date === '2026-09-21' && s.type === 'TICKETED_EVENT');

    expect(event?.openingTime).toBe('2026-09-21T19:00:00-07:00');
    expect(event?.closingTime).toBe('2026-09-22T02:00:00-07:00');
  });

  test('emits no event window on a day with neither shape', async () => {
    const schedules = await schedulesFor({
      '202609': {dates: [parkDay('09/22/2026', {})]},
    });

    const day = schedules[0].schedule.filter(s => s.date === '2026-09-22');

    expect(day.filter(s => s.type === 'TICKETED_EVENT')).toHaveLength(0);
    expect(day.filter(s => s.type === 'OPERATING')).toHaveLength(1);
  });

  test('emits no event window from an empty maze venue block', async () => {
    // Out of season the venue is present but every detailHours row is blank.
    const schedules = await schedulesFor({
      '202609': {
        dates: [parkDay('09/23/2026', {
          venues: [{
            venueId: 3,
            detailHours: [{operatingTimeFrom: '', operatingTimeTo: ''}, {operatingTimeFrom: '', operatingTimeTo: ''}],
          }],
        })],
      },
    });

    const day = schedules[0].schedule.filter(s => s.date === '2026-09-23');

    expect(day.filter(s => s.type === 'TICKETED_EVENT')).toHaveLength(0);
  });
});

describe('malformed vendor times never reach the schedule', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-16T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('ignores a Haunt block whose times are not wall-clock strings', async () => {
    const probe = makeProbe();
    probe.hours = {
      '202609': {
        dates: [{
          date: '09/24/2026',
          isParkClosed: false,
          venues: [],
          operatings: [
            {operatingTypeId: 24, operatingTypeName: 'Park', items: [{timeFrom: '09:00', timeTo: '17:00'}]},
            {operatingTypeId: 25, operatingTypeName: 'Haunt', items: [{timeFrom: 'TBD', timeTo: 'TBD'}]},
          ],
        }],
      },
    };

    const day = (await probe.schedulesForTest())[0].schedule.filter(s => s.date === '2026-09-24');

    // No event window is better than one anchored on an unparseable time.
    expect(day.filter(s => s.type === 'TICKETED_EVENT')).toHaveLength(0);
    expect(day.filter(s => s.type === 'OPERATING')).toHaveLength(1);
  });
});

describe('park hours that cross midnight', () => {
  /**
   * The rollover handling was written for the haunt window but the regular
   * park window needs it too. Cedar Point runs 11:00-00:00 on HalloWeekends
   * dates and Six Flags Mexico does it year-round; anchoring the close on the
   * same calendar date emitted a window that ended before it began — 151 of
   * 866 rows across 11 parks, observed live on 2026-09-17.
   */
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-16T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function schedulesFor(hours: Record<string, unknown>) {
    const probe = makeProbe();
    probe.hours = hours;
    return probe.schedulesForTest();
  }

  const day = (date: string, extra: Record<string, unknown>) => ({
    date, isParkClosed: false, venues: [], ...extra,
  });

  test('anchors a midnight park close on the next calendar day', async () => {
    const schedules = await schedulesFor({
      '202609': {
        dates: [day('09/18/2026', {
          operatings: [{
            operatingTypeId: 24, operatingTypeName: 'Park',
            items: [{timeFrom: '11:00', timeTo: '00:00'}],
          }],
        })],
      },
    });

    const e = schedules[0].schedule.find(s => s.date === '2026-09-18' && s.type === 'OPERATING');

    expect(e?.openingTime).toBe('2026-09-18T11:00:00-07:00');
    expect(e?.closingTime).toBe('2026-09-19T00:00:00-07:00');
    expect(new Date(e!.closingTime).getTime()).toBeGreaterThan(new Date(e!.openingTime).getTime());
  });

  test('leaves an ordinary same-day park window alone', async () => {
    const schedules = await schedulesFor({
      '202609': {
        dates: [day('09/19/2026', {
          operatings: [{
            operatingTypeId: 24, operatingTypeName: 'Park',
            items: [{timeFrom: '10:00', timeTo: '17:30'}],
          }],
        })],
      },
    });

    const e = schedules[0].schedule.find(s => s.date === '2026-09-19' && s.type === 'OPERATING');

    expect(e?.openingTime).toBe('2026-09-19T10:00:00-07:00');
    expect(e?.closingTime).toBe('2026-09-19T17:30:00-07:00');
  });

  test('takes the latest close across park windows, counting midnight as next-day', async () => {
    const schedules = await schedulesFor({
      '202609': {
        dates: [day('09/20/2026', {
          operatings: [{
            operatingTypeId: 24, operatingTypeName: 'Park',
            items: [
              {timeFrom: '11:00', timeTo: '22:00'},
              {timeFrom: '11:00', timeTo: '00:00'},
            ],
          }],
        })],
      },
    });

    const e = schedules[0].schedule.find(s => s.date === '2026-09-20' && s.type === 'OPERATING');

    expect(e?.closingTime).toBe('2026-09-21T00:00:00-07:00');
  });

  test('applies the same rollover to the per-ride detailHours fallback', async () => {
    const schedules = await schedulesFor({
      '202609': {
        dates: [day('09/21/2026', {
          venues: [{
            venueId: 1,
            detailHours: [
              {operatingTimeFrom: '11:00', operatingTimeTo: '22:00'},
              {operatingTimeFrom: '11:00', operatingTimeTo: '00:00'},
            ],
          }],
        })],
      },
    });

    const e = schedules[0].schedule.find(s => s.date === '2026-09-21' && s.type === 'OPERATING');

    expect(e?.openingTime).toBe('2026-09-21T11:00:00-07:00');
    expect(e?.closingTime).toBe('2026-09-22T00:00:00-07:00');
  });

  test('drops a park window whose times are unparseable rather than inverting it', async () => {
    const schedules = await schedulesFor({
      '202609': {
        dates: [day('09/22/2026', {
          operatings: [{
            operatingTypeId: 24, operatingTypeName: 'Park',
            items: [{timeFrom: 'TBD', timeTo: 'TBD'}],
          }],
        })],
      },
    });

    expect(schedules[0].schedule.filter(s => s.date === '2026-09-22')).toHaveLength(0);
  });
});

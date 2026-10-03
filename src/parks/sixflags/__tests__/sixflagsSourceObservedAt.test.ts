import {describe, test, expect, beforeEach, afterEach, vi} from 'vitest';
import {SixFlags} from '../sixflags.js';
import {CacheLib} from '../../../cache.js';

/**
 * The venue-status feed stamps each snapshot with the park-local minute it
 * was generated (`parkDateTime`). The module records that stamp per park, so
 * a caller can see how old the vendor's snapshot was when it was read, frozen
 * or not.
 */

const CEDAR_POINT = 1;
const KNOTTS = 4;
const SOAK_CITY = 201;
const NOW = new Date('2026-09-25T02:31:30Z'); // 22:31:30 Eastern, 19:31:30 Pacific

const SANDUSKY = {latitude: '41.48', longitude: '-82.68'};
const BUENA_PARK = {latitude: '33.84', longitude: '-118.00'};

class Probe extends SixFlags {
  public parks: any[] = [
    {parkId: CEDAR_POINT, code: 'CP', name: 'Cedar Point', waterParks: []},
    {parkId: KNOTTS, code: 'KB', name: "Knott's Berry Farm", waterParks: [{parkId: SOAK_CITY, code: 'SC', name: "Knott's Soak City"}]},
  ];
  public poi: Record<number, any[]> = {
    [CEDAR_POINT]: [{fimsId: 'RIDE-001-00325', name: 'Top Thrill 2', parkId: CEDAR_POINT, venueId: 1, location: SANDUSKY}],
    [KNOTTS]: [
      {fimsId: 'RIDE-004-00172', name: 'GhostRider', parkId: KNOTTS, venueId: 1, location: BUENA_PARK},
      {fimsId: 'RIDE-201-00001', name: 'Pacific Spin', parkId: SOAK_CITY, venueId: 1, location: BUENA_PARK},
    ],
  };
  public venueStatus: Record<number, any> = {};

  constructor() {
    // A fallback distinct from every fixture park's real zone.
    super({config: {timezone: 'UTC'}});
  }

  override async getParkData(): Promise<any> { return this.parks; }
  override async getPOI(parkId: number): Promise<any> { return this.poi[parkId] ?? []; }
  override async getVenueStatus(parkId: number): Promise<any> { return this.venueStatus[parkId] ?? null; }
  override async getWaitTimes(): Promise<any> { return null; }
  override async getOperatingHours(): Promise<any> { return {dates: []}; }
}

function feed(stamp: string | undefined, prefix: string, status = 'Opened') {
  return {
    ...(stamp !== undefined ? {parkDateTime: stamp} : {}),
    venues: [{venueId: 1, details: [{fimsId: `RIDE-${prefix}-00325`, status}]}],
  };
}

const byPark = (probe: Probe) => Object.fromEntries(probe.getSourceObservations().map(o => [o.parkId, o]));

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers({toFake: ['Date']});
  vi.setSystemTime(NOW);
  CacheLib.clearByClassName('Probe');
  CacheLib.clearByClassName('SixFlags');
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  vi.useRealTimers();
});

describe('Six Flags source observations', () => {
  test('records each park\'s venue-status stamp as an instant, keyed by park entity id', async () => {
    const probe = new Probe();
    probe.venueStatus[CEDAR_POINT] = feed('Sep 24, 2026 22:31:00', '001');
    probe.venueStatus[KNOTTS] = feed('Sep 24, 2026 19:30:00', '004');

    await probe.getLiveData();

    expect(byPark(probe)).toEqual({
      sixflags_park_CP: {parkId: 'sixflags_park_CP', observedAt: '2026-09-25T02:31:00.000Z', readAt: NOW.toISOString()},
      sixflags_park_KB: {parkId: 'sixflags_park_KB', observedAt: '2026-09-25T02:30:00.000Z', readAt: NOW.toISOString()},
    });
  });

  test('records the stamp of a frozen snapshot that is withheld', async () => {
    // The age is most useful exactly when the park is being withheld.
    const probe = new Probe();
    probe.venueStatus[CEDAR_POINT] = feed('Sep 21, 2026 13:03:00', '001');

    const live = await probe.getLiveData();

    expect(live.some(l => String(l.id).includes('-001-'))).toBe(false);
    expect(byPark(probe).sixflags_park_CP?.observedAt).toBe('2026-09-21T17:03:00.000Z');
  });

  test('records a water park under its own id and stamp', async () => {
    const probe = new Probe();
    probe.venueStatus[KNOTTS] = feed('Sep 24, 2026 19:31:00', '004');
    probe.venueStatus[SOAK_CITY] = feed('Sep 24, 2026 13:35:00', '201', 'Not Scheduled');

    await probe.getLiveData();

    expect(byPark(probe).sixflags_park_SC?.observedAt).toBe('2026-09-24T20:35:00.000Z');
  });

  test('records nothing for a feed with no stamp or an unparseable one', async () => {
    const probe = new Probe();
    probe.venueStatus[CEDAR_POINT] = feed(undefined, '001');
    probe.venueStatus[KNOTTS] = feed('10:31:00 PM', '004');

    await probe.getLiveData();

    expect(probe.getSourceObservations()).toEqual([]);
  });

  test('records nothing when the zone came from the fallback', async () => {
    // Read in the wrong zone the stamp would be hours off either way.
    const probe = new Probe();
    probe.poi[CEDAR_POINT] = [];
    probe.venueStatus[CEDAR_POINT] = feed('Sep 24, 2026 22:31:00', '001');

    await probe.getLiveData();

    expect(byPark(probe).sixflags_park_CP).toBeUndefined();
  });

  test('records nothing for a park whose feed could not be fetched', async () => {
    const probe = new Probe();
    probe.venueStatus[KNOTTS] = feed('Sep 24, 2026 19:31:00', '004');

    await probe.getLiveData();

    expect(Object.keys(byPark(probe))).toEqual(['sixflags_park_KB']);
  });
});

import {describe, test, expect, beforeEach, afterEach, vi} from 'vitest';
import {SixFlags} from '../sixflags.js';
import {CacheLib} from '../../../cache.js';

/**
 * One SixFlags instance builds every park, from one /poi/park/{id} request per
 * park. getPOI used to catch any failure, return [] and keep that [] for a
 * day. The other parks still had rides, so the destination-wide collapse guard
 * never fired, and the one park whose request failed was published with no
 * rides at all: every ride in it reads downstream as removed.
 *
 * A failed POI request now rejects. A rejected @cache call is not stored, so
 * the next build asks again. The one empty answer that is still accepted is a
 * 404 on a water park's own endpoint, which is how the vendor says it keeps no
 * separate list for that park; a park left empty then fails the base-class
 * per-park check, which SixFlags opts in to.
 */

type Poi = {
  fimsId: string; name: string; parkId: number; venueId: number;
  location: {latitude: string; longitude: string};
};

const ride = (fimsId: string, parkId: number, lat = '32.75', lng = '-97.07'): Poi => ({
  fimsId, name: `Ride ${fimsId}`, parkId, venueId: 1, location: {latitude: lat, longitude: lng},
});

function notFound(parkId: number): Error {
  return new Error(
    `GET https://example.invalid/poi/park/${parkId}: HTTP request not OK: 404 Not Found\n` +
    `  URL: GET https://example.invalid/poi/park/${parkId}\n`,
  );
}

function serverError(parkId: number): Error {
  return new Error(
    `GET https://example.invalid/poi/park/${parkId}: HTTP request not OK: 503 Service Unavailable\n`,
  );
}

class Probe extends SixFlags {
  public parks: any[] = [];
  /** What /poi/park/{id} answers: a body, or an Error to throw. */
  public poi = new Map<number, unknown>();
  public calls: number[] = [];

  override async getParkData(): Promise<any> {
    return this.parks;
  }

  override async fetchPOI(parkId: number): Promise<any> {
    this.calls.push(parkId);
    const answer = this.poi.get(parkId);
    if (answer instanceof Error) throw answer;
    if (answer === undefined) throw notFound(parkId);
    return {json: async () => answer};
  }

  public resolveTz(parkId: number): Promise<{tz: string; fromCoords: boolean}> {
    return (this as any).resolveTimezoneForPark(parkId);
  }
}

const SFOT = {parkId: 901, code: 'SFOT', name: 'Six Flags Over Texas', waterParks: [] as any[]};
const SFOG = {parkId: 902, code: 'SFOG', name: 'Six Flags Over Georgia', waterParks: [] as any[]};

beforeEach(() => {
  CacheLib.clearByClassName('Probe');
  CacheLib.clearByClassName('SixFlags');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getPOI', () => {
  test('rejects when the request fails, instead of answering an empty list', async () => {
    const probe = new Probe();
    probe.poi.set(901, serverError(901));
    await expect(probe.getPOI(901)).rejects.toThrow(/503/);
  });

  test('does not keep a failure: the next call asks again and gets the list', async () => {
    const probe = new Probe();
    probe.poi.set(901, serverError(901));
    await expect(probe.getPOI(901)).rejects.toThrow();

    probe.poi.set(901, [ride('RIDE-901-1', 901)]);
    await expect(probe.getPOI(901)).resolves.toHaveLength(1);
    expect(probe.calls).toEqual([901, 901]);
  });

  test('rejects a 404 for a theme park: it always has a list', async () => {
    const probe = new Probe();
    await expect(probe.getPOI(901)).rejects.toThrow(/404/);
  });

  test('rejects an answer that is not a list', async () => {
    const probe = new Probe();
    probe.poi.set(901, {error: 'maintenance'});
    await expect(probe.getPOI(901)).rejects.toThrow(/not a list/);
  });

  test('an empty list the vendor actually served is still an answer', async () => {
    const probe = new Probe();
    probe.poi.set(901, []);
    await expect(probe.getPOI(901)).resolves.toEqual([]);
  });

  // An empty answer is never kept, at either layer: a single empty 200 would
  // otherwise fail every entity build until the cache expired.
  test('an empty answer is not kept: the next call gets the recovered list', async () => {
    const probe = new Probe();
    probe.poi.set(901, []);
    await probe.getPOI(901);
    probe.poi.set(901, [ride('RIDE-901-1', 901)]);
    await expect(probe.getPOI(901)).resolves.toHaveLength(1);
    expect(probe.calls).toEqual([901, 901]);
  });

  test('a non-empty list is kept', async () => {
    const probe = new Probe();
    probe.poi.set(901, [ride('RIDE-901-1', 901)]);
    await probe.getPOI(901);
    await probe.getPOI(901);
    expect(probe.calls).toEqual([901]);
  });
});

describe('entity list with one park failing', () => {
  test('rejects the whole build rather than publish the park with no rides', async () => {
    const probe = new Probe();
    probe.parks = [SFOT, SFOG];
    probe.poi.set(901, [ride('RIDE-901-1', 901)]);
    probe.poi.set(902, serverError(902));
    await expect(probe.getEntities()).rejects.toThrow(/503/);
  });

  test('an empty 200 for one park does not pin: the next build has its roster', async () => {
    const probe = new Probe();
    probe.parks = [SFOT, SFOG];
    probe.poi.set(901, [ride('RIDE-901-1', 901)]);
    probe.poi.set(902, []);
    await expect(probe.getEntities()).rejects.toThrow(/sixflags_park_SFOG/);

    probe.poi.set(902, [ride('RIDE-902-1', 902, '33.77', '-84.55')]);
    const ids = (await probe.getEntities()).map(e => e.id);
    expect(ids).toEqual(expect.arrayContaining(['RIDE-901-1', 'RIDE-902-1']));
  });

  test('builds both parks once the failed request recovers', async () => {
    const probe = new Probe();
    probe.parks = [SFOT, SFOG];
    probe.poi.set(901, [ride('RIDE-901-1', 901)]);
    probe.poi.set(902, serverError(902));
    await expect(probe.getEntities()).rejects.toThrow();

    probe.poi.set(902, [ride('RIDE-902-1', 902, '33.77', '-84.55')]);
    const ids = (await probe.getEntities()).map(e => e.id);
    expect(ids).toEqual(expect.arrayContaining(['RIDE-901-1', 'RIDE-902-1']));
  });

  // The vendor answered 200 with nothing for one park: no fetch failed, but
  // publishing it would still remove every ride, so the base check stops it.
  test('rejects a park whose list came back empty', async () => {
    const probe = new Probe();
    probe.parks = [SFOT, SFOG];
    probe.poi.set(901, [ride('RIDE-901-1', 901)]);
    probe.poi.set(902, []);
    await expect(probe.getEntities()).rejects.toThrow(/sixflags_park_SFOG/);
  });
});

describe('water parks on their own endpoint', () => {
  const withWaterPark = (code: string, parkId: number) => ({
    ...SFOT,
    waterParks: [{parkId, code, name: `Water Park ${code}`, label: 'Water Park'}],
  });

  test('a 404 on the water park endpoint is an empty list, not an error', async () => {
    const probe = new Probe();
    probe.poi.set(901, [ride('RIDE-901-1', 901)]);
    await expect(probe.getWaterParkPOI(944)).resolves.toEqual([]);
  });

  test('the 404 answer is remembered, so the next lookup does not ask again', async () => {
    const probe = new Probe();
    await probe.getWaterParkPOI(913);
    await probe.getWaterParkPOI(913);
    expect(probe.calls).toEqual([913]);
  });

  test('any other failure on the water park endpoint rejects', async () => {
    const probe = new Probe();
    probe.poi.set(944, serverError(944));
    await expect(probe.getWaterParkPOI(944)).rejects.toThrow(/503/);
  });

  test('a water park with its own list publishes its rides', async () => {
    const probe = new Probe();
    probe.parks = [withWaterPark('HHOKC', 944)];
    probe.poi.set(901, [ride('RIDE-901-1', 901)]);
    probe.poi.set(944, [ride('RIDE-944-1', 944, '35.5', '-97.5')]);
    const wpRide = (await probe.getEntities()).find(e => e.id === 'RIDE-944-1');
    expect(wpRide?.parkId).toBe('sixflags_park_HHOKC');
  });

  test('a water park that 404s with no rows in the theme park list fails the build', async () => {
    const probe = new Probe();
    probe.parks = [withWaterPark('HHOKC', 944)];
    probe.poi.set(901, [ride('RIDE-901-1', 901)]);
    await expect(probe.getEntities()).rejects.toThrow(/sixflags_park_HHOKC/);
  });

  // The theme park's list answered but without the water park's rows. The
  // list is otherwise healthy and would be kept for a day, so the build that
  // finds the water park empty drops it, and the next build asks again.
  test('a theme park list missing a bundled water park does not pin', async () => {
    const probe = new Probe();
    probe.parks = [withWaterPark('HHNJ', 911)];
    probe.poi.set(901, [ride('RIDE-901-1', 901)]);
    await expect(probe.getEntities()).rejects.toThrow(/sixflags_park_HHNJ/);

    probe.poi.set(901, [ride('RIDE-901-1', 901), ride('RIDE-911-1', 911, '40.13', '-74.44')]);
    const wpRide = (await probe.getEntities()).find(e => e.id === 'RIDE-911-1');
    expect(wpRide?.parkId).toBe('sixflags_park_HHNJ');
  });

  test('a water park that 404s fails the build whatever its code', async () => {
    const probe = new Probe();
    probe.parks = [withWaterPark('HHA', 913)];
    probe.poi.set(901, [ride('RIDE-901-1', 901)]);
    await expect(probe.getEntities()).rejects.toThrow(/sixflags_park_HHA/);
  });
});

describe('timezone lookup during a POI outage', () => {
  // Live data runs the lookup for every park on every poll. During an outage
  // a failure is remembered for five minutes on this path only, so each poll
  // does not re-ask every park and log again.
  test('a failure is remembered for five minutes on the live path', async () => {
    const probe = new Probe();
    probe.parks = [SFOT];
    probe.poi.set(901, serverError(901));
    let now = Date.parse('2026-11-22T12:00:00Z');
    vi.spyOn(Date, 'now').mockImplementation(() => now);

    await probe.resolveTz(901);
    await probe.resolveTz(901);
    expect(probe.calls).toEqual([901]);

    probe.poi.set(901, [ride('RIDE-901-1', 901)]);
    now += 5 * 60 * 1000 + 1;
    await expect(probe.resolveTz(901)).resolves.toEqual({tz: 'America/Chicago', fromCoords: true});
    expect(probe.calls).toEqual([901, 901]);
  });

  // The entity build never takes the remembered failure as an answer.
  test('the entity path ignores the remembered failure and asks again', async () => {
    const probe = new Probe();
    probe.parks = [SFOT];
    probe.poi.set(901, serverError(901));
    await probe.resolveTz(901);

    probe.poi.set(901, [ride('RIDE-901-1', 901)]);
    const ids = (await probe.getEntities()).map(e => e.id);
    expect(ids).toContain('RIDE-901-1');
  });
});

describe('timezone lookup when the POI request fails', () => {
  // The entity build reads the zone first and the POI list second. A failure
  // on the first read must not fall back and then publish the park's whole
  // roster in the fallback zone once the second read succeeds.
  test('the entity build rejects rather than publish a fallback zone', async () => {
    const probe = new Probe();
    probe.parks = [SFOT];
    let failures = 1;
    const pacific = [ride('RIDE-901-1', 901, '34.42', '-118.59')];
    probe.fetchPOI = async (parkId: number) => {
      probe.calls.push(parkId);
      if (failures-- > 0) throw serverError(parkId);
      return {json: async () => pacific} as any;
    };
    await expect(probe.getEntities()).rejects.toThrow(/503/);

    const entities = await probe.getEntities();
    expect(entities.find(e => e.id === 'RIDE-901-1')?.timezone).toBe('America/Los_Angeles');
  });

  // Live data and schedules only need the POI list for the park's zone. A
  // failed request falls back to the instance zone for that call, and is not
  // kept, so the next call can still find the park's real zone.
  test('falls back without throwing', async () => {
    const probe = new Probe();
    probe.parks = [SFOT];
    probe.poi.set(901, serverError(901));
    await expect(probe.resolveTz(901)).resolves.toEqual({tz: 'America/New_York', fromCoords: false});
  });
});

import {describe, it, expect, vi, beforeEach, afterEach, afterAll} from 'vitest';
import {Phantasialand, SIGNAGE_BOX, signageLocation} from '../phantasialand.js';
import {setHttpTransport} from '../../../httpProxy.js';
import {stopHttpQueue} from '../../../http.js';

/**
 * `/signage-snapshots?loc=lat,lng` answers 403 FORBIDDEN for a location outside
 * the park's outline, which the box the park used to draw from reached at its
 * south-west corner. A bad or missing token gets 401, so the two differ by
 * status. The refusal depends on the position alone, and a retry re-sends the
 * same `loc`, so retrying cannot help.
 *
 * REFUSED_CELLS (a coarse 8 x 10 grid over the old box) and SURVEY_REFUSED (a
 * finer one) are positions seen refused, kept so the tests can show the box
 * stays clear of them.
 */
const OLD_BOX = {latMin: 50.799683077, latMax: 50.800659529, lngMin: 6.877570152, lngMax: 6.878342628};
const GRID = {rows: 10, cols: 8};

/** Centre of grid cell (row, col); row 0 is the southernmost. */
function cell(row: number, col: number) {
  return {
    lat: OLD_BOX.latMin + ((row + 0.5) / GRID.rows) * (OLD_BOX.latMax - OLD_BOX.latMin),
    lng: OLD_BOX.lngMin + ((col + 0.5) / GRID.cols) * (OLD_BOX.lngMax - OLD_BOX.lngMin),
  };
}

const REFUSED_CELLS: Array<[number, number]> = [
  [0, 0], [0, 1], [0, 2], [0, 3], [0, 4],
  [1, 0], [1, 1], [1, 2],
  [2, 0], [2, 1],
];

const within = (p: {lat: number; lng: number}, b: typeof SIGNAGE_BOX) =>
  p.lat >= b.latMin && p.lat <= b.latMax && p.lng >= b.lngMin && p.lng <= b.lngMax;

/**
 * A finer survey (latitude step 0.00004 from 50.79990, longitude step 0.00005
 * from 6.87755) refused these 13 points and no others. Keyed by latitude step,
 * valued by longitude steps.
 */
const SURVEY_REFUSED: Record<number, number[]> = {
  0: [0, 1, 2, 3, 4],
  1: [0, 1, 2, 3],
  2: [0, 1, 2],
  3: [0],
};

const SURVEY_REFUSED_POINTS = Object.entries(SURVEY_REFUSED).flatMap(([a, bs]) =>
  bs.map((b) => ({lat: 50.79990 + Number(a) * 0.00004, lng: 6.87755 + b * 0.00005})),
);

/** Metres from a point to the nearest edge of the box, or 0 inside it. */
function metresFromBox(p: {lat: number; lng: number}, b: typeof SIGNAGE_BOX): number {
  const dLat = Math.max(b.latMin - p.lat, 0, p.lat - b.latMax);
  const dLng = Math.max(b.lngMin - p.lng, 0, p.lng - b.lngMax);
  const metresPerDegree = 111_320;
  return Math.hypot(dLat * metresPerDegree, dLng * metresPerDegree * Math.cos((p.lat * Math.PI) / 180));
}

describe('signageLocation', () => {
  it('stays inside the box at both extremes of the generator', () => {
    for (const r of [0, 0.25, 0.5, 0.75, 1 - Number.EPSILON]) {
      const p = signageLocation(() => r);
      expect(within(p, SIGNAGE_BOX)).toBe(true);
    }
  });

  it('maps the first draw to latitude and the second to longitude', () => {
    const draws = [0, 1];
    const p = signageLocation(() => draws.shift()!);
    expect(p.lat).toBeCloseTo(SIGNAGE_BOX.latMin, 10);
    expect(p.lng).toBeCloseTo(SIGNAGE_BOX.lngMax, 10);
  });

  it('never lands on a cell the endpoint was seen to refuse', () => {
    for (const [row, col] of REFUSED_CELLS) {
      expect(within(cell(row, col), SIGNAGE_BOX), `cell ${row},${col}`).toBe(false);
    }
  });

  it('keeps clear of the refused region, not just of its sampled cells', () => {
    // The refused region narrows northward. The nearest accepted cell row to
    // it is row 3, so the box must not reach below row 3's centre latitude.
    expect(SIGNAGE_BOX.latMin).toBeGreaterThan(cell(3, 0).lat);
  });

  it('keeps at least 10 m clear of every point the fine survey saw refused', () => {
    expect(SURVEY_REFUSED_POINTS).toHaveLength(13);
    for (const p of SURVEY_REFUSED_POINTS) {
      expect(metresFromBox(p, SIGNAGE_BOX), `${p.lat},${p.lng}`).toBeGreaterThanOrEqual(10);
    }
  });

  it('is a sub-box of the one the park used to draw from', () => {
    expect(SIGNAGE_BOX.latMin).toBeGreaterThanOrEqual(OLD_BOX.latMin);
    expect(SIGNAGE_BOX.latMax).toBeLessThanOrEqual(OLD_BOX.latMax);
    expect(SIGNAGE_BOX.lngMin).toBeGreaterThanOrEqual(OLD_BOX.lngMin);
    expect(SIGNAGE_BOX.lngMax).toBeLessThanOrEqual(OLD_BOX.lngMax);
  });

  it('draws 1000 random points that all stay inside the box', () => {
    for (let k = 0; k < 1000; k++) {
      expect(within(signageLocation(), SIGNAGE_BOX)).toBe(true);
    }
  });
});

describe('Phantasialand.fetchSignage', () => {
  let sent: string[];

  beforeEach(() => {
    sent = [];
    setHttpTransport(async (request) => {
      sent.push(request.url);
      return new Response('[]', {status: 200, headers: {'content-type': 'application/json'}});
    });
  });

  afterEach(() => {
    setHttpTransport(null);
    vi.restoreAllMocks();
  });

  afterAll(() => stopHttpQueue());

  function park() {
    const p = new Phantasialand({config: {apiBase: 'https://phantasialand.invalid'}});
    vi.spyOn(p, 'getAccessToken').mockResolvedValue('test-token');
    return p;
  }

  it('sends the location the generator produced, latitude first', async () => {
    const draws = [0, 1];
    vi.spyOn(Math, 'random').mockImplementation(() => draws.shift() ?? 0.5);

    await park().fetchSignage();

    expect(sent).toHaveLength(1);
    const [lat, lng] = new URL(sent[0]).searchParams.get('loc')!.split(',').map(Number);
    expect(lat).toBeCloseTo(SIGNAGE_BOX.latMin, 10);
    expect(lng).toBeCloseTo(SIGNAGE_BOX.lngMax, 10);
  });

  it('never sends a location outside the box', async () => {
    const p = park();
    for (const r of [0, 0.5, 0.999999]) {
      vi.spyOn(Math, 'random').mockReturnValue(r);
      await p.fetchSignage();
    }
    expect(sent.length).toBeGreaterThan(0);
    for (const u of sent) {
      const [lat, lng] = new URL(u).searchParams.get('loc')!.split(',').map(Number);
      expect(within({lat, lng}, SIGNAGE_BOX), u).toBe(true);
    }
  });
});

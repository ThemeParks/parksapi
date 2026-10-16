import {describe, it, expect} from 'vitest';
import {
  randomPointInRadius,
  randomPointInBoundingBox,
  outOfChina,
  wgs84ToGcj02,
  gcj02ToWgs84,
} from '../geo.js';

const EARTH_RADIUS_M = 6_378_137;

function haversineMetres(a: {latitude: number; longitude: number}, b: {latitude: number; longitude: number}): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

describe('randomPointInRadius', () => {
  it('produces points within the requested radius (with small floating-point slack)', () => {
    const centre = {latitude: 28.4747, longitude: -81.4682};
    const radius = 150;
    for (let i = 0; i < 500; i++) {
      const p = randomPointInRadius(centre, radius);
      const d = haversineMetres(centre, p);
      expect(d).toBeLessThanOrEqual(radius + 1);
    }
  });

  it('produces a non-degenerate spread across many calls', () => {
    // Avoid asserting "two consecutive calls differ" — that's probabilistic.
    // Instead: across 200 samples, we should see meaningful variance.
    const centre = {latitude: 0, longitude: 0};
    const samples = Array.from({length: 200}, () => randomPointInRadius(centre, 100));
    const distinct = new Set(samples.map((p) => `${p.latitude},${p.longitude}`));
    expect(distinct.size).toBeGreaterThan(150);
  });
});

describe('randomPointInBoundingBox', () => {
  it('produces points inside the bounding box', () => {
    for (let i = 0; i < 100; i++) {
      const p = randomPointInBoundingBox(10, 20, -30, -20);
      expect(p.latitude).toBeGreaterThanOrEqual(10);
      expect(p.latitude).toBeLessThanOrEqual(20);
      expect(p.longitude).toBeGreaterThanOrEqual(-30);
      expect(p.longitude).toBeLessThanOrEqual(-20);
    }
  });
});

// Reference pairs from the eviltransform project's own test vectors
// (github.com/googollee/eviltransform, go/transform_test.go), which compare
// against the published GCJ-02 offset. Format: WGS-84 point, GCJ-02 point.
const EVILTRANSFORM_VECTORS = [
  {name: 'Shanghai', wgs: {latitude: 31.1774276, longitude: 121.5272106}, gcj: {latitude: 31.17530398364597, longitude: 121.531541859215}},
  {name: 'Shenzhen', wgs: {latitude: 22.543847, longitude: 113.912316}, gcj: {latitude: 22.540796131694766, longitude: 113.9171764808363}},
  {name: 'Beijing', wgs: {latitude: 39.911954, longitude: 116.377817}, gcj: {latitude: 39.91334545536069, longitude: 116.38404722455657}},
];

describe('outOfChina', () => {
  it('is false for points in mainland China', () => {
    expect(outOfChina({latitude: 31.2, longitude: 121.5})).toBe(false);
    expect(outOfChina({latitude: 39.76, longitude: 98.35})).toBe(false);
  });

  it('is true outside the bounding box', () => {
    expect(outOfChina({latitude: 28.4747, longitude: -81.4682})).toBe(true); // Orlando
    expect(outOfChina({latitude: 51.5, longitude: -0.12})).toBe(true); // London
    expect(outOfChina({latitude: 0, longitude: 0})).toBe(true);
    expect(outOfChina({latitude: 60, longitude: 100})).toBe(true); // north of the box
  });
});

describe('wgs84ToGcj02', () => {
  for (const v of EVILTRANSFORM_VECTORS) {
    it(`matches the eviltransform vector for ${v.name} to 1e-5 degrees`, () => {
      const got = wgs84ToGcj02(v.wgs);
      expect(got.latitude).toBeCloseTo(v.gcj.latitude, 5);
      expect(got.longitude).toBeCloseTo(v.gcj.longitude, 5);
    });
  }

  it('returns a point outside China unchanged', () => {
    const p = {latitude: 28.4747, longitude: -81.4682};
    expect(wgs84ToGcj02(p)).toEqual(p);
  });
});

describe('gcj02ToWgs84', () => {
  for (const v of EVILTRANSFORM_VECTORS) {
    it(`recovers the WGS-84 point for ${v.name} within 0.5 m`, () => {
      expect(haversineMetres(gcj02ToWgs84(v.gcj), v.wgs)).toBeLessThan(0.5);
    });
  }

  it('moves a Chinese GCJ-02 point by the expected few hundred metres', () => {
    const v = EVILTRANSFORM_VECTORS[0];
    const d = haversineMetres(gcj02ToWgs84(v.gcj), v.gcj);
    expect(d).toBeGreaterThan(300);
    expect(d).toBeLessThan(700);
  });

  it('round-trips within 1 mm across mainland China', () => {
    let worst = 0;
    for (let lat = 18; lat <= 53; lat += 1.7) {
      for (let lng = 74; lng <= 134; lng += 2.3) {
        const wgs = {latitude: lat, longitude: lng};
        const back = gcj02ToWgs84(wgs84ToGcj02(wgs));
        worst = Math.max(worst, haversineMetres(back, wgs));
      }
    }
    expect(worst).toBeLessThan(0.001);
  });

  it('returns a point outside China unchanged', () => {
    const p = {latitude: 51.5, longitude: -0.12};
    expect(gcj02ToWgs84(p)).toEqual(p);
  });

  it('returns a new object and leaves its input alone', () => {
    const p = {latitude: 31.17530398364597, longitude: 121.531541859215};
    const copy = {...p};
    const out = gcj02ToWgs84(p);
    expect(out).not.toBe(p);
    expect(p).toEqual(copy);
  });
});

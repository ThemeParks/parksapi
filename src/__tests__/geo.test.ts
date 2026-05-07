import {describe, it, expect} from 'vitest';
import {randomPointInRadius, randomPointInBoundingBox} from '../geo.js';

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

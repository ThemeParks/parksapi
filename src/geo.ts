/**
 * Geospatial utilities.
 */

import {randomBytes} from 'node:crypto';

const EARTH_RADIUS_M = 6_378_137; // WGS84 equatorial radius

export type LatLng = {latitude: number; longitude: number};

/**
 * Cryptographically-strong uniform random in [0, 1) with full 53-bit
 * mantissa precision. We don't actually need crypto strength for jittering
 * coordinates — `Math.random` would be fine — but using `crypto.randomBytes`
 * keeps CodeQL's "insecure randomness" alert quiet without further wiring.
 */
function randomDouble(): number {
  const buf = randomBytes(8);
  // 21 high bits + 32 low bits = 53-bit unsigned int → divide by 2^53
  const high = buf.readUInt32BE(0) >>> 11;
  const low = buf.readUInt32BE(4);
  return (high * 0x1_0000_0000 + low) / 2 ** 53;
}

/**
 * Generate a uniformly-distributed random point within `radiusMetres` of the
 * given centre. Uses an equirectangular approximation, which is accurate for
 * radii up to a few kilometres at non-polar latitudes — fine for theme parks.
 */
export function randomPointInRadius(
  centre: LatLng,
  radiusMetres: number,
): LatLng {
  // Uniform area distribution: r = R * sqrt(u)
  const u = randomDouble();
  const t = 2 * Math.PI * randomDouble();
  const r = radiusMetres * Math.sqrt(u);

  const dx = r * Math.cos(t);
  const dy = r * Math.sin(t);

  const dLat = (dy / EARTH_RADIUS_M) * (180 / Math.PI);
  const dLng = (dx / (EARTH_RADIUS_M * Math.cos((centre.latitude * Math.PI) / 180))) * (180 / Math.PI);

  return {
    latitude: centre.latitude + dLat,
    longitude: centre.longitude + dLng,
  };
}

/**
 * Generate a random point uniformly within an axis-aligned lat/lng bounding box.
 */
export function randomPointInBoundingBox(
  minLat: number,
  maxLat: number,
  minLng: number,
  maxLng: number,
): LatLng {
  return {
    latitude: minLat + randomDouble() * (maxLat - minLat),
    longitude: minLng + randomDouble() * (maxLng - minLng),
  };
}

// ── GCJ-02 datum ────────────────────────────────────────────────────────────
//
// Maps published for mainland China are legally required to use GCJ-02, a
// datum that shifts WGS-84 by an obfuscated, position-dependent offset of a
// few hundred metres. Chinese map SDKs and many Chinese APIs return GCJ-02;
// GPS and OpenStreetMap use WGS-84. The forward transform below is the widely
// reproduced one (as in github.com/googollee/eviltransform). There is no
// closed-form inverse, so gcj02ToWgs84 solves for it by iteration.

// Krasovsky 1940 semi-major axis, the constant in the original GCJ-02 code.
// eviltransform's Go port uses 6378137 here; the two agree to about 1 cm.
const GCJ_SEMI_MAJOR_AXIS = 6_378_245;
const GCJ_ECCENTRICITY_SQ = 0.00669342162296594323;

/**
 * True when a point lies outside the rough mainland-China bounding box where
 * GCJ-02 applies. Points outside it pass through the datum helpers unchanged.
 * The box is the one used by the common reference implementations, so it
 * also covers some neighbouring territory; that matches what Chinese map
 * providers do.
 */
export function outOfChina(p: LatLng): boolean {
  return (
    p.longitude < 72.004 ||
    p.longitude > 137.8347 ||
    p.latitude < 0.8293 ||
    p.latitude > 55.8271
  );
}

function gcjTransform(x: number, y: number): {dLat: number; dLng: number} {
  const xPi = x * Math.PI;
  const yPi = y * Math.PI;
  const shared = 20 * Math.sin(6 * xPi) + 20 * Math.sin(2 * xPi);

  let dLat = shared + 20 * Math.sin(yPi) + 40 * Math.sin(yPi / 3) + 160 * Math.sin(yPi / 12) + 320 * Math.sin(yPi / 30);
  let dLng = shared + 20 * Math.sin(xPi) + 40 * Math.sin(xPi / 3) + 150 * Math.sin(xPi / 12) + 300 * Math.sin(xPi / 30);
  dLat = (dLat * 2) / 3 + -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  dLng = (dLng * 2) / 3 + 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  return {dLat, dLng};
}

/** GCJ-02 offset in degrees at a WGS-84 point. */
function gcjOffset(p: LatLng): {dLat: number; dLng: number} {
  const t = gcjTransform(p.longitude - 105, p.latitude - 35);
  const radLat = (p.latitude / 180) * Math.PI;
  const magic = 1 - GCJ_ECCENTRICITY_SQ * Math.sin(radLat) ** 2;
  const sqrtMagic = Math.sqrt(magic);
  return {
    dLat: (t.dLat * 180) / (((GCJ_SEMI_MAJOR_AXIS * (1 - GCJ_ECCENTRICITY_SQ)) / (magic * sqrtMagic)) * Math.PI),
    dLng: (t.dLng * 180) / ((GCJ_SEMI_MAJOR_AXIS / sqrtMagic) * Math.cos(radLat) * Math.PI),
  };
}

/**
 * Convert a WGS-84 point to GCJ-02. Returns a copy of the input when the
 * point is outside mainland China.
 */
export function wgs84ToGcj02(p: LatLng): LatLng {
  if (outOfChina(p)) return {latitude: p.latitude, longitude: p.longitude};
  const d = gcjOffset(p);
  return {latitude: p.latitude + d.dLat, longitude: p.longitude + d.dLng};
}

/**
 * Convert a GCJ-02 point to WGS-84. Returns a copy of the input when the
 * point is outside mainland China.
 *
 * Fixed-point iteration on the forward transform: start from the GCJ-02 point
 * itself, push the guess through wgs84ToGcj02, and correct by the residual.
 * The offset changes slowly across a few hundred metres, so this converges to
 * well under a millimetre in three or four steps; the loop stops once a step
 * moves the guess by less than 1e-10 degrees, or after 10 steps.
 */
export function gcj02ToWgs84(p: LatLng): LatLng {
  if (outOfChina(p)) return {latitude: p.latitude, longitude: p.longitude};
  let lat = p.latitude;
  let lng = p.longitude;
  for (let i = 0; i < 10; i++) {
    const g = wgs84ToGcj02({latitude: lat, longitude: lng});
    const errLat = g.latitude - p.latitude;
    const errLng = g.longitude - p.longitude;
    lat -= errLat;
    lng -= errLng;
    if (Math.abs(errLat) < 1e-10 && Math.abs(errLng) < 1e-10) break;
  }
  return {latitude: lat, longitude: lng};
}

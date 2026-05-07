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

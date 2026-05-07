/**
 * Geospatial utilities.
 */

const EARTH_RADIUS_M = 6_378_137; // WGS84 equatorial radius

export type LatLng = {latitude: number; longitude: number};

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
  const u = Math.random();
  const t = 2 * Math.PI * Math.random();
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
    latitude: minLat + Math.random() * (maxLat - minLat),
    longitude: minLng + Math.random() * (maxLng - minLng),
  };
}

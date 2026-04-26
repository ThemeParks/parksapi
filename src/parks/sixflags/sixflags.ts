/**
 * Six Flags Theme Park Framework
 *
 * Single-class implementation serving 25+ Six Flags parks dynamically
 * discovered via Firebase Remote Config. Supports real-time wait times,
 * venue status, POI data, operating hours, and show times.
 *
 * Parks are discovered from Firebase config's parkTypeHourAvailability,
 * with water parks extracted from the otherParks array. Each main park
 * becomes its own destination with park entities underneath.
 *
 * @module sixflags
 */

import {Destination, type DestinationConstructor} from '../../destination.js';
import crypto from 'crypto';
import config from '../../config.js';
import {http, type HTTPObj} from '../../http.js';
import {cache} from '../../cache.js';
import {reusable} from '../../promiseReuse.js';
import {destinationController} from '../../destinationRegistry.js';
import type {Entity, LiveData, EntitySchedule} from '@themeparks/typelib';
import {formatInTimezone, addMinutes, constructDateTime} from '../../datetime.js';
import {decodeHtmlEntities, stripHtmlTags} from '../../htmlUtils.js';
import tzLookup from 'tz-lookup';

// ============================================================================
// API Response Types
// ============================================================================

/** Firebase Remote Config response */
type FirebaseConfigResponse = {
  entries: Record<string, string>;
};

/** Park hour settings from Firebase config */
type ParkHourSetting = {
  parkId: number;
  code: string;
  showThemePark: boolean;
  otherParks?: Array<{
    label: string;
    fimsId: number;
    fimsSiteCode: string;
    subProperty?: string;
  }>;
};

/** Park configuration from oneShot.parks_configuration */
type ParkConfiguration = {
  parkId: number;
  parkName: string;
};

/** Resolved park data used throughout the class */
type SixFlagsParkData = {
  parkId: number;
  code: string;
  name: string;
  waterParks: Array<{
    parkId: number;
    code: string;
    name: string;
    label: string;
  }>;
};

/** POI (Point of Interest) data from the API */
type SixFlagsPOI = {
  fimsId: string;
  name: string;
  parkId: number;
  venueId: number;
  location?: {
    latitude: string;
    longitude: string;
  };
  lat?: string;
  lng?: string;
};

/** Venue status API response */
type SixFlagsVenueStatus = {
  parkName: string;
  lat: string;
  lng: string;
  venues: Array<{
    venueId: number;
    details: Array<{
      fimsId: string;
      status: string;
    }>;
  }>;
};

/** Wait times API response */
type SixFlagsWaitTimes = {
  venues: Array<{
    venueId: number;
    details: Array<{
      fimsId: string;
      regularWaittime?: {
        waitTime: number;
      };
      isFastLane?: boolean;
      fastlaneWaittime?: {
        waitTime: number;
      };
    }>;
  }>;
};

/** Operating hours API response */
type SixFlagsOperatingHours = {
  dates: Array<{
    date: string; // "MM/DD/YYYY"
    isParkClosed: boolean;
    venues: Array<{
      venueId: number;
      detailHours: Array<{
        operatingTimeFrom: string;
        operatingTimeTo: string;
      }>;
    }>;
    /**
     * Park-level operating windows. The vendor publishes per-park hours
     * (e.g. operatingTypeName="Park", id 24) here independently of the
     * per-ride detailHours array, which is sometimes empty even for days
     * the park is open. La Ronde publishes hours exclusively via this
     * field. Always prefer this over detailHours when populated.
     */
    operatings?: Array<{
      operatingTypeId: number;
      operatingTypeName: string;
      items: Array<{
        assignmentDisplayName?: string;
        timeFrom: string;
        timeTo: string;
      }>;
    }>;
    shows?: Array<{
      fimsId: string;
      items: Array<{
        times: string; // "hh:mm AM, ..."
        assignmentLocation?: string;
      }>;
    }>;
  }>;
};

// ============================================================================
// Constants
// ============================================================================

/** Park IDs where wait-times endpoint is unavailable (water parks, etc.) */
const PARKS_WITHOUT_WAIT_TIMES = new Set([942, 944, 947, 948, 959]);

/** Default show duration in minutes when not otherwise specified */
const DEFAULT_SHOW_DURATION_MINUTES = 30;

// ============================================================================
// Helpers
// ============================================================================

/**
 * Strip HTML tags and decode common HTML entities from POI names.
 */
function cleanHtmlName(name: string): string {
  return decodeHtmlEntities(stripHtmlTags(name));
}

/**
 * Parse latitude/longitude from a POI, handling both location object
 * and top-level lat/lng fields. Applies Western Hemisphere longitude fix.
 *
 * Returns null if coordinates are invalid or (0, 0).
 */
function parseCoordinates(poi: SixFlagsPOI): {latitude: number; longitude: number} | null {
  let lat: number | undefined;
  let lng: number | undefined;

  if (poi.location?.latitude && poi.location?.longitude) {
    lat = parseFloat(poi.location.latitude);
    lng = parseFloat(poi.location.longitude);
  } else if (poi.lat && poi.lng) {
    lat = parseFloat(poi.lat);
    lng = parseFloat(poi.lng);
  }

  if (lat === undefined || lng === undefined || isNaN(lat) || isNaN(lng)) {
    return null;
  }

  // Reject (0, 0) placeholder
  if (lat === 0 && lng === 0) {
    return null;
  }

  // Validate range
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return null;
  }

  // Fix: API sometimes returns positive longitudes for Western Hemisphere parks
  if (lng > 0) {
    lng = -lng;
  }

  return {latitude: lat, longitude: lng};
}

/**
 * Compute a park centroid from its POI data — averages the valid
 * coordinates of all rides (venueId=1) whose `parkId` matches. Applies
 * the Western-Hemisphere longitude fix to each row before averaging.
 *
 * The `/venue-status/park/{id}` response doesn't expose a park location,
 * so this POI-derived centroid is the only server-provided coordinate.
 */
function parkCentroidFromPOI(
  poi: SixFlagsPOI[],
  parkId: number,
): {latitude: number; longitude: number} | null {
  let latSum = 0, lngSum = 0, count = 0;
  for (const p of poi) {
    if (p.parkId !== parkId) continue;
    if (p.venueId !== 1) continue; // rides only — most consistently geolocated
    const coords = parseCoordinates(p);
    if (!coords) continue;
    latSum += coords.latitude;
    lngSum += coords.longitude;
    count++;
  }
  if (count === 0) return null;
  return {latitude: latSum / count, longitude: lngSum / count};
}

/**
 * Resolve IANA timezone from coordinates. tz-lookup uses tzdb polygon data so
 * it correctly handles state-level exceptions the old longitude-band heuristic
 * got wrong (Michigan, Indiana's Eastern counties, Arizona's no-DST rule, the
 * Ohio/Kentucky Eastern salient, Mexico, Quebec, etc.).
 */
function timezoneFromCoords(latitude: number, longitude: number): string {
  try {
    return tzLookup(latitude, longitude);
  } catch {
    return 'America/New_York';
  }
}

// ============================================================================
// Manual water-park grouping overrides
// ============================================================================
//
// Firebase's parkHourSettings lists each water park with showThemePark=true
// whenever the vendor runs it as its own gated operation, even when the site
// is physically adjacent to a Six Flags theme park and has always been
// surfaced on the wiki as a child of that park. Only a handful of water
// parks are nested under a theme park in Firebase's own otherParks array
// (currently HHNJ/HHLA/HHCH) — the rest we fold in manually here.
//
// Keys are fimsId (= Firebase parkId). Values are the fimsId of the theme
// park that should become their parent destination.
const WATERPARK_PARENT_OVERRIDES: Record<number, number> = {
  913: 901, // Hurricane Harbor Arlington  → Six Flags Over Texas
  944: 943, // Hurricane Harbor Oklahoma City → Six Flags Frontier City
};

// ============================================================================
// Main Class
// ============================================================================

/**
 * Six Flags theme park destination.
 *
 * One registered class that dynamically discovers all Six Flags parks from
 * Firebase Remote Config and serves them as separate destination/park groups.
 */
@destinationController({category: 'Six Flags'})
export class SixFlags extends Destination {
  /** Base URL for the Six Flags CDN API (no auth needed) */
  @config
  baseUrl: string = '';

  /** Firebase API key for remote config */
  @config
  firebaseApiKey: string = '';

  /** Firebase project ID */
  @config
  firebaseProjectId: string = '';

  /** Firebase app ID */
  @config
  firebaseAppId: string = '';

  /** Android package name for Firebase requests */
  @config
  androidPackage: string = '';

  /** Fallback timezone (per-park timezone is derived from GPS) */
  @config
  timezone: string = 'America/New_York';

  constructor(options?: DestinationConstructor) {
    super(options);
    this.addConfigPrefix('SIXFLAGS');
  }

  /**
   * Cache key prefix. Single instance, but all cached methods that
   * take parkID as an argument are naturally unique.
   */
  getCacheKeyPrefix(): string {
    return 'sixflags';
  }

  // ============================================================================
  // Firebase Authentication
  // ============================================================================

  /**
   * Generate a fake Firebase Installation ID (FID).
   * Cached for 8 days to reuse across requests.
   */
  @cache({ttlSeconds: 60 * 60 * 24 * 8})
  async getFirebaseInstallationId(): Promise<string> {
    const bytes = crypto.randomBytes(17);
    bytes[0] = 0x70 | (bytes[0] % 0x10);
    const fid = Buffer.from(bytes).toString('base64url').slice(0, 22);
    return fid;
  }

  // ============================================================================
  // HTTP Fetch Methods
  // ============================================================================

  /**
   * Fetch Firebase Remote Config (park discovery data).
   * Cached 24h at HTTP level.
   */
  @http({cacheSeconds: 86400})
  async fetchFirebaseConfig(): Promise<HTTPObj> {
    const fid = await this.getFirebaseInstallationId();

    return {
      method: 'POST',
      url: `https://firebaseremoteconfig.googleapis.com/v1/projects/${this.firebaseProjectId}/namespaces/firebase:fetch`,
      headers: {
        'X-Goog-Api-Key': this.firebaseApiKey,
      },
      body: {
        appInstanceId: fid,
        appId: this.firebaseAppId,
        packageName: this.androidPackage,
        languageCode: 'en_GB',
      },
      options: {json: true},
    } as any as HTTPObj;
  }

  /**
   * Fetch POI data for a specific park.
   * Cached 24h at HTTP level.
   */
  @http({cacheSeconds: 86400})
  async fetchPOI(parkId: number): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.baseUrl}/poi/park/${parkId}`,
      options: {json: true},
    } as any as HTTPObj;
  }

  /**
   * Fetch venue status for a specific park.
   * Cached 1min at HTTP level.
   */
  @http({cacheSeconds: 60})
  async fetchVenueStatus(parkId: number): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.baseUrl}/venue-status/park/${parkId}`,
      options: {json: true},
    } as any as HTTPObj;
  }

  /**
   * Fetch wait times for a specific park.
   * Cached 1min at HTTP level, no retries (some parks don't have this endpoint).
   */
  @http({cacheSeconds: 60, retries: 0})
  async fetchWaitTimes(parkId: number): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.baseUrl}/wait-times/park/${parkId}`,
      options: {json: true},
    } as any as HTTPObj;
  }

  /**
   * Fetch operating hours for a specific park and month.
   * Cached 24h at HTTP level.
   */
  @http({cacheSeconds: 86400})
  async fetchOperatingHours(parkId: number, date: string): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.baseUrl}/operating-hours/park/${parkId}?date=${date}`,
      options: {json: true},
    } as any as HTTPObj;
  }

  // ============================================================================
  // Cached Getter Methods
  // ============================================================================

  /**
   * Get Firebase Remote Config entries (cached 24h).
   */
  @cache({ttlSeconds: 86400})
  async getFirebaseConfig(): Promise<Record<string, string>> {
    const resp = await this.fetchFirebaseConfig();
    const data: FirebaseConfigResponse = await resp.json();
    return data?.entries || {};
  }

  /**
   * Get the fully resolved list of parks with names and water park info (cached 24h).
   *
   * Bump `cacheVersion` whenever the shape of this method's result changes
   * (new fields, new grouping rules like WATERPARK_PARENT_OVERRIDES, …).
   * Old entries become unreachable and expire on their TTL — no manual flush.
   */
  @cache({ttlSeconds: 86400, cacheVersion: 2})
  async getParkData(): Promise<SixFlagsParkData[]> {
    const entries = await this.getFirebaseConfig();

    // Parse parkTypeHourAvailability
    const parkTypeHourAvailability = entries['parkTypeHourAvailability'];
    if (!parkTypeHourAvailability) {
      throw new Error('No parkTypeHourAvailability found in Firebase config');
    }

    const parkHourSettings: {parkHourSettings: Record<string, ParkHourSetting>} =
      JSON.parse(parkTypeHourAvailability);
    const settings = parkHourSettings?.parkHourSettings || {};

    // Build park names lookup from oneShot config
    const parkNamesMap = new Map<number, string>();
    if (entries['oneShot']) {
      try {
        const oneShot = JSON.parse(entries['oneShot']);
        const parksConfig: ParkConfiguration[] = oneShot?.parks_configuration || [];
        for (const park of parksConfig) {
          parkNamesMap.set(park.parkId, park.parkName);
        }
      } catch {
        // Ignore parse errors in oneShot
      }
    }

    // Filter to theme parks (showThemePark === true)
    // The parkId is the key of the settings object, not a field on the value
    const allMainCandidates = Object.entries(settings)
      .filter(([, s]) => s.showThemePark === true)
      .map(([id, s]) => ({ ...s, parkId: parseInt(id, 10) }));

    // Resolve the overridden children once, so we can both skip them in the
    // main-park list and attach them as waterParks on their declared parents.
    // Names go through the same oneShot → venue-status fallback main parks use.
    const overriddenChildIds = new Set(Object.keys(WATERPARK_PARENT_OVERRIDES).map(Number));
    const overrideChildren = new Map<number, {parkId: number; code: string; name: string}>();
    await Promise.all(
      allMainCandidates
        .filter(c => overriddenChildIds.has(c.parkId))
        .map(async c => {
          let name = parkNamesMap.get(c.parkId);
          if (!name) {
            try {
              const resp = await this.fetchVenueStatus(c.parkId);
              const vs: SixFlagsVenueStatus = await resp.json();
              name = vs?.parkName || undefined;
            } catch {
              // fall through to code
            }
          }
          overrideChildren.set(c.parkId, {
            parkId: c.parkId,
            code: c.code,
            name: name || c.code,
          });
        }),
    );

    const mainParks = allMainCandidates.filter(p => !overriddenChildIds.has(p.parkId));

    // Resolve names in parallel (fallback to venue-status API)
    const parks = await Promise.all(mainParks.map(async (park) => {
      let name = parkNamesMap.get(park.parkId);

      // Fallback: fetch park name from venue status endpoint
      if (!name) {
        try {
          const resp = await this.fetchVenueStatus(park.parkId);
          const vs: SixFlagsVenueStatus = await resp.json();
          name = vs?.parkName || undefined;
        } catch {
          // Ignore - name will fall back to code
        }
      }

      // Extract water parks from otherParks array
      const waterParks = (park.otherParks || [])
        .filter(op => op.label === 'Water Park' && op.fimsId && op.fimsSiteCode)
        .map(op => ({
          parkId: op.fimsId,
          code: op.fimsSiteCode,
          name: op.subProperty || `Water Park ${op.fimsSiteCode}`,
          label: op.label,
        }));

      // Fold in any water parks we've manually re-parented to this theme park.
      for (const [childId, parentId] of Object.entries(WATERPARK_PARENT_OVERRIDES)) {
        if (parentId !== park.parkId) continue;
        const child = overrideChildren.get(Number(childId));
        if (!child) continue;
        if (waterParks.some(wp => wp.parkId === child.parkId)) continue;
        waterParks.push({
          parkId: child.parkId,
          code: child.code,
          name: child.name,
          label: 'Water Park',
        });
      }

      return {
        parkId: park.parkId,
        code: park.code,
        name: name || park.code,
        waterParks,
      } as SixFlagsParkData;
    }));

    return parks;
  }

  /**
   * Get POI data for a specific park (cached 24h).
   */
  @cache({ttlSeconds: 86400})
  async getPOI(parkId: number): Promise<SixFlagsPOI[]> {
    try {
      const resp = await this.fetchPOI(parkId);
      const data = await resp.json();
      return Array.isArray(data) ? data : [];
    } catch {
      // Some parks (international/new) don't have POI data yet
      return [];
    }
  }

  /**
   * Get venue status for a specific park (cached 1min).
   * Returns null on failure (graceful degradation).
   */
  @cache({ttlSeconds: 60})
  async getVenueStatus(parkId: number): Promise<SixFlagsVenueStatus | null> {
    try {
      const resp = await this.fetchVenueStatus(parkId);
      return await resp.json();
    } catch {
      return null;
    }
  }

  /**
   * Water park IDs derived from getParkData — these don't expose the
   * /wait-times endpoint so we skip the fetch to avoid noisy 404s.
   */
  private async getWaterParkIdSet(): Promise<Set<number>> {
    const parks = await this.getParkData();
    const set = new Set<number>();
    for (const p of parks) {
      for (const wp of p.waterParks) set.add(wp.parkId);
    }
    return set;
  }

  /**
   * Get wait times for a specific park (cached 1min).
   * Returns null for water parks (which don't expose this endpoint) and on
   * any fetch failure.
   */
  @cache({ttlSeconds: 60})
  async getWaitTimes(parkId: number): Promise<SixFlagsWaitTimes | null> {
    const waterParkIds = await this.getWaterParkIdSet();
    if (waterParkIds.has(parkId) || PARKS_WITHOUT_WAIT_TIMES.has(parkId)) {
      return null;
    }
    try {
      const resp = await this.fetchWaitTimes(parkId);
      return await resp.json();
    } catch {
      return null;
    }
  }

  /**
   * Get operating hours for a specific park and month (cached 24h).
   * Returns null on failure.
   */
  @cache({ttlSeconds: 86400})
  async getOperatingHours(parkId: number, date: string): Promise<SixFlagsOperatingHours | null> {
    try {
      const resp = await this.fetchOperatingHours(parkId, date);
      return await resp.json();
    } catch {
      return null;
    }
  }

  // ============================================================================
  // Timezone Helpers
  // ============================================================================

  /**
   * Get the timezone for a park, derived from its GPS coordinates.
   * Falls back to instance timezone if no location available.
   */
  /**
   * Timezone lookup. Uses the main-park's POI (same response includes sister
   * water park POIs, keyed by `parkId`) rather than fetching /poi/park/{id}
   * per park — water parks return 404 on their own POI endpoint.
   */
  private async getTimezoneForPark(parkId: number): Promise<string> {
    // Find which main-park this parkId belongs to (itself, or a sister water park).
    const parks = await this.getParkData();
    const owner = parks.find((p) =>
      p.parkId === parkId || p.waterParks.some((wp) => wp.parkId === parkId),
    );
    const sourceParkId = owner?.parkId ?? parkId;
    const poi = await this.getPOI(sourceParkId);
    const coords = parkCentroidFromPOI(poi, parkId);
    if (coords) return timezoneFromCoords(coords.latitude, coords.longitude);
    return this.timezone;
  }

  // ============================================================================
  // Status Mapping
  // ============================================================================

  /**
   * Map venue status string to framework status.
   */
  private mapStatus(status: string, waitTime: number | null): string {
    const s = status.toLowerCase();
    if (s === 'open' || s === 'opened') return 'OPERATING';
    if (s === 'temp closed' || s === 'temp closed due weather') return 'DOWN';
    if (s === 'not scheduled') return 'CLOSED';
    if (s === '') {
      // No status from venue - use wait time as fallback
      return (waitTime !== null && waitTime >= 0) ? 'OPERATING' : 'CLOSED';
    }
    // Unknown status - default to operating
    return 'OPERATING';
  }

  // ============================================================================
  // Entity Building
  // ============================================================================

  async getDestinations(): Promise<Entity[]> {
    const parks = await this.getParkData();
    const destinations: Entity[] = [];

    for (const park of parks) {
      const tz = await this.getTimezoneForPark(park.parkId);
      const poi = await this.getPOI(park.parkId);
      const location = parkCentroidFromPOI(poi, park.parkId);

      destinations.push({
        id: `sixflags_destination_${park.code}`,
        name: park.name,
        entityType: 'DESTINATION',
        timezone: tz,
        ...(location ? {location} : {}),
      } as Entity);
    }

    return destinations;
  }

  protected async buildEntityList(): Promise<Entity[]> {
    const parks = await this.getParkData();
    const entities: Entity[] = [];

    for (const park of parks) {
      const tz = await this.getTimezoneForPark(park.parkId);
      const destinationId = `sixflags_destination_${park.code}`;
      const mainParkId = `sixflags_park_${park.code}`;

      // Get park-level location — centroid of the main park's rides.
      const poiData = await this.getPOI(park.parkId);
      const parkLocation = parkCentroidFromPOI(poiData, park.parkId);

      // Destination entity
      entities.push({
        id: destinationId,
        name: park.name,
        entityType: 'DESTINATION',
        timezone: tz,
        ...(parkLocation ? {location: parkLocation} : {}),
      } as Entity);

      // Main park entity
      entities.push({
        id: mainParkId,
        name: park.name,
        entityType: 'PARK',
        parentId: destinationId,
        destinationId,
        timezone: tz,
        ...(parkLocation ? {location: parkLocation} : {}),
      } as Entity);

      // Water park entities (share parent's destination). The sister water
      // park's own /poi/park/{id} 404s on the Six Flags API, but the sister
      // items live inside the main park's POI response keyed by `parkId`.
      for (const wp of park.waterParks) {
        const wpTz = await this.getTimezoneForPark(wp.parkId);
        const wpLocation = parkCentroidFromPOI(poiData, wp.parkId) ?? parkLocation;

        entities.push({
          id: `sixflags_park_${wp.code}`,
          name: wp.name,
          entityType: 'PARK',
          parentId: destinationId,
          destinationId,
          timezone: wpTz,
          ...(wpLocation ? {location: wpLocation} : {}),
        } as Entity);
      }

      // Emit main-park attractions/shows/restaurants from the POI data we
      // already fetched above for location calculation.
      if (Array.isArray(poiData)) {
        // Rides (venueId: 1)
        const rides = poiData.filter(poi => poi.venueId === 1 && poi.parkId === park.parkId);
        entities.push(...this.mapPOIEntities(rides, mainParkId, destinationId, tz, 'ATTRACTION', parkLocation));

        // Shows (venueId: 2)
        const shows = poiData.filter(poi => poi.venueId === 2 && poi.parkId === park.parkId);
        entities.push(...this.mapPOIEntities(shows, mainParkId, destinationId, tz, 'SHOW', parkLocation));

        // Restaurants (venueId: 4)
        const restaurants = poiData.filter(poi => poi.venueId === 4 && poi.parkId === park.parkId);
        entities.push(...this.mapPOIEntities(restaurants, mainParkId, destinationId, tz, 'RESTAURANT', parkLocation));

        // Water-park children — filter the same POI response by the water
        // park's parkId. /poi/park/{wpId} doesn't work.
        for (const wp of park.waterParks) {
          const wpParkEntityId = `sixflags_park_${wp.code}`;
          const wpTz = await this.getTimezoneForPark(wp.parkId);
          const wpLocation = parkCentroidFromPOI(poiData, wp.parkId) ?? parkLocation;

          const wpRides = poiData.filter(poi => poi.venueId === 1 && poi.parkId === wp.parkId);
          entities.push(...this.mapPOIEntities(wpRides, wpParkEntityId, destinationId, wpTz, 'ATTRACTION', wpLocation));

          const wpShows = poiData.filter(poi => poi.venueId === 2 && poi.parkId === wp.parkId);
          entities.push(...this.mapPOIEntities(wpShows, wpParkEntityId, destinationId, wpTz, 'SHOW', wpLocation));

          const wpRestaurants = poiData.filter(poi => poi.venueId === 4 && poi.parkId === wp.parkId);
          entities.push(...this.mapPOIEntities(wpRestaurants, wpParkEntityId, destinationId, wpTz, 'RESTAURANT', wpLocation));
        }
      }
    }

    return entities;
  }

  /**
   * Map POI data to Entity objects with location and name cleanup.
   */
  private mapPOIEntities(
    pois: SixFlagsPOI[],
    parkEntityId: string,
    destinationId: string,
    tz: string,
    entityType: Entity['entityType'],
    fallbackLocation: {latitude: number; longitude: number} | null,
  ): Entity[] {
    return this.mapEntities(pois, {
      idField: 'fimsId',
      nameField: (poi) => cleanHtmlName(poi.name),
      entityType,
      parentIdField: () => parkEntityId,
      destinationId,
      timezone: tz,
      locationFields: {
        lat: (poi: SixFlagsPOI) => {
          const coords = parseCoordinates(poi);
          return coords?.latitude;
        },
        lng: (poi: SixFlagsPOI) => {
          const coords = parseCoordinates(poi);
          return coords?.longitude;
        },
      },
      transform: (entity, poi) => {
        if (entityType === 'ATTRACTION') {
          (entity as any).attractionType = 'RIDE';
        }
        // Fall back to the park's centroid when the POI didn't carry
        // coordinates. Shows and outdoor restaurants are the main offenders;
        // without this they'd have no location at all.
        if (!(entity as any).location && fallbackLocation) {
          (entity as any).location = fallbackLocation;
        }
        return entity;
      },
    });
  }

  // ============================================================================
  // Live Data
  // ============================================================================

  /**
   * The collector creates one ResortSync per destination entity (33 of them)
   * but they all share a single SixFlags instance. Without dedup, each poll
   * fires 33 concurrent buildLiveData() calls that assemble the same 1446-item
   * array. @reusable() coalesces the in-flight calls so only one runs per
   * burst; the next poll starts fresh.
   */
  @reusable()
  protected async buildLiveData(): Promise<LiveData[]> {
    const parks = await this.getParkData();
    const liveData: LiveData[] = [];
    const addedIds = new Set<string>(); // Track processed fimsId to prevent duplicates

    for (const park of parks) {
      // Process main park
      await this.buildParkLiveData(park.parkId, park.code, liveData, addedIds);

      // Process water parks
      for (const wp of park.waterParks) {
        await this.buildParkLiveData(wp.parkId, wp.code, liveData, addedIds);
      }
    }

    return liveData;
  }

  /**
   * Build live data for a single park (rides + shows).
   */
  private async buildParkLiveData(
    parkId: number,
    parkCode: string,
    liveData: LiveData[],
    addedIds: Set<string>,
  ): Promise<void> {
    const venueStatus = await this.getVenueStatus(parkId);
    if (!venueStatus?.venues) return;

    // Build venue status lookup
    const statusMap = new Map<string, string>();
    for (const venue of venueStatus.venues) {
      if (venue.details) {
        for (const detail of venue.details) {
          statusMap.set(detail.fimsId, detail.status || '');
        }
      }
    }

    // Fetch wait times (may be null for some parks)
    const waitTimesData = await this.getWaitTimes(parkId);
    const waitTimesMap = new Map<string, {regularWaittime?: {waitTime: number}; isFastLane?: boolean; fastlaneWaittime?: {waitTime: number}}>();
    if (waitTimesData?.venues) {
      for (const venue of waitTimesData.venues) {
        if (venue.details) {
          for (const detail of venue.details) {
            waitTimesMap.set(detail.fimsId, detail);
          }
        }
      }
    }

    // Process rides (venueId: 1) from venue status
    const ridesVenue = venueStatus.venues.find(v => v.venueId === 1);
    if (ridesVenue?.details) {
      for (const ride of ridesVenue.details) {
        if (addedIds.has(ride.fimsId)) continue;
        addedIds.add(ride.fimsId);

        const waitInfo = waitTimesMap.get(ride.fimsId);
        let waitTime: number | null = null;

        if (waitInfo?.regularWaittime?.waitTime != null) {
          const wt = Number(waitInfo.regularWaittime.waitTime);
          if (Number.isFinite(wt)) waitTime = wt;
        }

        const venueStatusStr = ride.status || '';
        const status = this.mapStatus(venueStatusStr, waitTime);

        // Null out wait time if not operating
        if (status !== 'OPERATING') {
          waitTime = null;
        }

        const ld: LiveData = {
          id: ride.fimsId,
          status,
        } as LiveData;

        ld.queue = {
          STANDBY: {waitTime: waitTime ?? undefined},
        };

        // Add Fast Lane (paid standby) if available
        if (status === 'OPERATING' && waitInfo?.isFastLane && waitInfo.fastlaneWaittime?.waitTime != null) {
          const flWait = Number(waitInfo.fastlaneWaittime.waitTime);
          if (Number.isFinite(flWait) && flWait > 0) {
            ld.queue!.PAID_STANDBY = {waitTime: flWait};
          }
        }

        liveData.push(ld);
      }
    }

    // Process shows (venueId: 2) from venue status
    const showsVenue = venueStatus.venues.find(v => v.venueId === 2);
    if (showsVenue?.details) {
      const tz = await this.getTimezoneForPark(parkId);

      // Fetch today's show times from operating hours
      const todayFormatted = formatInTimezone(new Date(), tz, 'date'); // MM/DD/YYYY
      const now = new Date();
      const yearStr = String(now.getFullYear());
      const monthStr = String(now.getMonth() + 1).padStart(2, '0');
      const currentMonth = `${yearStr}${monthStr}`;

      let todayShows: SixFlagsOperatingHours['dates'][0]['shows'] = [];
      const hoursData = await this.getOperatingHours(parkId, currentMonth);
      if (hoursData?.dates) {
        const todayEntry = hoursData.dates.find(d => d.date === todayFormatted);
        if (todayEntry?.shows) {
          todayShows = todayEntry.shows;
        }
      }

      // Build show times lookup
      const showTimesMap = new Map<string, SixFlagsOperatingHours['dates'][0]['shows']>();
      if (todayShows) {
        for (const show of todayShows) {
          const existing = showTimesMap.get(show.fimsId) || [];
          existing.push(show);
          showTimesMap.set(show.fimsId, existing as any);
        }
      }

      for (const show of showsVenue.details) {
        if (addedIds.has(show.fimsId)) continue;
        addedIds.add(show.fimsId);

        const ld: LiveData = {
          id: show.fimsId,
          status: 'OPERATING',
        } as LiveData;

        // Parse show times
        const showTimeEntries = showTimesMap.get(show.fimsId);
        if (showTimeEntries) {
          const showtimes: Array<{startTime: string; endTime: string; type: string}> = [];

          for (const entry of showTimeEntries) {
            for (const item of (entry as any).items || []) {
              if (!item.times?.trim()) continue;

              // Parse comma-separated times (e.g., "02:00 PM, 05:15 PM")
              const times = item.times.split(',').map((t: string) => t.trim()).filter((t: string) => t);

              for (const timeStr of times) {
                const startTime = this.parseShowTime(timeStr, todayFormatted, tz);
                if (startTime) {
                  const endTime = addMinutes(new Date(startTime), DEFAULT_SHOW_DURATION_MINUTES);
                  showtimes.push({
                    startTime,
                    endTime: formatInTimezone(endTime, tz, 'iso'),
                    type: 'Performance Time',
                  });
                }
              }
            }
          }

          if (showtimes.length > 0) {
            (ld as any).showtimes = showtimes;
          }
        }

        liveData.push(ld);
      }
    }
  }

  /**
   * Parse a time string in "hh:mm AM/PM" format into an ISO string
   * in the park's timezone.
   */
  private parseShowTime(timeStr: string, dateFormatted: string, tz: string): string | null {
    // Match "02:00 PM" or "5:15 AM" format
    const match = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    if (!match) return null;

    let hour = parseInt(match[1], 10);
    const minute = parseInt(match[2], 10);
    const isPm = match[3].toUpperCase() === 'PM';

    if (isPm && hour !== 12) hour += 12;
    if (!isPm && hour === 12) hour = 0;

    // Build date from MM/DD/YYYY format
    const dateParts = dateFormatted.split('/');
    if (dateParts.length !== 3) return null;

    const dateStr = `${dateParts[2]}-${dateParts[0]}-${dateParts[1]}`;
    const timeFormatted = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

    return constructDateTime(dateStr, timeFormatted, tz);
  }

  // ============================================================================
  // Schedules
  // ============================================================================

  protected async buildSchedules(): Promise<EntitySchedule[]> {
    const parks = await this.getParkData();
    const schedules: EntitySchedule[] = [];

    // Generate current month + 2 forward months
    const now = new Date();
    const months: string[] = [];
    for (let i = 0; i < 3; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
      const y = String(d.getFullYear());
      const m = String(d.getMonth() + 1).padStart(2, '0');
      months.push(`${y}${m}`);
    }

    for (const park of parks) {
      const tz = await this.getTimezoneForPark(park.parkId);
      const parkEntityId = `sixflags_park_${park.code}`;
      const parkSchedule = await this.buildParkSchedule(park.parkId, tz, months);

      schedules.push({
        id: parkEntityId,
        schedule: parkSchedule,
      } as EntitySchedule);

      // Water park schedules
      for (const wp of park.waterParks) {
        const wpTz = await this.getTimezoneForPark(wp.parkId);
        const wpEntityId = `sixflags_park_${wp.code}`;
        const wpSchedule = await this.buildParkSchedule(wp.parkId, wpTz, months);

        schedules.push({
          id: wpEntityId,
          schedule: wpSchedule,
        } as EntitySchedule);
      }
    }

    return schedules;
  }

  /**
   * Build schedule entries for a single park across multiple months.
   */
  private async buildParkSchedule(
    parkId: number,
    tz: string,
    months: string[],
  ): Promise<Array<{date: string; type: string; openingTime: string; closingTime: string}>> {
    const scheduleEntries: Array<{date: string; type: string; openingTime: string; closingTime: string}> = [];

    for (const month of months) {
      const hoursData = await this.getOperatingHours(parkId, month);
      if (!hoursData?.dates) continue;

      for (const dateObj of hoursData.dates) {
        if (dateObj.isParkClosed) continue;

        // Prefer the canonical `operatings` array — vendors increasingly
        // publish per-park hours here while leaving per-ride detailHours
        // empty (La Ronde does this for its entire operating season).
        const parkOperatings = (dateObj.operatings || []).flatMap(op =>
          (op.operatingTypeName === 'Park' || op.operatingTypeId === 24)
            ? (op.items || []).filter(i => i.timeFrom && i.timeTo)
            : [],
        );

        let earliestOpen: string;
        let latestClose: string;

        if (parkOperatings.length > 0) {
          const opens = parkOperatings.map(i => i.timeFrom).sort();
          const closes = parkOperatings.map(i => i.timeTo).sort();
          earliestOpen = opens[0];
          latestClose = closes[closes.length - 1];
        } else {
          // Fall back to per-ride detailHours.
          const ridesVenue = dateObj.venues?.find(v => v.venueId === 1);
          if (!ridesVenue?.detailHours || ridesVenue.detailHours.length === 0) continue;

          const validHours = ridesVenue.detailHours.filter(h => h.operatingTimeFrom && h.operatingTimeTo);
          if (validHours.length === 0) continue;

          const opens = validHours.map(h => h.operatingTimeFrom).sort();
          const closes = validHours.map(h => h.operatingTimeTo).sort();
          earliestOpen = opens[0];
          latestClose = closes[closes.length - 1];
        }

        // Parse date from MM/DD/YYYY format
        const dateParts = dateObj.date.split('/');
        if (dateParts.length !== 3) continue;
        const dateStr = `${dateParts[2]}-${dateParts[0]}-${dateParts[1]}`;

        scheduleEntries.push({
          date: dateStr,
          type: 'OPERATING',
          openingTime: constructDateTime(dateStr, earliestOpen, tz),
          closingTime: constructDateTime(dateStr, latestClose, tz),
        });
      }
    }

    return scheduleEntries;
  }
}

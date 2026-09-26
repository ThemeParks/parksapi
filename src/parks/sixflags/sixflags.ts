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
import type {Entity, LiveData, EntitySchedule, ScheduleEntry} from '@themeparks/typelib';
import {formatInTimezone, addMinutes, constructDateTime, shiftDateString} from '../../datetime.js';
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

/**
 * Park IDs to drop entirely — the destination is served by another module
 * or has been divested from Six Flags so its venue-status / wait-times
 * feeds are no longer maintained, leaving the SixFlags class emitting all-
 * CLOSED garbage.
 *
 * Between 2026-04-06 and 2026-05-14, Six Flags divested seven parks to
 * EPR Properties under 40-year operating leases. Six are operated by
 * Enchanted Parks (WF, MA, VF, GV, SFSL, SFGE); La Ronde is operated by
 * La Ronde Operations Inc., a Premier Parks LLC subsidiary that also
 * runs Calypso and Valcartier. Replacement destination classes live
 * under `src/parks/enchantedparks/`.
 *
 * - 6   / WF:   Worlds of Fun         → enchantedparks/worldsoffun
 * - 12  / MA:   Michigan's Adventure  → enchantedparks/michigansadventure
 * - 14  / VF:   Valleyfair            → enchantedparks/valleyfair
 * - 27  / GV:   Schlitterbahn Galv.   → enchantedparks/galvestonislandwaterpark
 * - 903 / SFSL: Six Flags St. Louis   → enchantedparks/midamericaparks
 * - 924 / SFGE: Six Flags Great Esc.  → enchantedparks/greatescapeparks
 * - 969 / SFLR: La Ronde              → no primary source distinct from
 *                                       the Six Flags app; Premier Parks
 *                                       has no shared guest-experience
 *                                       platform with wait times
 */
const EXCLUDED_PARK_IDS = new Set<number>([6, 12, 14, 27, 903, 924, 969]);

/** Default show duration in minutes when not otherwise specified */
const DEFAULT_SHOW_DURATION_MINUTES = 30;

/**
 * Venue identifiers used throughout the vendor's POI, venue-status,
 * wait-times and operating-hours responses. The same numbering is shared by
 * every park in the estate.
 *
 * Venue 3 ("MAZE") holds the seasonal haunt attractions — Knott's Scary Farm
 * mazes, Fright Fest / HalloWeekends / Halloween Haunt houses. They are
 * walk-through attractions that queue and post a standby wait exactly the
 * way a ride does, and the vendor publishes them in all four feeds, but
 * nothing here consumed venue 3 until now.
 *
 * Venues we deliberately do not publish: 5 (restrooms), 6 (retail),
 * 7 (guest services), 8 (parking), 9 (water-park cabanas), 10 (in-app AR
 * experiences) and the venue-less EVENT rows.
 */
const RIDE_VENUE_ID = 1;
const SHOW_VENUE_ID = 2;
const MAZE_VENUE_ID = 3;
const RESTAURANT_VENUE_ID = 4;

/**
 * Venues whose rows carry a standby queue, so they enumerate from the union
 * of venue-status and wait-times and map their status the same way.
 */
const QUEUEING_VENUE_IDS: readonly number[] = [RIDE_VENUE_ID, MAZE_VENUE_ID];

/**
 * `operatings[].operatingTypeId` for the seasonal haunt event. The vendor
 * publishes it alongside the regular `Park` window (id 24) on event nights
 * and it is the only place Knott's exposes Scary Farm hours — its maze
 * detailHours are empty all season.
 */
const HAUNT_OPERATING_TYPE_ID = 25;

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
 * Seasonal badges the vendor staples onto maze names for the current year
 * ("NEW! Inked", "NEW: Metal Massacre", "RETURNING! Necropolis"). They are
 * marketing chrome, not part of the attraction's identity: the same maze
 * loses the badge next season and the rename churns the entity on the wiki
 * for no reason. Strip it once, here.
 *
 * Also normalises the ragged whitespace venue 3 ships — Kings Dominion pads
 * every maze name with runs of tabs, and a stripped badge can leave a double
 * space behind ("NEW!  Finklestein's House of Fun") — and drops the literal
 * "N/A" Frontier City appends to one name.
 */
function cleanMazeName(name: string): string {
  return cleanHtmlName(name)
    .replace(/^(?:new|returning|back)\s*[!:]\s*/i, '')
    .replace(/\s+N\/A$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Venue 3 is not purely mazes. The vendor also files the haunt event's
 * *entrance pin* there — a zero-coordinate row named for the gate it sits on
 * (Canada's Wonderland publishes "Front Gate"). It is wayfinding furniture,
 * never an attraction, and it would otherwise surface on the wiki as a
 * permanently-closed ride.
 *
 * Matched on the whole name so a real maze that merely mentions a gate
 * ("Gates of Terror" at Canada's Wonderland) is untouched.
 */
function isEventEntrancePin(name: string): boolean {
  return /^(?:front|main|park)?\s*(?:gate|entrance|entry)$/i.test(name.trim());
}

/**
 * The other venue-3 stowaway: character meet-and-greets run as part of the
 * haunt event (Six Flags Over Georgia files "Looney Tunes Meet and Greet"
 * and "Monster Mansion Meet and Greet" under venue 3). These are real guest
 * offerings, so they are published — but as MEET_AND_GREET, not as a maze.
 */
function isMeetAndGreet(name: string): boolean {
  return /\bmeet\s*(?:and|&|'n'?|n)\s*greet\b/i.test(name);
}

/**
 * True for a vendor wall-clock string this module can safely turn into a
 * timestamp. The operating-hours feed uses "" for "no window today", but a
 * malformed value would otherwise reach constructDateTime() and produce a
 * nonsense schedule entry rather than no entry at all.
 */
function isWallClockTime(value: string | undefined): value is string {
  return typeof value === 'string' && /^\d{1,2}:\d{2}$/.test(value);
}

/**
 * True when a closing time lands on the calendar day after its opening time.
 *
 * Both values are vendor "HH:mm" wall-clock strings with no date attached, so
 * the only signal that a window crossed midnight is the close not being after
 * the open. Equality counts as a rollover too: a 19:00-19:00 window is a full
 * day, never a zero-length one.
 */
function closeTimeCrossesMidnight(openTime: string, closeTime: string): boolean {
  return closeTime <= openTime;
}

/**
 * Extract the seasonal haunt window for one calendar date, or null if the
 * vendor published none.
 *
 * Two upstream shapes, both observed on 2026-09-16:
 *
 *   (a) PARK-LEVEL — an `operatings` block of type 25 ("Haunt") alongside the
 *       regular "Park" block. Knott's Berry Farm publishes Scary Farm this
 *       way (19:00-01:00 weeknights, 19:00-02:00 weekends) and leaves every
 *       maze's detailHours empty, so this is the only Scary Farm window that
 *       exists anywhere in the feed.
 *
 *   (b) PER-MAZE — no Haunt operatings block, but venue 3's detailHours carry
 *       real per-maze hours. Magic Mountain (19:00-23:00 Fright Fest nights),
 *       Cedar Point, Kings Island and Canada's Wonderland all do this. The
 *       envelope of those hours is the event window.
 *
 * Prefer (a): it is the vendor's own statement of the event window, whereas
 * the envelope in (b) is inferred from whatever mazes happen to be scheduled.
 *
 * In (b), a maze filed as opening before the park itself opens is not
 * evidence of an earlier event: guests cannot reach a maze before the gates
 * do. Fiesta Texas files six of its fourteen mazes as 06:00-23:00 on every
 * Friday of the 2026 season, against a 17:00 park open and a 19:15 start for
 * the other eight, and taking the earliest start published the event from
 * 06:00. So the inferred open is the earliest maze start at or after
 * `parkOpen`, or `parkOpen` itself when every maze is filed before it. The
 * close still spans every maze: only the start is implausible.
 */
function hauntWindowForDate(
  dateObj: SixFlagsOperatingHours['dates'][0],
  parkOpen: string,
): {open: string; close: string; description: string} | null {
  const hauntOperatings = (dateObj.operatings || []).filter(op =>
    op.operatingTypeId === HAUNT_OPERATING_TYPE_ID || /haunt/i.test(op.operatingTypeName || ''),
  );

  for (const op of hauntOperatings) {
    const items = (op.items || []).filter(i => isWallClockTime(i.timeFrom) && isWallClockTime(i.timeTo));
    if (items.length === 0) continue;
    return {
      open: items.map(i => i.timeFrom).sort()[0],
      close: latestClosingTime(items.map(i => ({from: i.timeFrom, to: i.timeTo}))),
      description: op.operatingTypeName || 'Haunt',
    };
  }

  const mazeVenue = dateObj.venues?.find(v => v.venueId === MAZE_VENUE_ID);
  const mazeHours = (mazeVenue?.detailHours || [])
    .filter(h => isWallClockTime(h.operatingTimeFrom) && isWallClockTime(h.operatingTimeTo));
  if (mazeHours.length === 0) return null;

  const plausibleStarts = mazeHours.map(h => h.operatingTimeFrom).filter(from => from >= parkOpen).sort();
  return {
    open: plausibleStarts[0] ?? parkOpen,
    close: latestClosingTime(mazeHours.map(h => ({from: h.operatingTimeFrom, to: h.operatingTimeTo}))),
    description: 'Haunt',
  };
}

/**
 * Latest closing time across a set of windows, treating any close that does
 * not follow its own open as belonging to the next day.
 *
 * A plain string sort gets this backwards on haunt nights: Cedar Point
 * schedules mazes 20:00-23:00 and 20:00-00:00 on the same night, and "23:00"
 * sorts after "00:00", so the naive maximum would close the event an hour
 * before its real end.
 */
function latestClosingTime(windows: Array<{from: string; to: string}>): string {
  let best = '';
  let bestRank = -1;
  for (const w of windows) {
    // Same-day closes rank by their own clock time; next-day closes all rank
    // above every same-day close, and among themselves by clock time.
    const rank = closeTimeCrossesMidnight(w.from, w.to)
      ? 24 * 60 + timeToMinutes(w.to)
      : timeToMinutes(w.to);
    if (rank > bestRank) {
      bestRank = rank;
      best = w.to;
    }
  }
  return best;
}

/** Minutes since midnight for an "HH:mm" wall-clock string. */
function timeToMinutes(time: string): number {
  const [hours, minutes] = time.split(':');
  return Number(hours) * 60 + Number(minutes);
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
  @cache({ttlSeconds: 86400, cacheVersion: 5})
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
      .map(([id, s]) => ({ ...s, parkId: parseInt(id, 10) }))
      .filter(p => !EXCLUDED_PARK_IDS.has(p.parkId));

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

      // Extract water parks from otherParks array. `fimsId` is typed as
      // number but Firebase actually serves it as a numeric-looking string
      // for some parks — coerce it, or the strict `poi.parkId === wp.parkId`
      // comparison in buildEntityList() never matches (poi.parkId is always
      // a real number), the bundled lookup silently returns zero POIs, and
      // the /poi/park/{id} standalone fallback 404s for BUNDLED-pattern
      // waterparks. Net effect: the waterpark's entities vanish from every
      // sync and the collector proposes deleting them. Confirmed live for
      // Cedar Point Shores, Knott's Soak City, and 3 Hurricane Harbors
      // (NJ/LA/Chicago) — all had string fimsId and an empty entity list.
      const waterParks = (park.otherParks || [])
        .filter(op => op.label === 'Water Park' && op.fimsId && op.fimsSiteCode)
        .map(op => ({
          parkId: Number(op.fimsId),
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

    // Try the owner's POI first — bundled-pattern waterparks (HHLA/HHNJ)
    // expose their coordinates here.
    const ownerPoi = await this.getPOI(sourceParkId);
    let coords = parkCentroidFromPOI(ownerPoi, parkId);

    // Standalone-pattern waterparks (HHA/HHOKC) aren't included in their
    // parent's POI response — fall back to their own /poi/park/{wpId}
    // endpoint, which returns POIs keyed by their own parkId.
    if (!coords && sourceParkId !== parkId) {
      const standalonePoi = await this.getPOI(parkId);
      coords = parkCentroidFromPOI(standalonePoi, parkId);
    }

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
      // No status from venue — the only evidence left is the posted wait,
      // and it has to be a *positive* one.
      //
      // The wait-times feed is not gated on park hours: it serves a roster
      // of zeros around the clock. Sampled 2026-09-16 at 03:20 Pacific /
      // 06:20 Eastern, with every park in the estate shut, all 1,000-plus
      // wait-times rows across 26 parks read exactly 0 — so treating 0 as
      // evidence of operation reported 21 rides open in the middle of the
      // night. In this feed 0 is the absence of a reading, not a walk-on.
      //
      // Rides the union exists to recover carry a real number: Canada's
      // Wonderland's "The Daredeviler" was serving 60 minutes when it was
      // missing from venue-status. Those are unaffected.
      return (waitTime !== null && waitTime > 0) ? 'OPERATING' : 'CLOSED';
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
        const rides = poiData.filter(poi => poi.venueId === RIDE_VENUE_ID && poi.parkId === park.parkId);
        entities.push(...this.mapPOIEntities(rides, mainParkId, destinationId, tz, 'ATTRACTION', parkLocation));

        // Shows (venueId: 2)
        const shows = poiData.filter(poi => poi.venueId === SHOW_VENUE_ID && poi.parkId === park.parkId);
        entities.push(...this.mapPOIEntities(shows, mainParkId, destinationId, tz, 'SHOW', parkLocation));

        // Haunt mazes (venueId: 3)
        const mazes = poiData.filter(poi => poi.venueId === MAZE_VENUE_ID && poi.parkId === park.parkId);
        entities.push(...this.mapMazeEntities(mazes, mainParkId, destinationId, tz, parkLocation));

        // Restaurants (venueId: 4)
        const restaurants = poiData.filter(poi => poi.venueId === RESTAURANT_VENUE_ID && poi.parkId === park.parkId);
        entities.push(...this.mapPOIEntities(restaurants, mainParkId, destinationId, tz, 'RESTAURANT', parkLocation));

        // Water-park children. Two upstream patterns exist:
        //   (a) BUNDLED — POIs appear in the parent's /poi/park/{parentId}
        //       response keyed by the waterpark's parkId. Standalone
        //       /poi/park/{wpId} 404s. Examples: HHLA (925) under SFMM (905),
        //       HHNJ (911) under SFGADV (906).
        //   (b) STANDALONE — /poi/park/{wpId} returns the waterpark's POIs
        //       directly with HTTP 200, and the parent's response does NOT
        //       include them. Examples: HHA (913) under SFOT (901), HHOKC
        //       (944) under SFFC (943).
        // Check the parent's response first (already in memory) and only
        // call the standalone endpoint when the parent has no entries —
        // avoids a guaranteed-404 HTTP request per bundled waterpark per
        // cache cycle.
        for (const wp of park.waterParks) {
          const wpParkEntityId = `sixflags_park_${wp.code}`;
          const wpTz = await this.getTimezoneForPark(wp.parkId);

          const bundledWpPoi = poiData.filter(poi => poi.parkId === wp.parkId);
          const wpPoi = bundledWpPoi.length > 0
            ? bundledWpPoi
            : await this.getPOI(wp.parkId);

          const wpLocation = parkCentroidFromPOI(wpPoi, wp.parkId) ?? parkLocation;

          const wpRides = wpPoi.filter(poi => poi.venueId === RIDE_VENUE_ID);
          entities.push(...this.mapPOIEntities(wpRides, wpParkEntityId, destinationId, wpTz, 'ATTRACTION', wpLocation));

          const wpShows = wpPoi.filter(poi => poi.venueId === SHOW_VENUE_ID);
          entities.push(...this.mapPOIEntities(wpShows, wpParkEntityId, destinationId, wpTz, 'SHOW', wpLocation));

          const wpMazes = wpPoi.filter(poi => poi.venueId === MAZE_VENUE_ID);
          entities.push(...this.mapMazeEntities(wpMazes, wpParkEntityId, destinationId, wpTz, wpLocation));

          const wpRestaurants = wpPoi.filter(poi => poi.venueId === RESTAURANT_VENUE_ID);
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

  /**
   * Map venue-3 POI rows to ATTRACTION entities.
   *
   * Separate from {@link mapPOIEntities} because venue 3 needs its own name
   * cleanup (season badges, padded whitespace) and because two kinds of
   * non-maze row live in the venue: the event entrance pin, which is dropped,
   * and character meet-and-greets, which are published as MEET_AND_GREET
   * rather than as a walk-through attraction.
   */
  private mapMazeEntities(
    pois: SixFlagsPOI[],
    parkEntityId: string,
    destinationId: string,
    tz: string,
    fallbackLocation: {latitude: number; longitude: number} | null,
  ): Entity[] {
    return this.mapEntities(pois, {
      idField: 'fimsId',
      nameField: (poi) => cleanMazeName(poi.name),
      entityType: 'ATTRACTION',
      parentIdField: () => parkEntityId,
      destinationId,
      timezone: tz,
      filter: (poi: SixFlagsPOI) => !isEventEntrancePin(cleanMazeName(poi.name)),
      locationFields: {
        lat: (poi: SixFlagsPOI) => parseCoordinates(poi)?.latitude,
        lng: (poi: SixFlagsPOI) => parseCoordinates(poi)?.longitude,
      },
      transform: (entity, poi) => {
        // A maze is a walk-through attraction with a standby queue, so it
        // rides under the same attractionType as everything else that posts
        // a wait time. This matches how Halloween Horror Nights houses are
        // already published from the Universal module.
        (entity as any).attractionType = isMeetAndGreet(cleanMazeName(poi.name))
          ? 'MEET_AND_GREET'
          : 'RIDE';

        // Roughly a third of maze rows ship (0, 0) — parseCoordinates
        // rejects the placeholder, so fall back to the park centroid the
        // same way shows and outdoor restaurants do.
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

    // Process rides (venueId: 1) and haunt mazes (venueId: 3) from the union
    // of venue-status and wait-times.
    //
    // Mazes queue and post a standby wait exactly the way a ride does, and
    // the union matters more for them than it does for rides: on a day
    // before the haunt season opens several parks publish maze waits with no
    // maze roster in venue-status at all (Kings Island 0/7, Discovery
    // Kingdom 0/5, observed 2026-09-16), so enumerating venue-status alone
    // would drop every maze at those parks.
    //
    // Venue-status is the ride roster, but the vendor sometimes publishes a
    // live wait for a ride it has dropped from that roster. Enumerating
    // venue-status alone silently discards the wait even though we already
    // fetched it, so the ride goes missing from live output entirely and the
    // downstream collector, which only stamps a record when we emit one, keeps
    // serving whatever it last stored.
    //
    // Confirmed at Canada's Wonderland (park 40) on 2026-07-23: "The
    // Daredeviler" (RIDE-040-00072) was serving a 60 minute standby wait in
    // /wait-times, was absent from /venue-status (79 rides) and absent from
    // /poi, and themeparks.wiki had been serving a CLOSED record frozen since
    // 2026-04-20 while the ride was physically operating.
    //
    // Rides genuinely removed from a park (Time Warp, Speed City Raceway) are
    // absent from wait-times too, so the union only recovers rides the vendor
    // is still publishing live data for. Wait-times-only rides carry no status
    // string; mapStatus('') falls back to the wait time, which is exactly the
    // signal we have for them.
    const venueStatusRides = venueStatus.venues
      .filter(v => QUEUEING_VENUE_IDS.includes(v.venueId))
      .flatMap(v => v.details ?? []);
    const rosteredIds = new Set(venueStatusRides.map(r => r.fimsId));
    const waitTimesOnlyRides = (waitTimesData?.venues ?? [])
      .filter(v => QUEUEING_VENUE_IDS.includes(v.venueId))
      .flatMap(v => v.details ?? [])
      .filter(d => d.fimsId && !rosteredIds.has(d.fimsId))
      .map(d => ({fimsId: d.fimsId, status: ''}));
    const rideEntries = [...venueStatusRides, ...waitTimesOnlyRides];

    if (rideEntries.length > 0) {
      for (const ride of rideEntries) {
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
    const showsVenue = venueStatus.venues.find(v => v.venueId === SHOW_VENUE_ID);
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
  ): Promise<ScheduleEntry[]> {
    const scheduleEntries: ScheduleEntry[] = [];

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
          const windows = parkOperatings
            .filter(i => isWallClockTime(i.timeFrom) && isWallClockTime(i.timeTo))
            .map(i => ({from: i.timeFrom, to: i.timeTo}));
          if (windows.length === 0) continue;

          earliestOpen = windows.map(w => w.from).sort()[0];
          latestClose = latestClosingTime(windows);
        } else {
          // Fall back to per-ride detailHours.
          const ridesVenue = dateObj.venues?.find(v => v.venueId === RIDE_VENUE_ID);
          if (!ridesVenue?.detailHours || ridesVenue.detailHours.length === 0) continue;

          const windows = ridesVenue.detailHours
            .filter(h => isWallClockTime(h.operatingTimeFrom) && isWallClockTime(h.operatingTimeTo))
            .map(h => ({from: h.operatingTimeFrom, to: h.operatingTimeTo}));
          if (windows.length === 0) continue;

          earliestOpen = windows.map(w => w.from).sort()[0];
          latestClose = latestClosingTime(windows);
        }

        // Parse date from MM/DD/YYYY format
        const dateParts = dateObj.date.split('/');
        if (dateParts.length !== 3) continue;
        const dateStr = `${dateParts[2]}-${dateParts[0]}-${dateParts[1]}`;

        scheduleEntries.push({
          date: dateStr,
          type: 'OPERATING',
          openingTime: constructDateTime(dateStr, earliestOpen, tz),
          // Park hours cross midnight too, not just the haunt window. Cedar
          // Point runs 11:00-00:00 on HalloWeekends dates and Six Flags Mexico
          // does it year-round. Anchoring the close on the same calendar date
          // emitted a window that ended before it began — 151 of 866 rows
          // across 11 parks on 2026-09-17.
          closingTime: closeTimeCrossesMidnight(earliestOpen, latestClose)
            ? constructDateTime(shiftDateString(dateStr, 1), latestClose, tz)
            : constructDateTime(dateStr, latestClose, tz),
        });

        const hauntWindow = hauntWindowForDate(dateObj, earliestOpen);
        if (hauntWindow) {
          scheduleEntries.push({
            date: dateStr,
            type: 'TICKETED_EVENT',
            description: hauntWindow.description,
            openingTime: constructDateTime(dateStr, hauntWindow.open, tz),
            // Haunt nights routinely run past midnight — Knott's Scary Farm
            // closes at 02:00 and Cedar Point's mazes at 00:00. Anchoring the
            // close on the same calendar date would emit a window that ends
            // seven hours before it starts.
            closingTime: closeTimeCrossesMidnight(hauntWindow.open, hauntWindow.close)
              ? constructDateTime(shiftDateString(dateStr, 1), hauntWindow.close, tz)
              : constructDateTime(dateStr, hauntWindow.close, tz),
          });
        }
      }
    }

    return scheduleEntries;
  }
}

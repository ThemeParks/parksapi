import crypto from 'node:crypto';
import {Destination, DestinationConstructor} from '../../destination.js';
import {cache, CacheLib} from '../../cache.js';
import {http, HTTPObj} from '../../http.js';
import {inject} from '../../injector.js';
import config from '../../config.js';
import {destinationController} from '../../destinationRegistry.js';
import {Entity, LiveData, EntitySchedule} from '@themeparks/typelib';
import {hostnameFromUrl, formatInTimezone} from '../../datetime.js';
import {createStatusMap} from '../../statusMap.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Upstream place/show IDs occasionally contain characters the wiki API rejects
 * (colons, zero-width spaces, other non-ASCII). Normalise to a conservative
 * [\w.-] charset. Idempotent, so repeated calls produce the same result.
 */
function sanitizeId(id: string): string {
  return id.replace(/[^\w.-]/g, '_');
}

/**
 * Signature for the mobile-service token request: base64 HMAC-SHA256 over
 * `apiKey + "\n" + date + "\n"`, where `date` is the exact value sent in the
 * request's Date header. Same scheme as the other Universal web services.
 */
export function signWebApiRequest(secret: string, apiKey: string, date: string): string {
  return crypto.createHmac('sha256', secret).update(`${apiKey}\n${date}\n`).digest('base64');
}

/**
 * Seconds to cache a mobile-service session token: until 5 minutes before the
 * server-supplied expiry, never less than 5 minutes. Falls back to 1 hour when
 * the expiry is missing or unparseable.
 */
export function webApiTokenTtlSeconds(expirationUnix: unknown, nowMs: number): number {
  const exp = Number(expirationUnix);
  if (!Number.isFinite(exp) || exp <= 0) return 3600;
  const remaining = Math.floor(exp - nowMs / 1000) - 5 * 60;
  return Math.max(remaining, 5 * 60);
}

// ─── Status mapping ───────────────────────────────────────────────────────────

export const mapQueueStatus = createStatusMap(
  {
    OPERATING: ['OPEN'],
    DOWN: ['WEATHER_DELAY', 'BRIEF_DELAY'],
    // OUT_OF_SERVICE: show list, a show with no performances today
    CLOSED: ['CLOSED', 'N/A', 'OUT_OF_SERVICE'],
  },
  {parkName: 'USJ'},
);

// ─── API type definitions ─────────────────────────────────────────────────────

type USJQueue = {
  queue_id: string;
  queue_type: string;
  status: string;
  display_wait_time?: number;
  alternate_ids?: Array<{system_name: string; system_id: string}>;
};

type USJWaitTimeEntry = {
  wait_time_attraction_id: string;
  resort_area_code: string;
  land_id: string;
  name: string;
  venue_id: string;
  show_externally: boolean;
  queues: USJQueue[];
  category: string;
};

type USJShowTime = {
  show_time_id: string;
  status: string;
  start_time: string;
};

type USJShowEntry = {
  show_id: string;
  name: string;
  status: string;
  show_times: USJShowTime[];
};

type USJLatLng = {
  lat: number;
  lng: number;
};

type USJGeometryLocation = {
  location_type: string;
  lat_lng: USJLatLng;
};

type USJPlaceType = {
  type: string;
  categories?: string[];
};

type USJPlace = {
  place_id: string;
  name: string;
  place_type: USJPlaceType;
  geometry?: {
    locations?: USJGeometryLocation[];
  };
  land_id?: string;
  venue_id?: string;
  tags?: string[];
  short_description?: string;
  long_description?: string;
};

type USJPlacesResponse = {
  results: Array<{
    place: USJPlace;
    open_now?: boolean;
  }>;
};

// ─── Constants ────────────────────────────────────────────────────────────────

const DESTINATION_ID = 'universalstudiosjapan';
const PARK_ID = 'usj.usj';
const VENUE_ID = '10251';
const TIMEZONE = 'Asia/Tokyo';

// Place types we want to expose as entities
const WANTED_PLACE_TYPES: Record<string, Entity['entityType']> = {
  Ride: 'ATTRACTION',
  Show: 'SHOW',
  Dining: 'RESTAURANT',
};

/**
 * Places the feed files as a Show that are really walk-through attractions.
 *
 * USJ's feed does type its walk-throughs when it knows about them: Ollivanders,
 * the 4-D films and Hello Kitty's Ribbon Collection come through the places
 * API as `place_type.type: "Ride"` and the show list as `show_type: "RIDE"`.
 * Hogwarts Castle Walk is the exception. Both feeds call it a Show, and
 * nothing in either record separates it from a real performance: its
 * `categories: ["other"]` is shared with the Snoopy photo opportunity and the
 * trick-or-treat event, and its single all-day show-list window has the same
 * shape as Ollivanders' or the photo opportunity's.
 *
 * So the correction is pinned to the place id. The pattern accepts the
 * yearly `_YYYY` suffix USJ adds to seasonal ids (`..._2026`), so a re-run of
 * the event under a new id keeps its type without a code change. Anything
 * else stays whatever the feed says.
 */
const WALKTHROUGH_SHOW_IDS: RegExp[] = [
  /^usj\.usj\.shows?\.hogwarts_castle_walk(_\d{4})?$/,
];

/** Would this Show-typed place be published as a walk-through attraction? */
export function isWalkthroughShow(place: Pick<USJPlace, 'place_id' | 'place_type'>): boolean {
  if (place?.place_type?.type !== 'Show') return false;
  return WALKTHROUGH_SHOW_IDS.some((re) => re.test(place.place_id));
}

// ─── Implementation ───────────────────────────────────────────────────────────

@destinationController({category: 'Universal'})
export class UniversalStudiosJapan extends Destination {
  @config
  apiBase: string = '';

  @config
  clientId: string = '';

  @config
  clientSecret: string = '';

  @config
  cdnBase: string = '';

  @config
  appVersion: string = '';

  /** mobile-service API root (including the /api path segment) */
  @config
  webApiBase: string = '';

  @config
  webApiKey: string = '';

  /** HMAC secret used to sign mobile-service session-token requests */
  @config
  webApiSecret: string = '';

  timezone: string = TIMEZONE;

  constructor(options?: DestinationConstructor) {
    super(options);
    this.addConfigPrefix('UNIVERSALSTUDIOSJAPAN');
  }

  // ─── Authentication ──────────────────────────────────────────────────────

  /** Fetch OAuth2 token via Basic auth + client credentials */
  @http({tags: ['auth']} as any)
  async fetchToken(): Promise<HTTPObj> {
    const params = new URLSearchParams({
      scope: 'default',
      grant_type: 'client_credentials',
    });

    const credentials = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');

    return {
      method: 'POST',
      url: `${this.apiBase}/oidc/connect/token`,
      body: params.toString(),
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
      },
      tags: ['auth'],
    } as any as HTTPObj;
  }

  /** Cached OAuth2 token — expires per API-supplied expires_in */
  @cache({callback: (resp: {token: string; expiresIn: number}) => resp?.expiresIn || 3600})
  async getToken(): Promise<{token: string; expiresIn: number}> {
    const resp = await this.fetchToken();
    const data: any = await resp.json();
    if (!data?.access_token) {
      throw new Error('USJ: failed to obtain access_token');
    }
    return {
      token: data.access_token,
      expiresIn: (data.expires_in as number) || 3600,
    };
  }

  /** Inject Bearer token on authenticated API requests (not CDN, not auth endpoint) */
  @inject({
    eventName: 'httpRequest',
    hostname: function(this: UniversalStudiosJapan) {
      return hostnameFromUrl(this.apiBase);
    },
    tags: {$nin: ['auth']},
  })
  async injectAuth(req: HTTPObj): Promise<void> {
    const {token} = await this.getToken();
    req.headers = {
      ...req.headers,
      'Authorization': `Bearer ${token}`,
    };
  }

  /** Clear cached token on 401 */
  @inject({
    eventName: 'httpError',
    hostname: function(this: UniversalStudiosJapan) {
      return hostnameFromUrl(this.apiBase);
    },
  })
  async handleUnauthorized(req: HTTPObj): Promise<void> {
    if (req.response?.status === 401) {
      const {CacheLib} = await import('../../cache.js');
      await CacheLib.delete(`${this.constructor.name}:getToken:[]`);
    }
  }

  /** Inject Flutter app headers on api.usj.co.jp requests */
  @inject({
    eventName: 'httpRequest',
    hostname: function(this: UniversalStudiosJapan) {
      return hostnameFromUrl(this.apiBase);
    },
  })
  async injectAppHeaders(req: HTTPObj): Promise<void> {
    req.headers = {
      ...req.headers,
      'user-agent': 'Dart/3.6 (dart:io)',
      'x-uniwebservice-platform': 'Android',
      'x-uniwebservice-device': 'ONEPLUS A5000',
      'x-uniwebservice-apikey': 'USJFlutterAndroidApp',
      'x-uniwebservice-appversion': this.appVersion,
      'x-uniwebservice-platformversion': '14',
    };
  }

  /** Inject Flutter app User-Agent on mobile-service requests */
  @inject({
    eventName: 'httpRequest',
    hostname: function(this: UniversalStudiosJapan) {
      return hostnameFromUrl(this.webApiBase);
    },
  })
  async injectMobileServiceUA(req: HTTPObj): Promise<void> {
    req.headers = {
      ...req.headers,
      'user-agent': 'Dart/3.6 (dart:io)',
    };
  }

  // ─── HTTP fetch methods ──────────────────────────────────────────────────

  /** Fetch all places / POI data from the authenticated API */
  @http({cacheSeconds: 60 * 60 * 12} as any)
  async fetchPlaces(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.apiBase}/resort-areas/USJ/places`,
      options: {json: true},
    } as any as HTTPObj;
  }

  /** Fetch wait time list from the CDN (no auth needed) */
  @http({cacheSeconds: 60} as any)
  async fetchWaitTimes(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.cdnBase}/wait-time/wait-time-attraction-list.json`,
      options: {json: true},
    } as any as HTTPObj;
  }

  /** Fetch show list (with show times) from the CDN (no auth needed) */
  @http({cacheSeconds: 60} as any)
  async fetchShowList(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.cdnBase}/shows/show-list.json`,
      options: {json: true},
    } as any as HTTPObj;
  }

  // ─── Cached data accessors ───────────────────────────────────────────────

  /** Parse and cache place data */
  @cache({ttlSeconds: 60 * 60 * 12})
  async getPlaces(): Promise<USJPlace[]> {
    const resp = await this.fetchPlaces();
    const data: USJPlacesResponse = await resp.json();
    return (data?.results || []).map((r) => r.place);
  }

  /** Parse and cache wait time data */
  @cache({ttlSeconds: 60})
  async getWaitTimeData(): Promise<USJWaitTimeEntry[]> {
    const resp = await this.fetchWaitTimes();
    const data: USJWaitTimeEntry[] = await resp.json();
    return data || [];
  }

  /** Parse and cache show list data */
  @cache({ttlSeconds: 60})
  async getShowListData(): Promise<USJShowEntry[]> {
    const resp = await this.fetchShowList();
    const data: USJShowEntry[] = await resp.json();
    return data || [];
  }

  // ─── Destination / Entity building ───────────────────────────────────────

  async getDestinations(): Promise<Entity[]> {
    return [
      {
        id: DESTINATION_ID,
        name: 'Universal Studios Japan',
        entityType: 'DESTINATION',
        timezone: TIMEZONE,
        location: {latitude: 34.6654, longitude: 135.4324},
      } as Entity,
    ];
  }

  protected async buildEntityList(): Promise<Entity[]> {
    const places = await this.getPlaces();

    const parkEntity: Entity = {
      id: PARK_ID,
      name: 'Universal Studios Japan',
      entityType: 'PARK',
      parentId: DESTINATION_ID,
      destinationId: DESTINATION_ID,
      timezone: TIMEZONE,
      location: {latitude: 34.6654, longitude: 135.4324},
    } as Entity;

    const attractionEntities: Entity[] = [];

    for (const place of places) {
      const placeType = place.place_type?.type;
      let entityType = WANTED_PLACE_TYPES[placeType];
      if (!entityType) continue;
      const walkthrough = isWalkthroughShow(place);
      if (walkthrough) entityType = 'ATTRACTION';

      // Extract map location
      const mapLoc = place.geometry?.locations?.find(
        (l) => l.location_type === 'map',
      );
      const lat = mapLoc?.lat_lng?.lat;
      const lng = mapLoc?.lat_lng?.lng;

      const entity: Entity = {
        id: sanitizeId(place.place_id),
        name: place.name,
        entityType,
        parentId: PARK_ID,
        destinationId: DESTINATION_ID,
        timezone: TIMEZONE,
      } as Entity;

      if (lat != null && lng != null) {
        entity.location = {latitude: lat, longitude: lng};
      }

      if (walkthrough) {
        // typelib has no walk-through member. RIDE is what the feed's own
        // walk-throughs (Ollivanders, `place_type: "Ride"`) are published as.
        (entity as Entity & {attractionType?: string}).attractionType = 'RIDE';
      }

      attractionEntities.push(entity);
    }

    return [parkEntity, ...attractionEntities];
  }

  // ─── Live data ────────────────────────────────────────────────────────────

  protected async buildLiveData(): Promise<LiveData[]> {
    // Fetch independently so one CDN endpoint failing doesn't suppress the other.
    // Previously a single Promise.all rejection killed the whole emission and the
    // collector skipped the write, producing a multi-hour staleness gap.
    const [waitTimeResult, showListResult] = await Promise.allSettled([
      this.getWaitTimeData(),
      this.getShowListData(),
    ]);

    const waitTimeData: USJWaitTimeEntry[] =
      waitTimeResult.status === 'fulfilled' ? waitTimeResult.value : [];
    const showListData: USJShowEntry[] =
      showListResult.status === 'fulfilled' ? showListResult.value : [];

    if (waitTimeResult.status === 'rejected') {
      console.error('USJ: fetchWaitTimes failed', waitTimeResult.reason);
    }
    if (showListResult.status === 'rejected') {
      console.error('USJ: fetchShowList failed', showListResult.reason);
    }

    // If both fetches failed, throw so the collector logs and skips this cycle
    // rather than emitting an empty live-data set (which would mark every
    // attraction CLOSED via the wiki's implicit-closed semantics). Wrap both
    // reasons in an AggregateError so neither is lost and stack traces stay
    // useful even if a reason isn't an Error instance.
    if (waitTimeResult.status === 'rejected' && showListResult.status === 'rejected') {
      throw new AggregateError(
        [waitTimeResult.reason, showListResult.reason],
        'USJ buildLiveData: both fetchWaitTimes and fetchShowList rejected',
      );
    }

    // One row per entity. Some shows (the 4-D films, SING on Tour, Curious
    // George) are listed in both feeds under the same id. Emitting both made
    // the wiki alternate between them from one write cycle to the next.
    const results = new Map<string, LiveData>();

    // Wait times / attraction statuses
    for (const entry of waitTimeData) {
      if (!entry.show_externally) continue;

      for (const queue of entry.queues || []) {
        const queueType = queue.queue_type;

        if (queueType === 'STANDBY') {
          const status = mapQueueStatus(queue.status);
          const ld: LiveData = {
            id: sanitizeId(entry.wait_time_attraction_id),
            status,
          } as LiveData;

          if (status === 'OPERATING' && queue.display_wait_time != null) {
            ld.queue = {STANDBY: {waitTime: queue.display_wait_time}};
          }

          results.set(ld.id, ld);
          break; // one STANDBY queue per attraction
        }
      }
    }

    // Show times
    for (const show of showListData) {
      // Use the same status vocabulary as attractions: a delayed show
      // (BRIEF_DELAY / WEATHER_DELAY) is DOWN, not CLOSED. The old binary
      // `=== 'OPEN' ? OPERATING : CLOSED` mislabelled delayed shows as closed
      // even while they still listed a full day of ENABLED performances.
      const showStatus = mapQueueStatus(show.status);

      // start_time is a real UTC instant ("2026-09-27T02:30:00.000Z" is an
      // 11:30 JST performance), not park-local time with a Z on it. Parse it
      // as UTC and render it in the park's zone. Reading it as fake UTC
      // published every performance nine hours early.
      const showTimes = (show.show_times || [])
        .filter((st) => st.status === 'ENABLED')
        .map((st) => new Date(st.start_time))
        .filter((start) => Number.isFinite(start.getTime()))
        .map((start) => ({
          type: 'PERFORMANCE_TIME' as const,
          startTime: formatInTimezone(start, TIMEZONE),
          endTime: null,
        }));

      const id = sanitizeId(show.show_id);
      const ld: LiveData = {
        id,
        status: showStatus,
      } as LiveData;

      // Listed in both feeds: the show list owns status and showtimes, since it
      // is the performance-level source (e.g. wait times said BRIEF_DELAY while
      // the show list said OUT_OF_SERVICE with no performances). Keep the
      // wait-time queue only while the show is actually operating.
      const waitRow = results.get(id);
      if (waitRow?.queue && showStatus === 'OPERATING') {
        ld.queue = waitRow.queue;
      }

      if (showTimes.length > 0) {
        ld.showtimes = showTimes;
      }

      results.set(id, ld);
    }

    return [...results.values()];
  }

  // ─── Schedules ────────────────────────────────────────────────────────────

  // ─── Schedule HTTP Methods ────────────────────────────────────────────────────

  /**
   * Request a mobile-service session token. The token expires within hours,
   * so it is minted on demand rather than configured.
   */
  @http({tags: ['webApiAuth']} as any)
  async fetchWebApiToken(): Promise<HTTPObj> {
    const date = new Date().toUTCString();
    return {
      method: 'POST',
      url: `${this.webApiBase}?city=USJ`,
      headers: {
        'Date': date,
        'X-UNIWebService-ApiKey': this.webApiKey,
      },
      body: {
        apiKey: this.webApiKey,
        signature: signWebApiRequest(this.webApiSecret, this.webApiKey, date),
      },
      options: {json: true},
      tags: ['webApiAuth'],
    } as any as HTTPObj;
  }

  /** Cached mobile-service session token, held until shortly before it expires */
  @cache({
    callback: (resp: {token: string; expiresIn: number}) => resp?.expiresIn || 3600,
    key: function(this: UniversalStudiosJapan) {
      return `${this.constructor.name}:webApiToken`;
    },
  })
  async getWebApiToken(): Promise<{token: string; expiresIn: number}> {
    // @http rejects non-OK responses itself
    const resp = await this.fetchWebApiToken();
    const data: any = await resp.json();
    if (!data?.Token) {
      throw new Error('USJ: web API token response has no Token');
    }
    return {
      token: data.Token,
      expiresIn: webApiTokenTtlSeconds(data.TokenExpirationUnix, Date.now()),
    };
  }

  /** Attach the api key and session token to mobile-service requests (not the token request itself) */
  @inject({
    eventName: 'httpRequest',
    hostname: function(this: UniversalStudiosJapan) {
      return hostnameFromUrl(this.webApiBase);
    },
    tags: {$nin: ['webApiAuth']},
  })
  async injectWebApiAuth(req: HTTPObj): Promise<void> {
    // Request injectors run before the @http response-cache check. A request
    // that will be answered from cache needs no token, and minting one anyway
    // would let a token outage fail requests the cache could have served.
    const cacheKey = (req as {cacheKey?: string}).cacheKey;
    if (cacheKey && CacheLib.has(cacheKey)) return;

    const {token} = await this.getWebApiToken();
    req.headers = {
      ...req.headers,
      'X-UNIWebService-ApiKey': this.webApiKey,
      'X-UNIWebService-Token': token,
    };
  }

  /** A token revoked before its advertised expiry: drop it so the next call mints a fresh one */
  @inject({
    eventName: 'httpError',
    hostname: function(this: UniversalStudiosJapan) {
      return hostnameFromUrl(this.webApiBase);
    },
  })
  async handleWebApiUnauthorized(req: HTTPObj): Promise<void> {
    if (req.response?.status === 401) {
      CacheLib.delete(`${this.constructor.name}:webApiToken`);
    }
  }

  /** Fetch venue hours for a month from the USJ website's mobile-service API */
  @http({cacheSeconds: 60 * 60 * 12} as any)
  async fetchVenueHoursForMonth(endDate: string): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.webApiBase}/Venues/${VENUE_ID}/Hours?endDate=${encodeURIComponent(endDate)}`,
      headers: {
        'Accept-Language': 'en-US',
      },
      options: {json: true},
      tags: ['schedule'],
    } as any as HTTPObj;
  }

  // ─── Schedules ──────────────────────────────────────────────────────────────────

  protected async buildSchedules(): Promise<EntitySchedule[]> {
    if (!this.webApiBase || !this.webApiKey || !this.webApiSecret) {
      throw new Error('USJ: webApiBase, webApiKey and webApiSecret must be configured for schedules');
    }

    const schedule: Array<{date: string; type: string; openingTime: string; closingTime: string}> = [];

    // Fetch 3 months of schedule data
    const now = new Date();
    const failures: string[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const monthDate = new Date(now.getFullYear(), now.getMonth() + i + 1, 0); // last day of month
      const mm = String(monthDate.getMonth() + 1).padStart(2, '0');
      const dd = String(monthDate.getDate()).padStart(2, '0');
      const endDate = `${mm}/${dd}/${monthDate.getFullYear()}`;

      try {
        const resp = await this.fetchVenueHoursForMonth(endDate);
        const hours = await resp.json();
        if (!Array.isArray(hours)) {
          failures.push(`${endDate}: response is not an array`);
          continue;
        }

        for (const h of hours) {
          if (!h.OpenTimeString || !h.CloseTimeString || !h.Date) continue;
          // The endpoint returns every day from today up to endDate, not just
          // that month, so later requests repeat the earlier ones' days.
          const dedupeKey = `${h.Date}|${h.OpenTimeString}|${h.CloseTimeString}`;
          if (seen.has(dedupeKey)) continue;
          seen.add(dedupeKey);
          schedule.push({
            date: h.Date,
            type: 'OPERATING',
            openingTime: h.OpenTimeString,
            closingTime: h.CloseTimeString,
          });
        }
      } catch (err) {
        // One bad month should not cost the others
        failures.push(`${endDate}: ${(err as Error)?.message ?? err}`);
      }
    }

    // Every month failing is an outage (auth, endpoint), not an empty calendar.
    // Returning [] here is what let a dead session token go unnoticed.
    if (failures.length === 3) {
      throw new Error(`USJ: every venue-hours request failed: ${failures.join('; ')}`);
    }
    if (failures.length > 0) {
      console.warn(`USJ: some venue-hours months failed: ${failures.join('; ')}`);
    }

    return [{id: PARK_ID, schedule} as EntitySchedule];
  }
}

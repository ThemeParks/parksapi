import {Destination, DestinationConstructor} from '../../destination.js';
import {cache} from '../../cache.js';
import {http, HTTPObj} from '../../http.js';
import {inject} from '../../injector.js';
import config from '../../config.js';
import {destinationController} from '../../destinationRegistry.js';
import {Entity, LiveData, EntitySchedule} from '@themeparks/typelib';
import {hostnameFromUrl, localFromFakeUtc} from '../../datetime.js';
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

// ─── Status mapping ───────────────────────────────────────────────────────────

const mapQueueStatus = createStatusMap(
  {
    OPERATING: ['OPEN'],
    DOWN: ['WEATHER_DELAY', 'BRIEF_DELAY'],
    CLOSED: ['CLOSED', 'N/A'],
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

  @config
  webApiKey: string = '';

  @config
  webApiToken: string = '';

  timezone: string = TIMEZONE;

  constructor(options?: DestinationConstructor) {
    super(options);
    this.addConfigPrefix('UNIVERSALSTUDIOSJAPAN');
    this.enableProxySupport();
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
    hostname: 'mobile-service.usj.co.jp',
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
      const entityType = WANTED_PLACE_TYPES[placeType];
      if (!entityType) continue;

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

      attractionEntities.push(entity);
    }

    return [parkEntity, ...attractionEntities];
  }

  // ─── Live data ────────────────────────────────────────────────────────────

  protected async buildLiveData(): Promise<LiveData[]> {
    const [waitTimeData, showListData] = await Promise.all([
      this.getWaitTimeData(),
      this.getShowListData(),
    ]);

    const results: LiveData[] = [];

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

          results.push(ld);
          break; // one STANDBY queue per attraction
        }
      }
    }

    // Show times
    for (const show of showListData) {
      const showStatus = show.status === 'OPEN' ? 'OPERATING' : 'CLOSED';

      const showTimes = (show.show_times || [])
        .filter((st) => st.status === 'ENABLED')
        .map((st) => ({
          type: 'PERFORMANCE_TIME' as const,
          startTime: localFromFakeUtc(st.start_time, TIMEZONE),
          endTime: null,
        }));

      const ld: LiveData = {
        id: sanitizeId(show.show_id),
        status: showStatus,
      } as LiveData;

      if (showTimes.length > 0) {
        ld.showtimes = showTimes;
      }

      results.push(ld);
    }

    return results;
  }

  // ─── Schedules ────────────────────────────────────────────────────────────

  // ─── Schedule HTTP Methods ────────────────────────────────────────────────────

  /** Fetch venue hours for a month from the USJ website's mobile-service API */
  @http({cacheSeconds: 60 * 60 * 12} as any)
  async fetchVenueHoursForMonth(endDate: string): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `https://mobile-service.usj.co.jp/api/Venues/${VENUE_ID}/Hours?endDate=${encodeURIComponent(endDate)}`,
      headers: {
        'X-UNIWebService-ApiKey': this.webApiKey,
        'X-UNIWebService-Token': this.webApiToken,
        'Accept-Language': 'en-US',
      },
      options: {json: true},
      tags: ['schedule'],
    } as any as HTTPObj;
  }

  // ─── Schedules ──────────────────────────────────────────────────────────────────

  protected async buildSchedules(): Promise<EntitySchedule[]> {
    const schedule: Array<{date: string; type: string; openingTime: string; closingTime: string}> = [];

    // Fetch 3 months of schedule data
    const now = new Date();
    for (let i = 0; i < 3; i++) {
      const monthDate = new Date(now.getFullYear(), now.getMonth() + i + 1, 0); // last day of month
      const mm = String(monthDate.getMonth() + 1).padStart(2, '0');
      const dd = String(monthDate.getDate()).padStart(2, '0');
      const endDate = `${mm}/${dd}/${monthDate.getFullYear()}`;

      try {
        const resp = await this.fetchVenueHoursForMonth(endDate);
        const hours = await resp.json();
        if (!Array.isArray(hours)) continue;

        for (const h of hours) {
          if (!h.OpenTimeString || !h.CloseTimeString || !h.Date) continue;
          schedule.push({
            date: h.Date,
            type: 'OPERATING',
            openingTime: h.OpenTimeString,
            closingTime: h.CloseTimeString,
          });
        }
      } catch {
        // Skip months that fail
      }
    }

    return [{id: PARK_ID, schedule} as EntitySchedule];
  }
}

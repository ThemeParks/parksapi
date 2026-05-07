import {Destination, DestinationConstructor} from '../../destination.js';
import crypto from 'crypto';

import {cache} from '../../cache.js';
import {http, HTTPObj} from '../../http.js';
import {inject} from '../../injector.js';
import config from '../../config.js';
import {destinationController} from '../../destinationRegistry.js';
import {
  Entity,
  LiveData,
  EntitySchedule,
  AttractionTypeEnum,
  QueueTypeEnum,
} from '@themeparks/typelib';
import {formatUTC, parseTimeInTimezone, formatInTimezone, addDays, isBefore, constructDateTime, addMinutes, hostnameFromUrl} from '../../datetime.js';
import {TagBuilder} from '../../tags/index.js';
import {randomPointInRadius} from '../../geo.js';

// Only return restaurants using these dining types
const WANTED_DINING_TYPES = ['CasualDining', 'FineDining'];

// Ignore show types (meet & greets, street entertainment)
const IGNORE_SHOW_TYPES = ['Music'];

/**
 * Universal API POI data structure
 */
type UniversalPOIData = {
  Id: number;
  MblDisplayName?: string;
  Longitude?: number;
  Latitude?: number;
  HasChildSwap?: boolean;
  MinHeightInInches?: number;
  VenueId?: number;
  Tags?: string[];
  ExternalIds?: {
    ContentId?: string;
    PlaceId?: string;
  };
  ShowTypes?: string[];
  DiningTypes?: string[];
  StartDateTimes?: string[];
  WaitTime?: number;
};

/**
 * Universal POI API response structure
 */
type UniversalPOIResponse = {
  Rides: UniversalPOIData[];
  Shows: UniversalPOIData[];
  DiningLocations: UniversalPOIData[];
};

/**
 * Determine attraction type from Universal API data
 */
function getUniversalAttractionType(data: UniversalPOIData): AttractionTypeEnum {
  // Check for trains (Hogwarts Express)
  if (data.Tags?.includes('train')) {
    return AttractionTypeEnum.TRANSPORT;
  }
  return AttractionTypeEnum.RIDE;
}

/**
 * Filter Universal attractions by name patterns
 */
function shouldIncludeUniversalAttraction(name: string): boolean {
  const lowerName = name.toLowerCase();
  if (lowerName.includes(' - last train')) return false;
  if (lowerName.includes(' - first show')) return false;
  return true;
}

/**
 * Universal Venues API response
 */
type UniversalVenuesResponse = {
  Results: Array<{
    Id: number;
    MblDisplayName: string;
    AdmissionRequired: boolean;
    Latitude?: number;
    Longitude?: number;
    ExternalIds: {
      ContentId: string;
    };
  }>;
};

/**
 * Universal wait time API response
 */
type UniversalWaitTimeResponse = Array<{
  name: string;
  wait_time_attraction_id?: string;
  has_single_rider?: boolean;
  queues: Array<{
    queue_type: string;
    status: string;
    display_wait_time?: number;
    opens_at?: string;
    alternate_ids: Array<{
      system_name: string;
      system_id: string;
    }>;
  }>;
}>;

/**
 * Universal virtual queue API response
 */
type UniversalVirtualQueueState = {
  Id: string;
  IsEnabled: boolean;
  QueueEntityId: string;
};

type UniversalVirtualQueueDetails = {
  AppointmentTimes: Array<{
    StartTime: string;
    EndTime: string;
  }>;
};

/**
 * One Express Now offer, post-parsing.
 *
 * Numeric fields arrive as strings on the wire (Flutter parser uses
 * `int.parse` / `double.parse` on every numeric field) — we coerce them
 * once here so downstream code never has to.
 */
export type ExpressNowOffer = {
  offer_id: string;
  place_id: string;
  inventory_time_slot: string;   // ISO datetime — return window start (park-local, no offset)
  inventory_time_minutes: number; // window length
  product_price: number;          // USD, decimal
  vl_inventory: number;           // remaining inventory
};

/**
 * Pure parser for the Express Now `/get-offers` response body. Coerces the
 * string-typed numeric fields, drops malformed entries, and groups by
 * `place_id` keeping the earliest-starting offer per place.
 *
 * Exported for unit testing — the reference payload is the first real
 * sample that came back from the live endpoint (Spider-Man, Mardi Gras
 * late-close window).
 */
// Required `inventory_time_slot` format. Must be enforced at parse time —
// downstream emission feeds the value into `parseTimeInTimezone` and `new
// Date()`, both of which would silently produce an Invalid Date for
// anything else, then `formatInTimezone` would throw mid-buildLiveData.
const SLOT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

export function parseExpressNowResponse(data: unknown): Record<string, ExpressNowOffer> {
  const predictions: any[] = Array.isArray((data as any)?.predictions) ? (data as any).predictions : [];
  const grouped: Record<string, ExpressNowOffer> = {};

  for (const raw of predictions) {
    const placeId = raw?.place_id;
    if (typeof placeId !== 'string' || !placeId) continue;
    if (typeof raw?.offer_id !== 'string' || !raw.offer_id) continue;
    if (typeof raw?.inventory_time_slot !== 'string' || !SLOT_RE.test(raw.inventory_time_slot)) continue;

    const parsed: ExpressNowOffer = {
      offer_id: raw.offer_id,
      place_id: placeId,
      inventory_time_slot: raw.inventory_time_slot,
      inventory_time_minutes: parseInt(raw.inventory_time_minutes, 10),
      product_price: parseFloat(raw.product_price),
      vl_inventory: parseInt(raw.vl_inventory, 10),
    };

    if (!Number.isFinite(parsed.product_price)
        || !Number.isFinite(parsed.inventory_time_minutes)
        || !Number.isFinite(parsed.vl_inventory)) continue;

    const existing = grouped[placeId];
    // The slot format is fixed `YYYY-MM-DDTHH:mm:ss` (validated above) —
    // lexicographic compare is chronologically equivalent and avoids
    // assuming the runtime and park timezone agree (`new Date()` parses
    // naive ISO as local).
    if (!existing || parsed.inventory_time_slot < existing.inventory_time_slot) {
      grouped[placeId] = parsed;
    }
  }
  return grouped;
}

/**
 * Universal schedule API response
 */
type UniversalScheduleResponse = Array<{
  Date: string;
  VenueStatus: string;
  OpenTimeString: string;
  CloseTimeString: string;
  EarlyEntryString?: string;
  SpecialEntryString?: string;
}>;

@config
class Universal extends Destination {
  @config
  secretKey: string = "";

  @config
  appKey: string = "";

  @config
  vQueueURL: string = "";

  @config
  baseURL: string = "";

  @config
  assetsBase: string = "";

  /** UDX platform API base — used by Express Now (new Flutter app API). */
  @config
  udxBase: string = "";

  /** UDX OAuth2 client ID. */
  @config
  udxClientId: string = "";

  /** UDX OAuth2 client secret. */
  @config
  udxClientSecret: string = "";

  /**
   * Flutter app API key for UDX calls (e.g. `UORFlutterAndroidApp`). The
   * legacy Android key (`AndroidMobileApp`) is rejected by the Express Now
   * endpoint — a resort-specific Flutter key is required.
   */
  @config
  flutterAppKey: string = "";

  /** Flutter app version sent on UDX requests. Rotates with app updates. */
  @config
  flutterAppVersion: string = "";

  /**
   * Park centre latitude — used to jitter Express Now offers requests.
   * NaN by default so the `Number.isFinite` guard in `getExpressNowOffers`
   * fails until the value is actually configured. (A literal `0` for a
   * park sited at the equator is a valid finite value and would pass.)
   */
  @config
  parkLatitude: number = NaN;

  /** Park centre longitude. NaN by default — see `parkLatitude`. */
  @config
  parkLongitude: number = NaN;

  @config
  city: string = "orlando";

  /** Resort-level (destination) coordinates. Overridden per subclass. */
  resortLocation: {latitude: number; longitude: number} = {latitude: 28.4719, longitude: -81.4685};

  @config
  resortName: string = "Universal Orlando Resort";

  @config
  resortSlug: string = "universalorlando";

  @config
  resortKey: string = "uor";

  @config
  timezone: string = "America/New_York";

  constructor(options?: DestinationConstructor) {
    super(options);
    this.addConfigPrefix('UNIVERSALSTUDIOS');
  }

  /**
   * Inject API key into all HTTP requests for Universal's API
   */
  @inject({
    eventName: 'httpRequest',
    hostname: function() {
      return new URL(this.baseURL).hostname;
    },
    tags: {$nin: ['apiKeyFetch']}
  })
  async injectAPIKey(requestObj: HTTPObj): Promise<void> {
    const apiKeyData = await this.getAPIKey();

    requestObj.headers = {
      ...requestObj.headers,
      'X-UNIWebService-ApiKey': this.appKey,
      'X-UNIWebService-Token': apiKeyData.apiKey,
    };
  }

  // ─── UDX platform API (Express Now, new Flutter app) ────────────────────

  /**
   * Inject Bearer token + Flutter-app fingerprint headers on UDX requests.
   * Skipped for the OAuth call itself (tagged `udxAuth`).
   */
  @inject({
    eventName: 'httpRequest',
    hostname: function() {
      if (!this.udxBase) return null;
      return hostnameFromUrl(this.udxBase);
    },
    tags: {$nin: ['udxAuth']},
  })
  async injectUdxToken(requestObj: HTTPObj): Promise<void> {
    if (!this.udxBase) return;
    const {token} = await this.getUdxToken();
    const headers: Record<string, string> = {
      ...requestObj.headers,
      'user-agent': 'Dart/3.6 (dart:io)',
      'accept-language': 'en-US',
      'x-uniwebservice-platform': 'Android',
      'x-uniwebservice-platformversion': '14',
      'x-uniwebservice-device': 'ONEPLUS A5000',
      'Authorization': `Bearer ${token}`,
    };
    if (this.flutterAppVersion) {
      headers['x-uniwebservice-appversion'] = this.flutterAppVersion;
    }
    requestObj.headers = headers;
  }

  /** Fetch UDX OAuth2 token via client credentials. The request-level
   * `tags: ['udxAuth']` (on the returned HTTPObj) is what `injectUdxToken`
   * matches against to skip itself for this call. */
  @http()
  async fetchUdxToken(): Promise<HTTPObj> {
    if (!this.udxBase || !this.udxClientId || !this.udxClientSecret) {
      throw new Error(
        `Universal UDX: missing config (udxBase=${!!this.udxBase}, udxClientId=${!!this.udxClientId}, udxClientSecret=${!!this.udxClientSecret}). ` +
        `Set UNIVERSALSTUDIOS_UDXBASE / UNIVERSALSTUDIOS_UDXCLIENTID / UNIVERSALSTUDIOS_UDXCLIENTSECRET in .env.`,
      );
    }
    const credentials = Buffer.from(`${this.udxClientId}:${this.udxClientSecret}`).toString('base64');
    return {
      method: 'POST',
      url: `${this.udxBase}/oidc/connect/token`,
      body: 'scope=default&grant_type=client_credentials',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
        'user-agent': 'Dart/3.6 (dart:io)',
      },
      tags: ['udxAuth'],
    } as any as HTTPObj;
  }

  /** Cached UDX access token. */
  @cache({callback: (resp: {token: string; expiresIn: number}) => resp?.expiresIn || 3600})
  async getUdxToken(): Promise<{token: string; expiresIn: number}> {
    const resp = await this.fetchUdxToken();
    const data: any = await resp.json();
    if (!data?.access_token) {
      throw new Error('Universal UDX: no access_token in response');
    }
    // expires_in is normally a number, but some OAuth servers stringify it —
    // coerce so the @cache TTL callback always sees a finite number.
    const expiresIn = Number(data.expires_in);
    return {
      token: data.access_token,
      expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600,
    };
  }

  /**
   * Inject Express Now headers (resort code + Flutter app key). The legacy
   * `X-UNIWebService-ApiKey: AndroidMobileApp` is rejected here — UDX wants
   * the resort-specific Flutter key.
   */
  @inject({
    eventName: 'httpRequest',
    hostname: function() {
      if (!this.udxBase) return null;
      return hostnameFromUrl(this.udxBase);
    },
    tags: 'expressNowOffers',
  })
  async injectExpressNowHeaders(requestObj: HTTPObj): Promise<void> {
    const flutterKey = this.flutterAppKey || `${this.resortKey.toUpperCase()}FlutterAndroidApp`;
    requestObj.headers = {
      ...requestObj.headers,
      'x-resort-area-code': this.resortKey.toUpperCase(),
      'X-UNIWebService-ApiKey': flutterKey,
    };
  }

  /**
   * Stable instance UUID for unauthenticated Express Now calls. The Flutter
   * app generates one v4 UUID per install and reuses it as the long-lived
   * guest identifier — we cache for 30 days to mirror that behaviour.
   */
  @cache({ttlSeconds: 60 * 60 * 24 * 30})
  async getExpressNowInstanceId(): Promise<string> {
    return crypto.randomUUID();
  }

  /**
   * POST UDX `/instances/{instanceId}/get-offers`. The lat/lon are jittered
   * within 150m of the park centre per request so successive polls don't
   * fingerprint as identical.
   */
  @http({retries: 0})
  async fetchExpressNowOffers(): Promise<HTTPObj> {
    const instanceId = await this.getExpressNowInstanceId();
    const point = randomPointInRadius(
      {latitude: this.parkLatitude, longitude: this.parkLongitude},
      150,
    );
    return {
      method: 'POST',
      url: `${this.udxBase}/instances/${instanceId}/get-offers`,
      body: {
        location_lat: String(point.latitude),
        location_long: String(point.longitude),
        device_id: instanceId,
      },
      options: {json: true},
      tags: ['expressNowOffers'],
    } as any as HTTPObj;
  }

  /**
   * Get parsed Express Now offers, grouped by `place_id`.
   * Empty object when Express Now isn't selling (404 / `OFFERS_NOT_FOUND`).
   * Throws on any other error so transient failures aren't cached as empty.
   *
   * TTL is dynamic: 60s when there are live offers (we want fresh inventory),
   * 10min when the endpoint confirms OFFERS_NOT_FOUND (no point re-polling
   * a stable "nothing for sale" — and re-polling generates a 404 log entry
   * from the http layer each time).
   */
  @cache({callback: (offers: Record<string, ExpressNowOffer>) => Object.keys(offers).length === 0 ? 600 : 60})
  async getExpressNowOffers(): Promise<Record<string, ExpressNowOffer>> {
    if (!this.udxBase || !Number.isFinite(this.parkLatitude) || !Number.isFinite(this.parkLongitude)) return {};

    let resp: HTTPObj;
    try {
      resp = await this.fetchExpressNowOffers();
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      // The 404 response always carries `"problem":"OFFERS_NOT_FOUND"` in
      // the body — match on that specifically. A bare `404` substring would
      // also swallow misconfiguration / wrong path / auth-rejection-as-404,
      // masking real bugs behind the long empty-result TTL.
      if (msg.includes('OFFERS_NOT_FOUND')) return {};
      // Anything else (network / 5xx / parse / unexpected 404) is transient
      // or a real bug — let it bubble so @cache doesn't poison the result.
      // buildLiveData catches and degrades gracefully.
      throw err;
    }

    return parseExpressNowResponse(await resp.json());
  }

  // ─── Legacy API (services.universalorlando.com) ─────────────────────────

  /**
   * Handle 401 responses by clearing cached API key
   */
  @inject({
    eventName: 'httpError',
    hostname: function() {
      return new URL(this.baseURL).hostname;
    },
  })
  async handleUnauthorized(requestObj: HTTPObj): Promise<void> {
    if (requestObj.response?.status === 401) {
      // Clear cached API key to force refresh
      const {CacheLib} = await import('../../cache.js');
      CacheLib.delete(`${this.constructor.name}:APIKey:${this.city}`);
    }
  }

  /**
   * Get API authentication token
   */
  @cache({
    callback: (response) => response?.expiresIn || 3600,
    key: function() {
      return `${this.constructor.name}:APIKey:${this.city}`;
    }
  })
  async getAPIKey(): Promise<{apiKey: string; expiresIn: number}> {
    const resp = await this.fetchAPIKey();
    if (!resp.response || !resp.response.ok) {
      throw new Error(`Failed to fetch API key: ${resp.response?.status} ${resp.response?.statusText}`);
    }
    const respJson: any = await resp.json();

    const expireTime: number = respJson.TokenExpirationUnix;
    let tokenExpiration: number = (expireTime * 1000) - Date.now();
    // Expire at least 5 minutes before actual expiration
    tokenExpiration = Math.max(tokenExpiration - (5 * 60 * 1000), 60 * 5 * 1000);

    return {
      apiKey: respJson.Token,
      expiresIn: Math.floor(tokenExpiration / 1000),
    };
  }

  /**
   * Fetch API key from authentication endpoint
   */
  @http()
  async fetchAPIKey(): Promise<HTTPObj> {
    const now = new Date();
    const today = formatUTC(now, 'ddd, DD MMM YYYY HH:mm:ss') + ' GMT';

    const signatureBuilder = crypto.createHmac('sha256', this.secretKey);
    signatureBuilder.update(`${this.appKey}\n${today}\n`);
    const signature = signatureBuilder.digest('base64').replace(/=$/, '\u003d');

    return {
      method: 'POST',
      url: `${this.baseURL}?city=${this.city}`,
      body: {
        apiKey: this.appKey,
        signature: signature,
      },
      headers: {
        'Date': today,
      },
      options: {
        json: true,
      },
      tags: ['apiKeyFetch']
    } as any as HTTPObj;
  }

  /**
   * Fetch parks/venues for this resort
   */
  @http({
    validateResponse: {
      type: 'object',
      properties: {
        Results: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              Id: {type: 'number'},
              ExternalIds: {
                type: 'object',
                properties: {
                  ContentId: {type: 'string'},
                },
                required: ['ContentId'],
              },
              MblDisplayName: {type: 'string'},
              AdmissionRequired: {type: 'boolean'},
            },
            required: ['Id', 'ExternalIds', 'MblDisplayName', 'AdmissionRequired'],
          },
        },
      },
      required: ['Results'],
    },
    cacheSeconds: 180 * 60, // 3 hours
    parameters: [
      {name: 'city', type: 'string', description: 'City to fetch parks for (orlando/hollywood)'}
    ]
  })
  async fetchParks(city: string): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.baseURL}/venues?city=${city}`,
      options: {json: true},
    } as any as HTTPObj;
  }

  /**
   * Get parks (filtered for admission required)
   */
  @cache({ttlSeconds: 60 * 60 * 3})
  async getParks(city: string) {
    const resp = await this.fetchParks(city);
    const data: UniversalVenuesResponse = await resp.json();
    return data.Results.filter((x) => x.AdmissionRequired);
  }

  /**
   * Fetch POI (Points of Interest) data
   */
  @http({
    cacheSeconds: 60, parameters: [
      {name: 'city', type: 'string', description: 'City to fetch POI data for (orlando/hollywood)'}
    ]
  })
  async fetchPOI(city: string): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.baseURL}/pointsofinterest?city=${city}`,
      options: {json: true},
    } as any as HTTPObj;
  }

  /**
   * Get POI data (cached)
   */
  @cache({ttlSeconds: 60})
  async getPOI(city: string): Promise<UniversalPOIResponse> {
    const resp = await this.fetchPOI(city);
    return await resp.json();
  }

  /**
   * Fetch wait time data
   */
  @http({cacheSeconds: 60})
  async fetchWaitTimes(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.assetsBase}/${this.resortKey}/wait-time/wait-time-attraction-list.json`,
      options: {json: true},
    } as any as HTTPObj;
  }

  /**
   * Get wait time data (cached)
   */
  @cache({ttlSeconds: 60})
  async getWaitTimes(): Promise<UniversalWaitTimeResponse> {
    const resp = await this.fetchWaitTimes();
    return await resp.json();
  }

  /**
   * Fetch virtual queue states
   */
  @http({cacheSeconds: 60})
  async fetchVirtualQueueStates(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.baseURL}/Queues`,
      queryParams: {
        city: this.city,
        page: '1',
        pageSize: 'all',
      },
      options: {json: true},
    } as any as HTTPObj;
  }

  /**
   * Get virtual queue states (cached)
   */
  @cache({ttlSeconds: 60})
  async getVirtualQueueStates(): Promise<UniversalVirtualQueueState[]> {
    const resp = await this.fetchVirtualQueueStates();
    const data: any = await resp.json();
    return data?.Results || [];
  }

  /**
   * Fetch virtual queue details for a specific queue
   */
  @http({
    cacheSeconds: 60, parameters: [
      {name: 'queueId', type: 'string', description: 'Virtual queue ID to fetch details for'}
    ]
  })
  async fetchVirtualQueueDetails(queueId: string): Promise<HTTPObj> {
    const todaysDate = formatInTimezone(new Date(), this.timezone, 'date');

    return {
      method: 'GET',
      url: `${this.baseURL}/${this.vQueueURL}/${queueId}`,
      queryParams: {
        page: '1',
        pageSize: 'all',
        city: this.city,
        appTimeForToday: todaysDate,
      },
      options: {json: true},
    } as any as HTTPObj;
  }

  /**
   * Get virtual queue details (cached)
   */
  @cache({ttlSeconds: 60})
  async getVirtualQueueDetails(queueId: string): Promise<UniversalVirtualQueueDetails> {
    const resp = await this.fetchVirtualQueueDetails(queueId);
    return await resp.json();
  }

  /**
   * Fetch venue schedule
   */
  @http({
    cacheSeconds: 180 * 60, parameters: [
      {name: 'venueId', type: 'string', description: 'Venue ID to fetch schedule for'}
    ]
  })
  async fetchVenueSchedule(venueId: string): Promise<HTTPObj> {
    const endDate = formatInTimezone(addDays(new Date(), 190), this.timezone, 'date');

    return {
      method: 'GET',
      url: `${this.baseURL}/venues/${venueId}/hours`,
      queryParams: {
        endDate: endDate,
      },
      options: {json: true},
    } as any as HTTPObj;
  }

  /**
   * Get venue schedule (cached)
   */
  @cache({ttlSeconds: 60 * 60 * 3})
  async getVenueSchedule(venueId: string): Promise<UniversalScheduleResponse> {
    const resp = await this.fetchVenueSchedule(venueId);
    return await resp.json();
  }

  /**
   * Helper: Find ride ID from wait time ID
   */
  private getRideIDFromWaitTimeId(poiData: UniversalPOIResponse, waitTimeId: string): string | null {
    try {
      const allPOIs = [
        ...poiData.Rides,
        ...poiData.Shows,
        ...poiData.DiningLocations,
      ];

      const ride = allPOIs.find((x) =>
        x.ExternalIds?.PlaceId === waitTimeId || x.ExternalIds?.ContentId === waitTimeId
      );

      return ride ? ride.Id.toString() : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Get filtered shows (exclude music/street entertainment)
   */
  private async getFilteredShows(): Promise<UniversalPOIData[]> {
    const poi = await this.getPOI(this.city);
    return poi.Shows.filter((show) => {
      const hasIgnoredType = show.ShowTypes?.some((type) => IGNORE_SHOW_TYPES.includes(type));
      return !hasIgnoredType;
    });
  }

  /**
   * Get destination entity
   */
  async getDestinations(): Promise<Entity[]> {
    return [
      {
        id: `universalresort_${this.city}`,
        name: this.resortName,
        entityType: 'DESTINATION',
        timezone: this.timezone,
        location: this.resortLocation,
      } as Entity
    ];
  }

  /**
   * Build all entities (destination, parks, attractions, shows, restaurants)
   * Note: parkId and destinationId are automatically resolved by the base class
   */
  protected async buildEntityList(): Promise<Entity[]> {
    const destinationId = `universalresort_${this.city}`;
    const poi = await this.getPOI(this.city);
    const parks = await this.getParks(this.city);
    const shows = await this.getFilteredShows();

    return [
      // Destination
      ...await this.getDestinations(),

      // Parks
      ...this.mapEntities(parks, {
        idField: 'Id',
        nameField: 'MblDisplayName',
        entityType: 'PARK',
        parentIdField: () => destinationId,
        destinationId,
        timezone: this.timezone,
        locationFields: {lat: 'Latitude', lng: 'Longitude'},
      }),

      // Attractions
      ...this.mapEntities(poi.Rides, {
        idField: 'Id',
        nameField: 'MblDisplayName',
        entityType: 'ATTRACTION',
        parentIdField: 'VenueId',
        locationFields: {lat: 'Latitude', lng: 'Longitude'},
        destinationId,
        timezone: this.timezone,
        filter: (ride) => shouldIncludeUniversalAttraction(ride.MblDisplayName || ''),
        transform: (entity, ride) => {
          // Add tags from Universal API data
          entity.tags = [
            ride.HasChildSwap ? TagBuilder.childSwap() : undefined,
            ride.MinHeightInInches ? TagBuilder.minimumHeight(ride.MinHeightInInches, 'in') : undefined,
          ].filter((tag): tag is NonNullable<typeof tag> => tag !== undefined);
          return entity;
        },
      }),

      // Shows
      ...this.mapEntities(shows, {
        idField: 'Id',
        nameField: 'MblDisplayName',
        entityType: 'SHOW',
        parentIdField: 'VenueId',
        locationFields: {lat: 'Latitude', lng: 'Longitude'},
        destinationId,
        timezone: this.timezone,
      }),

      // Restaurants
      ...this.mapEntities(poi.DiningLocations, {
        idField: 'Id',
        nameField: 'MblDisplayName',
        entityType: 'RESTAURANT',
        parentIdField: 'VenueId',
        locationFields: {lat: 'Latitude', lng: 'Longitude'},
        destinationId,
        timezone: this.timezone,
        filter: (dining) =>
          dining.DiningTypes?.some((type) => WANTED_DINING_TYPES.includes(type)) ?? false,
      }),
    ];
  }

  /**
   * Build live data for all entities
   */
  protected async buildLiveData(): Promise<LiveData[]> {
    const liveData: LiveData[] = [];
    const liveDataMap = new Map<string, LiveData>();

    const getOrCreateLiveData = (id: string): LiveData => {
      let data = liveDataMap.get(id);
      if (!data) {
        data = {
          id: id,
          status: 'CLOSED',
        };
        liveDataMap.set(id, data);
        liveData.push(data);
      }
      return data;
    };

    const poi = await this.getPOI(this.city);
    const waitTimes = await this.getWaitTimes();
    const vQueueStates = await this.getVirtualQueueStates();

    // Process virtual queues
    for (const vQueue of vQueueStates) {
      if (vQueue.IsEnabled) {
        const vQueueDetails = await this.getVirtualQueueDetails(vQueue.Id);

        // Find earliest appointment time
        const nextSlot = vQueueDetails.AppointmentTimes.reduce<{
          startTime: Date;
          endTime: Date;
        } | undefined>((prev, appt) => {
          const startTime = new Date(appt.StartTime);
          if (!prev || isBefore(startTime, prev.startTime)) {
            return {
              startTime,
              endTime: new Date(appt.EndTime),
            };
          }
          return prev;
        }, undefined);

        const liveDataEntry = getOrCreateLiveData(vQueue.QueueEntityId);
        if (!liveDataEntry.queue) {
          liveDataEntry.queue = {} as Record<QueueTypeEnum, any>;
        }

        liveDataEntry.queue!.RETURN_TIME = {
          returnStart: nextSlot ? parseTimeInTimezone(nextSlot.startTime.toISOString(), this.timezone) : null,
          returnEnd: nextSlot ? parseTimeInTimezone(nextSlot.endTime.toISOString(), this.timezone) : null,
          state: nextSlot ? 'AVAILABLE' : 'TEMP_FULL',
        };
      }
    }

    // Process wait times
    for (const attraction of waitTimes) {
      if (!attraction || !attraction.queues) continue;

      let attractionLiveData: LiveData | null = null;
      let hasOperatingQueue = false;
      let isBrokenDown = false;

      for (const queue of attraction.queues) {
        let rideId: string | null = null;

        const poiId = queue.alternate_ids.find((x) => x.system_name === 'POI');
        if (poiId) {
          rideId = poiId.system_id;
        } else if (attraction.wait_time_attraction_id) {
          rideId = this.getRideIDFromWaitTimeId(poi, attraction.wait_time_attraction_id);
        }

        if (!rideId) continue;

        if (!attractionLiveData) {
          attractionLiveData = getOrCreateLiveData(rideId);
        }

        switch (queue.queue_type) {
          case 'STANDBY':
            if (queue.status === 'OPEN' || queue.status === 'RIDE_NOW') {
              let waitTime = queue.display_wait_time ?? undefined;
              if (waitTime === undefined && queue.status === 'RIDE_NOW') {
                waitTime = 0;
              }

              if (!attractionLiveData.queue) {
                attractionLiveData.queue = {};
              }
              attractionLiveData.queue.STANDBY = {waitTime};
              hasOperatingQueue = true;
            }

            if (queue.status === 'BRIEF_DELAY' || queue.status === 'WEATHER_DELAY') {
              isBrokenDown = true;
            }

            if (queue.status === 'OPENS_AT' && queue.opens_at) {
              if (!attractionLiveData.operatingHours) {
                attractionLiveData.operatingHours = [];
              }
              attractionLiveData.operatingHours.push({
                type: 'OPERATING',
                startTime: queue.opens_at,
                endTime: null,
              });
            }

            if (queue.status === 'EXTENDED_CLOSURE' || queue.status === 'COMING_SOON') {
              attractionLiveData.status = 'CLOSED';
            }

            if (queue.status === 'AT_CAPACITY') {
              attractionLiveData.status = 'DOWN';
            }
            break;

          case 'SINGLE':
            if (attraction.has_single_rider && queue.status === 'OPEN') {
              if (!attractionLiveData.queue) {
                attractionLiveData.queue = {};
              }
              attractionLiveData.queue.SINGLE_RIDER = {waitTime: null};
              hasOperatingQueue = true;
            }
            break;

          case 'EXPRESS':
            // Express Pass — status field unreliable (always CLOSED).
            // display_wait_time !== 995 means Express is available.
            // 995 is Universal's "not available" sentinel.
            // Wait time values are unreliable, report null.
            if (queue.display_wait_time !== undefined && queue.display_wait_time !== 995) {
              if (!attractionLiveData.queue) {
                attractionLiveData.queue = {};
              }
              attractionLiveData.queue.PAID_STANDBY = {waitTime: null};
            }
            break;
        }
      }

      if (attractionLiveData) {
        if (isBrokenDown) {
          attractionLiveData.status = 'DOWN';
        } else if (hasOperatingQueue) {
          attractionLiveData.status = 'OPERATING';
        } else {
          attractionLiveData.status = 'CLOSED';
        }
      }
    }

    // Process show times
    const shows = await this.getFilteredShows();
    const now = new Date();

    for (const show of shows) {
      const showEntry = getOrCreateLiveData(show.Id.toString());
      showEntry.status = 'OPERATING';

      if (show.StartDateTimes?.length) {
        // The API returns naive "YYYY-MM-DD HH:mm:ss" strings in the park's
        // local time. The previous code did `new Date(str)` which V8 parses
        // as UTC for the space-separated form, then re-projected through the
        // timezone — leaving every show shifted by the park's UTC offset and
        // most of the day's slots wrongly "in the past".
        showEntry.showtimes = show.StartDateTimes
          .map((timeStr) => {
            const [datePart, timePart] = timeStr.split(' ');
            if (!datePart || !timePart) return null;
            const startIso = constructDateTime(datePart, timePart, this.timezone);
            if (isBefore(new Date(startIso), now)) return null;
            return {
              type: 'Performance Time',
              startTime: startIso,
              endTime: startIso,
            };
          })
          .filter((x): x is NonNullable<typeof x> => x !== null);
      }
    }

    // Add POI wait times as fallback
    for (const ride of [...poi.Rides, ...poi.Shows]) {
      if (ride.WaitTime === undefined || ride.WaitTime === null) continue;

      const rideId = ride.Id.toString();
      const existingData = liveDataMap.get(rideId);
      if (existingData?.queue?.STANDBY) continue;

      const rideEntry = getOrCreateLiveData(rideId);

      if (ride.WaitTime >= 0) {
        rideEntry.status = 'OPERATING';
        if (!rideEntry.queue) {
          rideEntry.queue = {};
        }
        rideEntry.queue.STANDBY = {waitTime: ride.WaitTime};
      } else {
        // Negative wait times indicate special states
        if (ride.WaitTime === -4 || ride.WaitTime === -2) {
          rideEntry.status = 'DOWN';
        } else if (ride.WaitTime === -6) {
          rideEntry.status = 'CLOSED';
        }
      }
    }

    // Layer Express Now (paid return time) offers from the UDX API. Only
    // attached to attractions that already appear in the live-data map —
    // a paid return-time without a known ride is not actionable downstream.
    let expressNowOffers: Record<string, ExpressNowOffer> = {};
    try {
      expressNowOffers = await this.getExpressNowOffers();
    } catch (err: any) {
      console.warn('Universal: Express Now offers fetch failed:', String(err?.message ?? err).split('\n')[0]);
    }
    for (const [placeId, offer] of Object.entries(expressNowOffers)) {
      if (offer.vl_inventory <= 0) continue;

      const poiId = this.getRideIDFromWaitTimeId(poi, placeId);
      if (!poiId) continue;

      const entry = liveDataMap.get(poiId);
      if (!entry) continue;

      // Defensive: parseExpressNowResponse already validates the slot
      // format, so this should never throw — but if `parseTimeInTimezone`
      // ever surprises us on a future format change, skip just this offer
      // rather than bringing down buildLiveData for the whole destination.
      let startDate: Date;
      let endDate: Date;
      try {
        startDate = new Date(parseTimeInTimezone(offer.inventory_time_slot, this.timezone));
        endDate = addMinutes(startDate, offer.inventory_time_minutes);
        if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
          throw new Error('invalid date');
        }
      } catch (err: any) {
        console.warn(
          `Universal: skipping Express Now offer for ${placeId} — bad time slot ${offer.inventory_time_slot}: ${err?.message ?? err}`,
        );
        continue;
      }

      if (!entry.queue) entry.queue = {};
      entry.queue.PAID_RETURN_TIME = this.buildPaidReturnTimeQueue(
        'AVAILABLE',
        startDate,
        endDate,
        'USD',
        Math.round(offer.product_price * 100), // dollars → cents
      );
    }

    return liveData;
  }

  /**
   * Build schedules for all parks
   */
  protected async buildSchedules(): Promise<EntitySchedule[]> {
    const parks = await this.getParks(this.city);
    const schedules: EntitySchedule[] = [];

    for (const park of parks) {
      const venueSchedule = await this.getVenueSchedule(park.Id.toString());
      const schedule = [];

      for (const daySchedule of venueSchedule) {
        if (daySchedule.VenueStatus === 'Closed') continue;

        // Main operating hours
        schedule.push({
          date: daySchedule.Date,
          openingTime: parseTimeInTimezone(daySchedule.OpenTimeString, this.timezone),
          closingTime: parseTimeInTimezone(daySchedule.CloseTimeString, this.timezone),
          type: 'OPERATING' as const,
        });

        // Early entry hours
        if (daySchedule.EarlyEntryString) {
          schedule.push({
            date: daySchedule.Date,
            openingTime: parseTimeInTimezone(daySchedule.EarlyEntryString, this.timezone),
            closingTime: parseTimeInTimezone(daySchedule.OpenTimeString, this.timezone),
            type: 'EXTRA_HOURS' as const,
          });
        }
      }

      schedules.push({
        id: park.Id.toString(),
        schedule,
      });
    }

    return schedules;
  }
}

/**
 * Universal Studios Orlando
 */
@destinationController({category: 'Universal'})
export class UniversalOrlando extends Universal {
  resortLocation = {latitude: 28.4719, longitude: -81.4685};

  constructor(options?: DestinationConstructor) {
    super({
      ...options,
      config: {
        city: 'orlando',
        resortName: 'Universal Orlando Resort',
        resortSlug: 'universalorlando',
        resortKey: 'uor',
        timezone: 'America/New_York',
        parkLatitude: '28.4747',
        parkLongitude: '-81.4682',
        ...options?.config,
      },
    });
  }
}

/**
 * Universal Studios Hollywood
 */
@destinationController({category: 'Universal'})
export class UniversalStudios extends Universal {
  resortLocation = {latitude: 34.1381, longitude: -118.3534};

  constructor(options?: DestinationConstructor) {
    super({
      ...options,
      config: {
        city: 'hollywood',
        resortName: 'Universal Studios Hollywood',
        resortSlug: 'universalstudios',
        resortKey: 'ush',
        timezone: 'America/Los_Angeles',
        parkLatitude: '34.1381',
        parkLongitude: '-118.3534',
        ...options?.config,
      },
    });
  }
}

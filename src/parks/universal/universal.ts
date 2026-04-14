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
import {formatUTC, parseTimeInTimezone, formatInTimezone, addDays, isBefore, hostnameFromUrl} from '../../datetime.js';
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
 * The raw JSON — confirmed via static analysis of the Flutter
 * `_$ExpressNowOfferResponseFromJson` parser — uses string-typed numerics:
 * `inventory_time_minutes`, `return_time_detail_id`, `product_price`,
 * `max_quantity`, `vl_inventory` all arrive as strings and are parsed
 * via `int.parse()` / `double.parse()`. `inventory_time_slot` is a
 * `DateTime.parse()`-compatible string.
 */
type ExpressNowOffer = {
  offer_id: string;
  place_id: string;
  inventory_time_slot: string;   // ISO datetime — return window start
  inventory_time_minutes: number; // window length in minutes
  product_price: number;          // USD, decimal (e.g. 19.99)
  vl_inventory: number;           // remaining inventory
};

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

  /** UDX platform API base — new Flutter app API (Express Now, places). */
  @config
  udxBase: string = "";

  /** UDX OAuth2 client ID for client_credentials flow. */
  @config
  udxClientId: string = "";

  /** UDX OAuth2 client secret. */
  @config
  udxClientSecret: string = "";

  /**
   * Flutter app API key for UDX calls (e.g. `UORFlutterAndroidApp`). The
   * legacy Android app key (`AndroidMobileApp`) is NOT accepted by the UDX
   * Express Now endpoint — a resort-specific Flutter key is required.
   */
  @config
  flutterAppKey: string = "";

  @config
  city: string = "orlando";

  @config
  resortName: string = "Universal Orlando Resort";

  @config
  resortSlug: string = "universalorlando";

  @config
  resortKey: string = "uor";

  @config
  timezone: string = "America/New_York";

  /** Park centre latitude (for Express Now offers request). */
  @config
  parkLatitude: number = 0;

  /** Park centre longitude. */
  @config
  parkLongitude: number = 0;

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

  // ─── UDX platform API (Express Now, new Flutter app) ──────────────────────

  /**
   * Inject Bearer token on UDX API requests (not auth endpoint).
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
    requestObj.headers = {
      ...requestObj.headers,
      'user-agent': 'Dart/3.6 (dart:io)',
      'accept-language': 'en-US',
      'x-uniwebservice-platform': 'Android',
      'x-uniwebservice-platformversion': '14',
      'x-uniwebservice-device': 'ONEPLUS A5000',
      'x-uniwebservice-appversion': '7.14.0',
      'Authorization': `Bearer ${token}`,
    };
  }

  /** Fetch UDX OAuth2 token via client credentials. */
  @http({tags: ['udxAuth']} as any)
  async fetchUdxToken(): Promise<HTTPObj> {
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

  /** Cached UDX token — expires per API-supplied expires_in. */
  @cache({callback: (resp: {token: string; expiresIn: number}) => resp?.expiresIn || 3600})
  async getUdxToken(): Promise<{token: string; expiresIn: number}> {
    const resp = await this.fetchUdxToken();
    const data: any = await resp.json();
    if (!data?.access_token) {
      throw new Error('Universal UDX: failed to obtain access_token');
    }
    return {
      token: data.access_token,
      expiresIn: (data.expires_in as number) || 3600,
    };
  }

  /**
   * Inject Express Now request headers (x-source-id microservice, resort code,
   * legacy webservice key). The /get-offers endpoint requires both the UDX
   * Bearer token and these legacy headers.
   */
  @inject({
    eventName: 'httpRequest',
    tags: 'expressNowOffers',
  })
  async injectExpressNowHeaders(requestObj: HTTPObj): Promise<void> {
    // Real app uses resort-specific flagship key (UORFlutterAndroidApp,
    // USHFlutterAndroidApp, etc.). Fall back to the legacy appKey if the
    // Flutter-specific one isn't configured.
    const flutterKey = this.flutterAppKey || `${this.resortKey.toUpperCase()}FlutterAndroidApp`;
    requestObj.headers = {
      ...requestObj.headers,
      'x-resort-area-code': this.resortKey.toUpperCase(),
      'X-UNIWebService-ApiKey': flutterKey,
      'Content-Type': 'application/json',
    };
  }

  /**
   * Stable instance ID for unauthenticated Express Now calls.
   * Cached for 30 days — the Flutter app generates this with Uuid().v4() once
   * and treats it as a long-lived guest identifier.
   */
  @cache({ttlSeconds: 60 * 60 * 24 * 30})
  async getExpressNowInstanceId(): Promise<string> {
    return crypto.randomUUID();
  }

  /**
   * POST to UDX Express Now offers endpoint.
   * Returns a list of offers keyed by place_id (a UUID matching the legacy
   * POI's ExternalIds.PlaceId).
   */
  @http({tags: ['expressNowOffers'], retries: 0} as any)
  async fetchExpressNowOffers(): Promise<HTTPObj> {
    const instanceId = await this.getExpressNowInstanceId();
    // Jitter the point within ~150m of park centre so requests don't look
    // identical across polls / installations.
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
   * Get parsed Express Now offers, grouped by place_id (latest/cheapest per ride).
   */
  @cache({ttlSeconds: 60})
  async getExpressNowOffers(): Promise<Record<string, ExpressNowOffer>> {
    if (!this.udxBase || !this.parkLatitude || !this.parkLongitude) return {};

    let resp: HTTPObj | undefined;
    try {
      resp = await this.fetchExpressNowOffers();
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      // OFFERS_NOT_FOUND / 404 is expected when Express Now isn't actively
      // offering — not a real error.
      if (msg.includes('404') || msg.includes('OFFERS_NOT_FOUND')) return {};
      console.warn('Universal: Express Now offers fetch failed:', msg.split('\n')[0]);
      return {};
    }

    const data: any = await resp.json();
    // Wrapper shape confirmed from APK: `{"predictions": [<offer>, ...]}`.
    const offers: any[] = Array.isArray(data?.predictions) ? data.predictions : [];
    const grouped: Record<string, ExpressNowOffer> = {};

    for (const raw of offers) {
      const placeId = raw?.place_id;
      if (!placeId) continue;

      // All numeric fields arrive as strings — parse explicitly.
      const parsed: ExpressNowOffer = {
        offer_id: raw.offer_id,
        place_id: placeId,
        inventory_time_slot: raw.inventory_time_slot,
        inventory_time_minutes: parseInt(raw.inventory_time_minutes, 10),
        product_price: parseFloat(raw.product_price),
        vl_inventory: parseInt(raw.vl_inventory, 10),
      };

      if (!Number.isFinite(parsed.product_price) || !Number.isFinite(parsed.inventory_time_minutes)) continue;

      const existing = grouped[placeId];
      // Prefer the earliest-starting available slot per place
      if (!existing || new Date(parsed.inventory_time_slot) < new Date(existing.inventory_time_slot)) {
        grouped[placeId] = parsed;
      }
    }
    return grouped;
  }

  // ─── Legacy API injection ────────────────────────────────────────────────

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
            ride.Latitude && ride.Longitude
              ? TagBuilder.location(ride.Latitude, ride.Longitude, 'Attraction Location')
              : undefined,
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
        transform: (entity, show) => {
          // Add location tag if available
          entity.tags = [
            show.Latitude && show.Longitude
              ? TagBuilder.location(show.Latitude, show.Longitude, 'Show Venue')
              : undefined,
          ].filter((tag): tag is NonNullable<typeof tag> => tag !== undefined);
          return entity;
        },
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
        transform: (entity, dining) => {
          // Add location tag if available
          entity.tags = [
            dining.Latitude && dining.Longitude
              ? TagBuilder.location(dining.Latitude, dining.Longitude, 'Restaurant Location')
              : undefined,
          ].filter((tag): tag is NonNullable<typeof tag> => tag !== undefined);
          return entity;
        },
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

      if (show.StartDateTimes) {
        showEntry.showtimes = show.StartDateTimes
          .map((timeStr) => {
            const showTime = new Date(timeStr);
            if (isBefore(showTime, now)) return null;

            const formattedTime = parseTimeInTimezone(showTime.toISOString(), this.timezone);
            return {
              type: 'Performance Time',
              startTime: formattedTime,
              endTime: formattedTime,
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

    // Layer Express Now (paid return time) offers from the UDX API.
    const expressNowOffers = await this.getExpressNowOffers();
    for (const [placeId, offer] of Object.entries(expressNowOffers)) {
      if (offer.vl_inventory <= 0) continue;

      const poiId = this.getRideIDFromWaitTimeId(poi, placeId);
      if (!poiId) continue;

      const entry = liveDataMap.get(poiId);
      if (!entry) continue;
      if (!entry.queue) entry.queue = {};

      const start = parseTimeInTimezone(offer.inventory_time_slot, this.timezone);
      const endDate = new Date(new Date(offer.inventory_time_slot).getTime() + offer.inventory_time_minutes * 60_000);
      const end = parseTimeInTimezone(endDate.toISOString(), this.timezone);

      entry.queue.PAID_RETURN_TIME = {
        returnStart: start,
        returnEnd: end,
        state: 'AVAILABLE',
        price: {
          currency: 'USD' as any,
          amount: Math.round(offer.product_price * 100), // dollars → cents
        },
      };
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

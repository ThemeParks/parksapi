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
import {formatUTC, parseTimeInTimezone, formatInTimezone, addDays, isBefore} from '../../datetime.js';

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

  constructor(options?: DestinationConstructor) {
    super(options);
    this.addConfigPrefix('UNIVERSALSTUDIOS');
  }

  /**
   * Inject API key into all HTTP requests for Universal's API
   */
  @inject({
    eventName: 'httpRequest',
    hostname: {$regex: /universalorlando\.com|universalstudios\.com/},
    tags: { $nin: ['apiKeyFetch'] }
  })
  async injectAPIKey(requestObj: HTTPObj): Promise<void> {
    const apiKeyData = await this.getAPIKey();

    requestObj.headers = {
      ...requestObj.headers,
      'X-UNIWebService-ApiKey': this.appKey,
      'X-UNIWebService-Token': apiKeyData.apiKey,
    };
  }

  /**
   * Handle 401 responses by clearing cached API key
   */
  @inject({
    eventName: 'httpError',
    hostname: {$regex: /universalorlando\.com|universalstudios\.com/},
  })
  async handleUnauthorized(requestObj: HTTPObj): Promise<void> {
    if (requestObj.response?.status === 401) {
      // Clear cached API key to force refresh
      const {CacheLib} = await import('../../cache.js');
      CacheLib.delete('getAPIKey:[]');
    }
  }

  /**
   * Get API authentication token
   */
  @cache({
    callback: (response) => response?.expiresIn || 3600
  })
  async getAPIKey(): Promise<{ apiKey: string; expiresIn: number }> {
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
  @http({ cacheSeconds: 0 })
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
              Id: { type: 'number' },
              ExternalIds: {
                type: 'object',
                properties: {
                  ContentId: { type: 'string' },
                },
                required: ['ContentId'],
              },
              MblDisplayName: { type: 'string' },
              AdmissionRequired: { type: 'boolean' },
            },
            required: ['Id', 'ExternalIds', 'MblDisplayName', 'AdmissionRequired'],
          },
        },
      },
      required: ['Results'],
    },
    cacheSeconds: 180 * 60, // 3 hours
  })
  async fetchParks(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.baseURL}/venues?city=${this.city}`,
      options: { json: true },
    } as any as HTTPObj;
  }

  /**
   * Get parks (filtered for admission required)
   */
  @cache({ ttlSeconds: 60 * 60 * 3 })
  async getParks() {
    const resp = await this.fetchParks();
    const data: UniversalVenuesResponse = await resp.json();
    return data.Results.filter((x) => x.AdmissionRequired);
  }

  /**
   * Fetch POI (Points of Interest) data
   */
  @http({ cacheSeconds: 60 })
  async fetchPOI(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.baseURL}/pointsofinterest?city=${this.city}`,
      options: { json: true },
    } as any as HTTPObj;
  }

  /**
   * Get POI data (cached)
   */
  @cache({ ttlSeconds: 60 })
  async getPOI(): Promise<UniversalPOIResponse> {
    const resp = await this.fetchPOI();
    return await resp.json();
  }

  /**
   * Fetch wait time data
   */
  @http({ cacheSeconds: 60 })
  async fetchWaitTimes(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.assetsBase}/${this.resortKey}/wait-time/wait-time-attraction-list.json`,
      options: { json: true },
    } as any as HTTPObj;
  }

  /**
   * Get wait time data (cached)
   */
  @cache({ ttlSeconds: 60 })
  async getWaitTimes(): Promise<UniversalWaitTimeResponse> {
    const resp = await this.fetchWaitTimes();
    return await resp.json();
  }

  /**
   * Fetch virtual queue states
   */
  @http({ cacheSeconds: 60 })
  async fetchVirtualQueueStates(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.baseURL}/Queues`,
      queryParams: {
        city: this.city,
        page: '1',
        pageSize: 'all',
      },
      options: { json: true },
    } as any as HTTPObj;
  }

  /**
   * Get virtual queue states (cached)
   */
  @cache({ ttlSeconds: 60 })
  async getVirtualQueueStates(): Promise<UniversalVirtualQueueState[]> {
    const resp = await this.fetchVirtualQueueStates();
    const data: any = await resp.json();
    return data?.Results || [];
  }

  /**
   * Fetch virtual queue details for a specific queue
   */
  @http({ cacheSeconds: 60 })
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
      options: { json: true },
    } as any as HTTPObj;
  }

  /**
   * Get virtual queue details (cached)
   */
  @cache({ ttlSeconds: 60 })
  async getVirtualQueueDetails(queueId: string): Promise<UniversalVirtualQueueDetails> {
    const resp = await this.fetchVirtualQueueDetails(queueId);
    return await resp.json();
  }

  /**
   * Fetch venue schedule
   */
  @http({ cacheSeconds: 180 * 60 })
  async fetchVenueSchedule(venueId: string): Promise<HTTPObj> {
    const endDate = formatInTimezone(addDays(new Date(), 190), this.timezone, 'date');

    return {
      method: 'GET',
      url: `${this.baseURL}/venues/${venueId}/hours`,
      queryParams: {
        endDate: endDate,
      },
      options: { json: true },
    } as any as HTTPObj;
  }

  /**
   * Get venue schedule (cached)
   */
  @cache({ ttlSeconds: 60 * 60 * 3 })
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
    const poi = await this.getPOI();
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
    const poi = await this.getPOI();
    const parks = await this.getParks();
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
        locationFields: { lat: 'Latitude', lng: 'Longitude' },
        destinationId,
        timezone: this.timezone,
        filter: (ride) => shouldIncludeUniversalAttraction(ride.MblDisplayName || ''),
      }),

      // Shows
      ...this.mapEntities(shows, {
        idField: 'Id',
        nameField: 'MblDisplayName',
        entityType: 'SHOW',
        parentIdField: 'VenueId',
        locationFields: { lat: 'Latitude', lng: 'Longitude' },
        destinationId,
        timezone: this.timezone,
      }),

      // Restaurants
      ...this.mapEntities(poi.DiningLocations, {
        idField: 'Id',
        nameField: 'MblDisplayName',
        entityType: 'RESTAURANT',
        parentIdField: 'VenueId',
        locationFields: { lat: 'Latitude', lng: 'Longitude' },
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

    const poi = await this.getPOI();
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
              attractionLiveData.queue.STANDBY = { waitTime };
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

            if (queue.status === 'EXTENDED_CLOSURE') {
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
              attractionLiveData.queue.SINGLE_RIDER = { waitTime: null };
              hasOperatingQueue = true;
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
        rideEntry.queue.STANDBY = { waitTime: ride.WaitTime };
      } else {
        // Negative wait times indicate special states
        if (ride.WaitTime === -4 || ride.WaitTime === -2) {
          rideEntry.status = 'DOWN';
        } else if (ride.WaitTime === -6) {
          rideEntry.status = 'CLOSED';
        }
      }
    }

    return liveData;
  }

  /**
   * Build schedules for all parks
   */
  protected async buildSchedules(): Promise<EntitySchedule[]> {
    const parks = await this.getParks();
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
@destinationController({ category: 'Universal' })
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
        ...options?.config,
      },
    });
  }
}

/**
 * Universal Studios Hollywood
 */
@destinationController({ category: 'Universal' })
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
        ...options?.config,
      },
    });
  }
}

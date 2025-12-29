/**
 * Attractions.io v3 API Integration
 *
 * Provides support for Cedar Fair parks using the Attractions.io v3 API.
 * This framework supports 11 Cedar Fair parks with real-time wait times,
 * venue status, POI data, and operating hours.
 *
 * @module cedarfair/attractionsio
 */

import {Destination, type DestinationConstructor} from '../../destination.js';
import config from '../../config.js';
import {http, type HTTPObj} from '../../http.js';
import {cache} from '../../cache.js';
import {inject} from '../../injector.js';
import {destinationController} from '../../destinationRegistry.js';
import type {Entity, LiveData, EntitySchedule} from '@themeparks/typelib';
import {formatInTimezone, parseTimeInTimezone, addDays, isBefore} from '../../datetime.js';

/**
 * API Response Types
 */

/**
 * Wait time data for a single attraction
 */
type AttractionsIOWaitTimeDetail = {
  fimsId: string;
  regularWaittime?: {
    waitTime: number;
    createdDateTime: string;
  };
  fastlaneWaittime?: {
    waitTime: number;
    createdDateTime: string;
  };
};

/**
 * Wait times API response structure
 */
type AttractionsIOWaitTime = {
  venues: Array<{
    details: AttractionsIOWaitTimeDetail[];
  }>;
};

/**
 * Venue status detail for a single attraction
 */
type AttractionsIOVenueStatusDetail = {
  fimsId: string;
  status: 'Opened' | 'Closed' | string;
};

/**
 * Venue status API response structure
 */
type AttractionsIOVenueStatus = {
  venues: Array<{
    details: AttractionsIOVenueStatusDetail[];
  }>;
};

/**
 * Park configuration with category definitions
 */
type AttractionsIOParkConfig = {
  parkName: string;
  poi_config: {
    parkModes: Array<{
      category: {
        values: Array<{
          label?: string;
          title?: string;
          filters: Array<{
            fieldName: string;
            values: Array<{
              value: number | string;
            }>;
          }>;
        }>;
      };
    }>;
  };
};

/**
 * Point of interest (POI) data structure
 */
type AttractionsIOPOI = {
  fimsId: string;
  name: string;
  type?: {id: number};
  showType?: {id: number};
  foodTypes?: {id: number};
  location?: {
    latitude: number;
    longitude: number;
  };
};

/**
 * Operating hours schedule response
 */
type AttractionsIOSchedule = {
  isParkClosed: boolean;
  operatings?: Array<{
    items?: Array<{
      timeFrom: string;  // "HH:mm"
      timeTo: string;    // "HH:mm"
      isBuyout?: boolean;
    }>;
  }>;
};

/**
 * App version response from appwatch API
 */
type AttractionsIOAppVersion = {
  version?: string;
};

/**
 * Base class for Attractions.io v3 API integration
 *
 * Provides a complete implementation for Cedar Fair parks using the Attractions.io v3 API.
 * Supports real-time wait times, venue status, POI data, and operating hours.
 *
 * Key Features:
 * - Android app user-agent authentication
 * - Dual-source live data (wait times + venue status)
 * - Dynamic category filtering
 * - Custom config path support
 * - Extra category types support
 */
@config
class AttractionsIOV3 extends Destination {
  /**
   * Park timezone (e.g., "America/New_York")
   * Set via constructor config
   */
  timezone: string = "America/New_York";

  /**
   * Destination ID for this park
   * Set via constructor config
   */
  destinationId: string = "";

  /**
   * Base URL for the Attractions.io real-time API
   * @config
   */
  @config
  realTimeBaseURL: string = "";

  /**
   * Park ID for API requests (numeric string)
   * @config
   */
  @config
  parkId: string = "";

  /**
   * Optional custom config path (overrides default /config/park/{parkId})
   * @config
   */
  @config
  configPath: string | null = null;

  /**
   * Android app package ID (e.g., "com.cedarfair.cedarpoint")
   * @config
   */
  @config
  appId: string | null = null;

  /**
   * Android app display name (e.g., "Cedar Point")
   * @config
   */
  @config
  appName: string | null = null;

  /**
   * Category names for attraction filtering
   * @config
   */
  @config
  attractionCategories: string[] = ['Rides'];

  /**
   * Category names for show filtering
   * @config
   */
  @config
  showCategories: string[] = ['Shows'];

  /**
   * Category names for dining filtering
   * @config
   */
  @config
  diningCategories: string[] = ['Dining'];

  /**
   * Extra attraction category type IDs not in POI config
   * @config
   */
  @config
  extraAttractionCategoryTypes: number[] = [];

  /**
   * Extra show category type IDs not in POI config
   * @config
   */
  @config
  extraShowCategoryTypes: number[] = [];

  /**
   * Extra restaurant category type IDs not in POI config
   * @config
   */
  @config
  extraRestaurantCategoryTypes: number[] = [];

  constructor(options?: DestinationConstructor) {
    super(options);

    // Set timezone and destinationId from config
    if (options?.config?.timezone) {
      this.timezone = Array.isArray(options.config.timezone) ? options.config.timezone[0] : options.config.timezone;
    }
    if (options?.config?.destinationId) {
      this.destinationId = Array.isArray(options.config.destinationId) ? options.config.destinationId[0] : options.config.destinationId;
    }

    // Add config prefix for environment variable lookup
    this.addConfigPrefix('ATTRACTIONSIOV3');
  }

  /**
   * Generate cache key prefix to prevent cache collisions between parks
   * Uses parkId to ensure each park has its own cache namespace
   */
  getCacheKeyPrefix(): string {
    return `attractionsio:${this.parkId}`;
  }

  /**
   * Initialize and validate configuration
   * @protected
   */
  protected async _init(): Promise<void> {
    // Validate required fields after @config decorator has been applied
    if (!this.realTimeBaseURL) {
      throw new Error('realTimeBaseURL is required for Attractions.io v3 parks');
    }
    if (!this.parkId) {
      throw new Error('parkId is required for Attractions.io v3 parks');
    }
  }

  // ============================================================================
  // HTTP Methods (Phase 2)
  // ============================================================================

  /**
   * Fetch real-time wait times for all attractions
   * Cached for 1 minute
   */
  @http({cacheSeconds: 60})
  async fetchWaitTimes(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.realTimeBaseURL}/wait-times/park/${this.parkId}`,
      options: {json: true},
    } as HTTPObj;
  }

  /**
   * Fetch venue operational status (authoritative for OPERATING/CLOSED state)
   * Cached for 1 minute
   */
  @http({cacheSeconds: 60})
  async fetchVenueStatus(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.realTimeBaseURL}/venue-status/park/${this.parkId}`,
      options: {json: true},
    } as HTTPObj;
  }

  /**
   * Fetch park configuration including category definitions
   * Cached for 24 hours
   * Supports custom configPath override for specific parks
   */
  @http({cacheSeconds: 60 * 60 * 24})
  async fetchParkConfig(): Promise<HTTPObj> {
    const url = this.configPath
      ? `${this.realTimeBaseURL}/${this.configPath}`
      : `${this.realTimeBaseURL}/config/park/${this.parkId}`;

    return {
      method: 'GET',
      url,
      options: {json: true},
    } as HTTPObj;
  }

  /**
   * Fetch point of interest (POI) data for the park
   * Cached for 24 hours
   */
  @http({cacheSeconds: 60 * 60 * 24})
  async fetchParkPOI(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.realTimeBaseURL}/poi/park/${this.parkId}`,
      options: {json: true},
    } as HTTPObj;
  }

  /**
   * Fetch operating hours for a specific date
   * Cached for 24 hours
   *
   * @param date - Date in YYYYMMDD format
   */
  @http({cacheSeconds: 60 * 60 * 24})
  async fetchScheduleForDate(date: string): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.realTimeBaseURL}/operating-hours/park/${this.parkId}?date=${date}`,
      options: {json: true},
    } as HTTPObj;
  }

  /**
   * Fetch Android app version from appwatch API
   * Cached for 12 hours
   */
  @http({cacheSeconds: 60 * 60 * 12})
  async fetchAppVersion(): Promise<HTTPObj> {
    if (!this.appId) {
      throw new Error('appId is required for app version fetching');
    }

    return {
      method: 'GET',
      url: `https://api.themeparks.wiki/appwatch/latest/${this.appId}`,
      options: {json: true},
    } as HTTPObj;
  }

  // ============================================================================
  // Cached Getter Methods (Phase 2)
  // ============================================================================

  /**
   * Get wait times data with 1-minute cache
   */
  @cache({ttlSeconds: 60})
  async getWaitTimes(): Promise<AttractionsIOWaitTime> {
    const resp = await this.fetchWaitTimes();
    return await resp.json();
  }

  /**
   * Get venue status data with 1-minute cache
   * Returns null if venue status API is unavailable (graceful degradation)
   */
  @cache({ttlSeconds: 60})
  async getVenueStatus(): Promise<AttractionsIOVenueStatus | null> {
    try {
      const resp = await this.fetchVenueStatus();
      return await resp.json();
    } catch {
      // Don't fail if venue status is unavailable - it's supplementary data
      return null;
    }
  }

  /**
   * Get park configuration with 24-hour cache
   */
  @cache({ttlSeconds: 60 * 60 * 24})
  async getParkConfig(): Promise<AttractionsIOParkConfig> {
    const resp = await this.fetchParkConfig();
    return await resp.json();
  }

  /**
   * Get POI data with 24-hour cache
   */
  @cache({ttlSeconds: 60 * 60 * 24})
  async getParkPOI(): Promise<AttractionsIOPOI[]> {
    const resp = await this.fetchParkPOI();
    return await resp.json();
  }

  /**
   * Get Android app version with 12-hour cache
   * Returns fallback version if unavailable
   */
  @cache({ttlSeconds: 60 * 60 * 12})
  async getAndroidAppVersion(): Promise<string> {
    if (!this.appId) {
      return '1.0.0';  // Fallback version
    }

    try {
      const resp = await this.fetchAppVersion();
      const data: AttractionsIOAppVersion = await resp.json();
      return data?.version || '1.0.0';
    } catch {
      return '1.0.0';  // Fallback on error
    }
  }

  // ============================================================================
  // Authentication (Phase 3)
  // ============================================================================

  /**
   * Inject Android app user-agent header for all API requests
   * Format: {appName}/{appVersion} ({appId}; Android 34)
   */
  @inject({
    eventName: 'httpRequest',
    hostname: function() {
      if (!this.realTimeBaseURL) return '';
      try {
        return new URL(this.realTimeBaseURL).hostname;
      } catch {
        return '';
      }
    },
  })
  async injectAndroidUserAgent(requestObj: HTTPObj): Promise<void> {
    if (this.appId && this.appName) {
      const appVersion = await this.getAndroidAppVersion();
      requestObj.headers = {
        ...requestObj.headers,
        'User-Agent': `${this.appName}/${appVersion} (${this.appId}; Android 34)`,
      };
    }
  }

  // ============================================================================
  // Helper Methods (Phase 4)
  // ============================================================================

  /**
   * Extract category type IDs from park config
   *
   * Parses the park configuration to find all type IDs matching the given
   * category names and field filter.
   *
   * @param categories - Array of category names to match (e.g., ['Rides'])
   * @param fieldFilter - Field name to extract IDs from (e.g., 'type', 'showType', 'foodTypes')
   * @returns Array of unique type IDs
   */
  @cache({ttlSeconds: 60 * 60 * 24})
  async getTypesFromCategories(categories: string[], fieldFilter: string = "type"): Promise<number[]> {
    const parkConfig = await this.getParkConfig();
    const types: number[] = [];

    parkConfig.poi_config.parkModes.forEach((mode) => {
      if (!mode.category || !mode.category.values) return;
      mode.category.values.forEach((cat) => {
        if (categories.includes(cat.label || cat.title || '')) {
          cat.filters?.forEach((filter) => {
            if (!filter.fieldName || !filter.values) return;
            if (filter.fieldName === fieldFilter) {
              filter.values.forEach((filterValue) => {
                const typeId = filterValue.value as number;
                if (!types.includes(typeId)) {
                  types.push(typeId);
                }
              });
            }
          });
        }
      });
    });

    return types;
  }

  /**
   * Find park entrance location from POI data
   *
   * Searches for common entrance names in POI data and returns coordinates.
   * Tries multiple entrance names in priority order.
   *
   * @returns Entrance coordinates or undefined if not found
   */
  async getParkEntranceLocation(): Promise<{latitude: number; longitude: number} | undefined> {
    const poiData = await this.getParkPOI();
    const entranceNames = ["Main Entrance", "Accessible Gate", "Front Gate"];

    for (const name of entranceNames) {
      const entrance = poiData.find(poi => poi.name?.startsWith(name));
      if (entrance?.location?.latitude && entrance?.location?.longitude) {
        return {
          latitude: entrance.location.latitude,
          longitude: entrance.location.longitude,
        };
      }
    }

    return undefined;
  }

  // ============================================================================
  // Template Method Implementation (Phase 5-7)
  // ============================================================================

  /**
   * Build entity list for the park
   *
   * Creates destination, park, attraction, show, and restaurant entities.
   * Uses dynamic category filtering from park config.
   *
   * @protected
   */
  protected async buildEntityList(): Promise<Entity[]> {
    const parkConfig = await this.getParkConfig();
    const poiData = await this.getParkPOI();
    const entranceLocation = await this.getParkEntranceLocation();
    const destinationId = `${this.destinationId}_destination`;

    // Get category types for filtering
    const attractionTypes = [
      ...await this.getTypesFromCategories(this.attractionCategories, "type"),
      ...this.extraAttractionCategoryTypes
    ];
    const showTypes = [
      ...await this.getTypesFromCategories(this.showCategories, "showType"),
      ...this.extraShowCategoryTypes
    ];
    const diningTypes = [
      ...await this.getTypesFromCategories(this.diningCategories, "foodTypes"),
      ...this.extraRestaurantCategoryTypes
    ];

    return [
      // Destination entity
      {
        id: destinationId,
        name: parkConfig.parkName,
        entityType: 'DESTINATION',
        timezone: this.timezone,
        location: entranceLocation,
      } as Entity,

      // Park entity
      {
        id: this.destinationId,
        name: parkConfig.parkName,
        entityType: 'PARK',
        timezone: this.timezone,
        location: entranceLocation,
        parentId: destinationId,
      } as Entity,

      // Attractions (filtered by type)
      ...this.mapEntities(
        poiData.filter(poi => poi.type?.id && attractionTypes.includes(poi.type.id)),
        {
          idField: 'fimsId',
          nameField: 'name',
          entityType: 'ATTRACTION',
          parentIdField: () => this.destinationId,
          locationFields: {
            lat: (poi: AttractionsIOPOI) => poi.location?.latitude,
            lng: (poi: AttractionsIOPOI) => poi.location?.longitude,
          },
          destinationId: this.destinationId,
          timezone: this.timezone,
        }
      ),

      // Shows (filtered by showType)
      ...this.mapEntities(
        poiData.filter(poi => poi.showType?.id && showTypes.includes(poi.showType.id)),
        {
          idField: 'fimsId',
          nameField: 'name',
          entityType: 'SHOW',
          parentIdField: () => this.destinationId,
          locationFields: {
            lat: (poi: AttractionsIOPOI) => poi.location?.latitude,
            lng: (poi: AttractionsIOPOI) => poi.location?.longitude,
          },
          destinationId: this.destinationId,
          timezone: this.timezone,
        }
      ),

      // Restaurants (filtered by foodTypes)
      ...this.mapEntities(
        poiData.filter(poi => poi.foodTypes?.id && diningTypes.includes(poi.foodTypes.id)),
        {
          idField: 'fimsId',
          nameField: 'name',
          entityType: 'RESTAURANT',
          parentIdField: () => this.destinationId,
          locationFields: {
            lat: (poi: AttractionsIOPOI) => poi.location?.latitude,
            lng: (poi: AttractionsIOPOI) => poi.location?.longitude,
          },
          destinationId: this.destinationId,
          timezone: this.timezone,
        }
      ),
    ];
  }

  /**
   * Build live data for all entities
   *
   * CRITICAL: Venue status is authoritative for operational state.
   * Wait times alone do not indicate an attraction is operating.
   *
   * @protected
   */
  protected async buildLiveData(): Promise<LiveData[]> {
    const [waitTimesData, venueStatusData] = await Promise.all([
      this.getWaitTimes(),
      this.getVenueStatus(),
    ]);

    // Build venue status lookup map (authoritative for operational state)
    const venueStatusMap = new Map<string, string>();
    if (venueStatusData?.venues) {
      venueStatusData.venues.forEach(venue => {
        venue.details?.forEach(detail => {
          if (detail.fimsId) {
            venueStatusMap.set(detail.fimsId.toUpperCase(), detail.status);
          }
        });
      });
    }

    const liveDataMap = new Map<string, LiveData>();

    // Process wait times
    waitTimesData.venues.forEach(venue => {
      venue.details?.forEach(detail => {
        const fimsId = detail.fimsId.toUpperCase();
        const venueStatus = venueStatusMap.get(fimsId);
        const isOpen = venueStatus === 'Opened';

        const liveData: LiveData = {
          id: fimsId,
          status: 'CLOSED',  // Default status
        };

        // Add STANDBY queue (if present)
        if (detail.regularWaittime?.createdDateTime) {
          if (!liveData.queue) {
            liveData.queue = {};
          }
          liveData.queue.STANDBY = {
            waitTime: detail.regularWaittime.waitTime || 0,
          };

          // Only set OPERATING if venue status confirms it's open
          if (isOpen || venueStatus === undefined) {
            liveData.status = 'OPERATING';
          }
        }

        // Add PAID_STANDBY queue (FastLane)
        if (detail.fastlaneWaittime?.createdDateTime) {
          if (!liveData.queue) {
            liveData.queue = {};
          }
          liveData.queue.PAID_STANDBY = {
            waitTime: detail.fastlaneWaittime.waitTime || 0,
          };

          if (isOpen || venueStatus === undefined) {
            liveData.status = 'OPERATING';
          }
        }

        // CRITICAL: Venue status is authoritative - override if closed
        if (venueStatus && venueStatus !== 'Opened') {
          liveData.status = 'CLOSED';
        }

        liveDataMap.set(fimsId, liveData);
      });
    });

    return Array.from(liveDataMap.values());
  }

  /**
   * Build schedule data for the park
   *
   * Fetches 90 days of operating hours starting from today.
   * Skips buyout events (private rentals).
   *
   * @protected
   */
  protected async buildSchedules(): Promise<EntitySchedule[]> {
    const now = new Date();
    const endDate = addDays(now, 90);

    // Generate list of dates to fetch
    const datesToFetch: string[] = [];
    for (let date = new Date(now); isBefore(date, endDate); date = addDays(date, 1)) {
      // Format as YYYYMMDD for API
      const parts = formatInTimezone(date, this.timezone, 'date').split('/');
      const dateStr = `${parts[2]}${parts[0]}${parts[1]}`; // YYYY + MM + DD
      datesToFetch.push(dateStr);
    }

    const scheduleData: Array<{date: string; type: 'OPERATING'; openingTime: string; closingTime: string}> = [];

    for (const dateStr of datesToFetch) {
      const resp = await this.fetchScheduleForDate(dateStr);
      const data: AttractionsIOSchedule = await resp.json();

      if (!data?.operatings || data.isParkClosed) {
        continue;
      }

      data.operatings.forEach(operating => {
        operating.items?.forEach(item => {
          // Skip buyout events or items missing times
          if (!item.timeFrom || !item.timeTo || item.isBuyout) {
            return;
          }

          // Parse date components
          const year = parseInt(dateStr.substring(0, 4));
          const month = parseInt(dateStr.substring(4, 6)) - 1;  // 0-indexed
          const day = parseInt(dateStr.substring(6, 8));
          const date = new Date(year, month, day);

          const dateFormatted = formatInTimezone(date, this.timezone, 'date');

          const openTime = parseTimeInTimezone(
            `${dateFormatted} ${item.timeFrom}`,
            this.timezone
          );
          const closeTime = parseTimeInTimezone(
            `${dateFormatted} ${item.timeTo}`,
            this.timezone
          );

          scheduleData.push({
            date: dateFormatted,
            type: 'OPERATING' as const,
            openingTime: openTime,
            closingTime: closeTime,
          });
        });
      });
    }

    return [{
      id: this.destinationId,
      schedule: scheduleData,
    }];
  }
}

// ============================================================================
// Park Subclasses (Phase 8)
// ============================================================================

/**
 * Cedar Point - Sandusky, Ohio
 * Park ID: 1
 */
@destinationController({category: ['Cedar Fair', 'Cedar Point']})
export class CedarPoint extends AttractionsIOV3 {
  constructor(options?: DestinationConstructor) {
    super({
      ...options,
      config: {
        timezone: 'America/New_York',
        parkId: '1',
        destinationId: 'cedarpoint',
        appId: 'com.cedarfair.cedarpoint',
        appName: 'Cedar Point',
        ...options?.config,
      },
    });
  }
}

/**
 * Knott's Berry Farm - Buena Park, California
 * Park ID: 4
 * Note: Includes water rides category (type 19) not in default config
 */
@destinationController({category: ['Cedar Fair', 'Knott\'s Berry Farm']})
export class KnottsBerryFarm extends AttractionsIOV3 {
  constructor(options?: DestinationConstructor) {
    super({
      ...options,
      config: {
        timezone: 'America/Los_Angeles',
        parkId: '4',
        destinationId: 'knottsberryfarm',
        extraAttractionCategoryTypes: [19] as any,  // Water rides (typed as number[] in class)
        appId: 'com.cedarfair.knottsberry',
        appName: 'Knott\'s Berry Farm',
        ...options?.config,
      },
    });
  }
}

/**
 * Worlds of Fun - Kansas City, Missouri
 * Park ID: 6
 * Note: Uses custom config path
 */
@destinationController({category: ['Cedar Fair', 'Worlds of Fun']})
export class WorldsOfFun extends AttractionsIOV3 {
  constructor(options?: DestinationConstructor) {
    super({
      ...options,
      config: {
        timezone: 'America/Chicago',
        parkId: '6',
        destinationId: 'worldsoffun',
        configPath: 'v2/config/park/wf',
        appId: 'com.cedarfair.worldsoffun',
        appName: 'Worlds of Fun',
        ...options?.config,
      },
    });
  }
}

/**
 * Dorney Park - Allentown, Pennsylvania
 * Park ID: 8
 * Note: Uses custom config path
 */
@destinationController({category: ['Cedar Fair', 'Dorney Park']})
export class DorneyPark extends AttractionsIOV3 {
  constructor(options?: DestinationConstructor) {
    super({
      ...options,
      config: {
        timezone: 'America/New_York',
        parkId: '8',
        destinationId: 'dorneypark',
        configPath: 'v2/config/park/dp',
        appId: 'com.cedarfair.dorneypark',
        appName: 'Dorney Park',
        ...options?.config,
      },
    });
  }
}

/**
 * Michigan's Adventure - Muskegon, Michigan
 * Park ID: 12
 * Note: Uses custom config path
 */
@destinationController({category: ['Cedar Fair', 'Michigan\'s Adventure']})
export class MichigansAdventure extends AttractionsIOV3 {
  constructor(options?: DestinationConstructor) {
    super({
      ...options,
      config: {
        timezone: 'America/Detroit',
        parkId: '12',
        destinationId: 'michigansadventure',
        configPath: 'v2/config/park/ma',
        appId: 'com.cedarfair.michigansadventure',
        appName: 'Michigan\'s Adventure',
        ...options?.config,
      },
    });
  }
}

/**
 * Valleyfair - Shakopee, Minnesota
 * Park ID: 14
 * Note: Uses custom config path
 */
@destinationController({category: ['Cedar Fair', 'Valleyfair']})
export class Valleyfair extends AttractionsIOV3 {
  constructor(options?: DestinationConstructor) {
    super({
      ...options,
      config: {
        timezone: 'America/Chicago',
        parkId: '14',
        destinationId: 'valleyfair',
        configPath: 'v2/config/park/vf',
        appId: 'com.cedarfair.valleyfair',
        appName: 'Valleyfair',
        ...options?.config,
      },
    });
  }
}

/**
 * Kings Island - Mason, Ohio
 * Park ID: 20
 */
@destinationController({category: ['Cedar Fair', 'Kings Island']})
export class KingsIsland extends AttractionsIOV3 {
  constructor(options?: DestinationConstructor) {
    super({
      ...options,
      config: {
        timezone: 'America/New_York',
        parkId: '20',
        destinationId: 'kingsisland',
        appId: 'com.cedarfair.kingsisland',
        appName: 'Kings Island',
        ...options?.config,
      },
    });
  }
}

/**
 * Kings Dominion - Doswell, Virginia
 * Park ID: 25
 * Note: Uses custom config path
 */
@destinationController({category: ['Cedar Fair', 'Kings Dominion']})
export class KingsDominion extends AttractionsIOV3 {
  constructor(options?: DestinationConstructor) {
    super({
      ...options,
      config: {
        timezone: 'America/New_York',
        parkId: '25',
        destinationId: 'kingsdominion',
        configPath: 'v2/config/park/kd',
        appId: 'com.cedarfair.kingsdominion',
        appName: 'Kings Dominion',
        ...options?.config,
      },
    });
  }
}

/**
 * Carowinds - Charlotte, North Carolina
 * Park ID: 30
 */
@destinationController({category: ['Cedar Fair', 'Carowinds']})
export class Carowinds extends AttractionsIOV3 {
  constructor(options?: DestinationConstructor) {
    super({
      ...options,
      config: {
        timezone: 'America/New_York',
        parkId: '30',
        destinationId: 'carowinds',
        appId: 'com.cedarfair.carowinds',
        appName: 'Carowinds',
        ...options?.config,
      },
    });
  }
}

/**
 * California's Great America - Santa Clara, California
 * Park ID: 35
 */
@destinationController({category: ['Cedar Fair', 'California\'s Great America']})
export class CaliforniasGreatAmerica extends AttractionsIOV3 {
  constructor(options?: DestinationConstructor) {
    super({
      ...options,
      config: {
        timezone: 'America/Los_Angeles',
        parkId: '35',
        destinationId: 'californiasgreatamerica',
        appId: 'com.cedarfair.cga',
        appName: 'California\'s Great America',
        ...options?.config,
      },
    });
  }
}

/**
 * Canada's Wonderland - Vaughan, Ontario
 * Park ID: 40
 */
@destinationController({category: ['Cedar Fair', 'Canada\'s Wonderland']})
export class CanadasWonderland extends AttractionsIOV3 {
  constructor(options?: DestinationConstructor) {
    super({
      ...options,
      config: {
        timezone: 'America/Toronto',
        parkId: '40',
        destinationId: 'canadaswonderland',
        appId: 'com.cedarfair.canadaswonderland',
        appName: 'Canada\'s Wonderland',
        ...options?.config,
      },
    });
  }
}

export {AttractionsIOV3};

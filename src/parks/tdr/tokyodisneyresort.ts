import {Destination, DestinationConstructor} from '../../destination.js';
import {cache, CacheLib} from '../../cache.js';
import {http, HTTPObj} from '../../http.js';
import {inject} from '../../injector.js';
import config from '../../config.js';
import {destinationController} from '../../destinationRegistry.js';
import {Entity, LiveData, EntitySchedule} from '@themeparks/typelib';
import {TagBuilder} from '../../tags/index.js';

// ============================================================================
// Constants
// ============================================================================

/** Static park data for the two parks in Tokyo Disney Resort */
const PARK_DATA: Record<string, {name: string; lat: number; lng: number}> = {
  tdl: {name: 'Tokyo Disneyland', lat: 35.632896, lng: 139.880394},
  tds: {name: 'Tokyo DisneySea', lat: 35.626411, lng: 139.885099},
};

// ============================================================================
// Types
// ============================================================================

type TDRFacility = {
  facilityCode: string;
  facilityType: string;
  name: string;
  nameKana?: string;
  parkType: string; // "TDL" or "TDS"
  dummyFacility: boolean;
  photoMapFlg: boolean;
  fastpass: boolean;
  filters: (string | {type: string})[];
  restrictions: {type: string; name: string}[];
  latitude?: number;
  longitude?: number;
};

type TDRAttractionCondition = {
  facilityCode: string;
  facilityStatus?: string;
  standbyTime?: number;
  premierAccessStatus?: string;
  priorityPassStatus?: string;
};

type TDRCalendarEntry = {
  parkType: string;
  date: string;
  closedDay: boolean;
  undecided: boolean;
  openTime: string;
  closeTime: string;
  spOpenTime?: string;
  spCloseTime?: string;
};

type TDRConditionsResponse = {
  attractions: TDRAttractionCondition[];
  restaurants?: any[];
};

type TDRFacilitiesResponse = {
  attractions: TDRFacility[];
  entertainments: TDRFacility[];
  restaurants: TDRFacility[];
  [key: string]: TDRFacility[];
};

// ============================================================================
// Destination Implementation
// ============================================================================

@destinationController({category: 'Disney'})
export class TokyoDisneyResort extends Destination {
  @config
  apiBase: string = '';

  @config
  apiKey: string = '';

  @config
  apiAuth: string = '';

  @config
  apiOS: string = '';

  @config
  apiVersion: string = '';

  @config
  fallbackDeviceId: string = '';

  @config
  timezone: string = 'Asia/Tokyo';

  constructor(options?: DestinationConstructor) {
    super(options);
    this.addConfigPrefix('TDR');
  }

  // ===== Header Injection =====

  /**
   * Inject standard headers for all TDR API requests.
   * Device ID and auth headers are added for all requests except device registration.
   */
  @inject({
    eventName: 'httpRequest',
    hostname: function () {
      if (!this.apiBase) return '__noop__';
      return new URL(this.apiBase).hostname;
    },
    tags: {$nin: ['deviceRegistration']},
  })
  async injectAPIHeaders(requestObj: HTTPObj): Promise<void> {
    const appVersion = await this.getAppVersion();
    const deviceId = await this.getDeviceId();

    requestObj.headers = {
      ...requestObj.headers,
      'user-agent': `TokyoDisneyResortApp/${appVersion} Android/${this.apiOS}`,
      'x-api-key': this.apiKey,
      'X-PORTAL-LANGUAGE': 'en-US',
      'X-PORTAL-OS-VERSION': `Android ${this.apiOS}`,
      'X-PORTAL-APP-VERSION': appVersion,
      'X-PORTAL-DEVICE-NAME': 'OnePlus5',
      'X-PORTAL-DEVICE-ID': deviceId,
      'X-PORTAL-AUTH': this.apiAuth,
      'connection': 'keep-alive',
      'accept': 'application/json',
      'content-type': 'application/json',
    };
  }

  /**
   * Inject headers for device registration requests (no device ID or auth).
   */
  @inject({
    eventName: 'httpRequest',
    hostname: function () {
      if (!this.apiBase) return '__noop__';
      return new URL(this.apiBase).hostname;
    },
    tags: {$in: ['deviceRegistration']},
  })
  async injectDeviceRegistrationHeaders(requestObj: HTTPObj): Promise<void> {
    const appVersion = await this.getAppVersion();

    requestObj.headers = {
      ...requestObj.headers,
      'user-agent': `TokyoDisneyResortApp/${appVersion} Android/${this.apiOS}`,
      'x-api-key': this.apiKey,
      'X-PORTAL-LANGUAGE': 'en-US',
      'X-PORTAL-OS-VERSION': `Android ${this.apiOS}`,
      'X-PORTAL-APP-VERSION': appVersion,
      'X-PORTAL-DEVICE-NAME': 'OnePlus5',
      'connection': 'keep-alive',
      'accept': 'application/json',
      'content-type': 'application/json',
    };
  }

  /**
   * Handle HTTP error responses from TDR API.
   * - 400: clear cached app version (API version enforcement)
   * - 503 with systemMaintenance: log and handle gracefully
   */
  @inject({
    eventName: 'httpResponse',
    hostname: function () {
      if (!this.apiBase) return '__noop__';
      return new URL(this.apiBase).hostname;
    },
  })
  async handleAPIResponse(requestObj: HTTPObj): Promise<void> {
    if (requestObj.status === 400) {
      console.log('[TDR] API returned 400, clearing cached app version...');
      CacheLib.delete('TokyoDisneyResort:getAppVersion:[]');
    }

    if (requestObj.status === 503) {
      try {
        const body = await requestObj.clone().json();
        const maintenance = body?.errors?.find((x: any) => x.code === 'error.systemMaintenance');
        if (maintenance) {
          console.log(`[TDR] API in system maintenance: ${JSON.stringify(maintenance)}`);
        }
      } catch {
        // could not parse response body
      }
    }
  }

  // ===== HTTP Fetch Methods =====

  /**
   * Fetch the latest app version from appwatch API
   */
  @http({cacheSeconds: 60 * 60 * 12})
  async fetchAppVersion(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: 'https://api.themeparks.wiki/appwatch/latest/jp.tokyodisneyresort.portalapp',
      options: {json: true},
    } as HTTPObj;
  }

  /**
   * Get the current app version (cached 12h, falls back to apiVersion config)
   */
  @cache({ttlSeconds: 60 * 60 * 12})
  async getAppVersion(): Promise<string> {
    try {
      const resp = await this.fetchAppVersion();
      const data = await resp.json();
      return data?.version || this.apiVersion || '3.0.16';
    } catch {
      return this.apiVersion || '3.0.16';
    }
  }

  /**
   * Register a device with the TDR API
   */
  @http({cacheSeconds: 60 * 60 * 24 * 14})
  async fetchDeviceId(): Promise<HTTPObj> {
    return {
      method: 'POST',
      url: `${this.apiBase}/rest/v1/devices`,
      options: {json: true},
      tags: ['deviceRegistration'],
    } as HTTPObj;
  }

  /**
   * Get a device ID (cached 2 weeks, falls back to fallbackDeviceId)
   */
  @cache({ttlSeconds: 60 * 60 * 24 * 14})
  async getDeviceId(): Promise<string> {
    try {
      const resp = await this.fetchDeviceId();
      const data = await resp.json();
      if (data?.deviceId) {
        return data.deviceId;
      }
    } catch (e) {
      console.error(`[TDR] Failed to register device: ${e}`);
    }

    if (this.fallbackDeviceId) {
      console.log(`[TDR] Using fallback device ID: ${this.fallbackDeviceId}`);
      return this.fallbackDeviceId;
    }

    throw new Error('[TDR] Failed to register device and no fallback device ID configured');
  }

  /**
   * Fetch all facilities data (attractions, entertainments, restaurants)
   */
  @http({cacheSeconds: 60 * 60 * 20})
  async fetchFacilities(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.apiBase}/rest/v4/facilities`,
      options: {json: true},
    } as HTTPObj;
  }

  /**
   * Get all facilities, flattened into an array with facilityType tag (cached 20h)
   */
  @cache({ttlSeconds: 60 * 60 * 20})
  async getFacilities(): Promise<TDRFacility[]> {
    const resp = await this.fetchFacilities();
    const data: TDRFacilitiesResponse = await resp.json();

    // Flatten into array with facilityType field
    const facilities: TDRFacility[] = [];
    for (const [facilityType, items] of Object.entries(data)) {
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        facilities.push({
          ...item,
          facilityType,
        });
      }
    }

    return facilities;
  }

  /**
   * Fetch live conditions (wait times + statuses)
   */
  @http({cacheSeconds: 60})
  async fetchConditions(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.apiBase}/rest/v6/facilities/conditions`,
      options: {json: true},
    } as HTTPObj;
  }

  /**
   * Get live conditions (cached 1min)
   */
  @cache({ttlSeconds: 60})
  async getConditions(): Promise<TDRConditionsResponse> {
    const resp = await this.fetchConditions();
    const data = await resp.json();
    return data || {attractions: []};
  }

  /**
   * Fetch park calendar data
   */
  @http({cacheSeconds: 60 * 60 * 12})
  async fetchCalendar(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.apiBase}/rest/v1/parks/calendars`,
      options: {json: true},
    } as HTTPObj;
  }

  /**
   * Get calendar data (cached 12h)
   */
  @cache({ttlSeconds: 60 * 60 * 12})
  async getCalendar(): Promise<TDRCalendarEntry[]> {
    const resp = await this.fetchCalendar();
    const data = await resp.json();
    return Array.isArray(data) ? data : [];
  }

  // ===== Helper Methods =====

  /**
   * Get the UTC offset string for Asia/Tokyo.
   * Japan Standard Time is always +09:00 (no DST).
   */
  private getTokyoOffset(): string {
    return '+09:00';
  }

  /**
   * Parse a height string like "107 cm" or "102cm" into centimeters.
   */
  private parseHeightCm(heightStr: string): number | undefined {
    const match = /(\d+)\s*cm/.exec(heightStr);
    if (!match) return undefined;
    return Number(match[1]);
  }

  /**
   * Check if a facility filter array contains a given filter type.
   * Filters can be strings or objects with a type property.
   */
  private hasFilter(filters: (string | {type: string})[], filterType: string): boolean {
    return filters.some((f) => {
      if (typeof f === 'string') return f === filterType;
      return f.type === filterType;
    });
  }

  /**
   * Map TDR facility status to our standard status
   */
  private mapStatus(condition: TDRAttractionCondition): string {
    switch (condition.facilityStatus) {
      case 'OPEN':
        return 'OPERATING';
      case 'CANCEL':
        return 'CLOSED';
      case 'CLOSE_NOTICE':
        return 'DOWN';
      default:
        // If there's a standby time, it's operating; otherwise closed
        if (condition.standbyTime != null && condition.standbyTime > 0) {
          return 'OPERATING';
        }
        return 'CLOSED';
    }
  }

  // ===== Data Builder Methods =====

  async getDestinations(): Promise<Entity[]> {
    return [
      {
        id: 'tdr',
        name: 'Tokyo Disney Resort',
        entityType: 'DESTINATION',
        timezone: this.timezone,
        location: {latitude: 35.632896, longitude: 139.880394},
      } as Entity,
    ];
  }

  protected async buildEntityList(): Promise<Entity[]> {
    const facilities = await this.getFacilities();
    const destinationId = 'tdr';

    // Build park entities from static data
    const parkEntities: Entity[] = Object.entries(PARK_DATA).map(([parkId, data]) => ({
      id: parkId,
      name: data.name,
      entityType: 'PARK',
      parentId: destinationId,
      destinationId,
      timezone: this.timezone,
      location: {latitude: data.lat, longitude: data.lng},
    } as Entity));

    // Filter and build attraction entities
    const attractions = facilities.filter((f) => {
      return (
        f.facilityType === 'attractions' &&
        !f.dummyFacility &&
        (!f.photoMapFlg || this.hasFilter(f.filters || [], 'THRILL') || !!f.fastpass)
      );
    });

    const attractionEntities = this.mapEntities(attractions, {
      idField: 'facilityCode',
      nameField: 'name',
      entityType: 'ATTRACTION',
      parentIdField: (item) => item.parkType.toLowerCase(),
      destinationId,
      timezone: this.timezone,
      locationFields: {
        lat: 'latitude',
        lng: 'longitude',
      },
      transform: (entity, facility) => {
        const tags: any[] = [];

        // Paid return time (Premier Access / formerly FastPass)
        if (facility.fastpass) {
          tags.push(TagBuilder.paidReturnTime());
        }

        // Single rider
        if (this.hasFilter(facility.filters || [], 'SINGLE_RIDER')) {
          tags.push(TagBuilder.singleRider());
        }

        // Minimum height restriction
        const lowerHeight = facility.restrictions?.find((r) => r.type === 'LOWER_HEIGHT');
        if (lowerHeight) {
          const heightCm = this.parseHeightCm(lowerHeight.name);
          if (heightCm && heightCm > 0) {
            tags.push(TagBuilder.minimumHeight(heightCm, 'cm'));
          }
        }

        // Maximum height restriction
        const upperHeight = facility.restrictions?.find((r) => r.type === 'UPPER_HEIGHT');
        if (upperHeight) {
          const heightCm = this.parseHeightCm(upperHeight.name);
          if (heightCm && heightCm > 0) {
            tags.push(TagBuilder.maximumHeight(heightCm, 'cm'));
          }
        }

        // Unsuitable for pregnant people
        if (this.hasFilter(facility.filters || [], 'EXPECTANT_MOTHER')) {
          tags.push(TagBuilder.unsuitableForPregnantPeople());
        }

        // Location
        if (facility.latitude && facility.longitude) {
          tags.push(TagBuilder.location(Number(facility.latitude), Number(facility.longitude), entity.name as string));
        }

        entity.tags = tags.filter(Boolean);
        return entity;
      },
    });

    // Filter and build show entities
    const shows = facilities.filter((f) => {
      return f.facilityType === 'entertainments' && !f.dummyFacility && !f.photoMapFlg;
    });

    const showEntities = this.mapEntities(shows, {
      idField: 'facilityCode',
      nameField: 'name',
      entityType: 'SHOW',
      parentIdField: (item) => item.parkType.toLowerCase(),
      destinationId,
      timezone: this.timezone,
      locationFields: {
        lat: 'latitude',
        lng: 'longitude',
      },
      transform: (entity, facility) => {
        const tags: any[] = [];

        if (facility.latitude && facility.longitude) {
          tags.push(TagBuilder.location(Number(facility.latitude), Number(facility.longitude), entity.name as string));
        }

        entity.tags = tags.filter(Boolean);
        return entity;
      },
    });

    // Restaurants: return empty array (not surfaced)

    return [
      ...await this.getDestinations(),
      ...parkEntities,
      ...attractionEntities,
      ...showEntities,
    ];
  }

  protected async buildLiveData(): Promise<LiveData[]> {
    const conditions = await this.getConditions();
    const liveData: LiveData[] = [];

    if (!conditions?.attractions) {
      return liveData;
    }

    for (const attr of conditions.attractions) {
      if (!attr.facilityCode) continue;

      const status = this.mapStatus(attr);
      const ld: LiveData = {
        id: String(attr.facilityCode),
        status,
      } as LiveData;

      // Standby queue
      ld.queue = {
        STANDBY: {
          waitTime: status === 'OPERATING' ? (attr.standbyTime ?? undefined) : undefined,
        },
      };

      // Premier Access (paid return time)
      if (attr.premierAccessStatus) {
        ld.queue!.PAID_RETURN_TIME = this.buildPaidReturnTimeQueue(
          attr.premierAccessStatus === 'SELLING' ? 'AVAILABLE' : 'FINISHED',
          null,
          null,
          'JPY',
          null,
        );
      }

      // Priority Pass (free return time)
      if (attr.priorityPassStatus) {
        ld.queue!.RETURN_TIME = this.buildReturnTimeQueue(
          attr.priorityPassStatus === 'TICKETING' ? 'AVAILABLE' : 'FINISHED',
          null,
          null,
        );
      }

      liveData.push(ld);
    }

    return liveData;
  }

  protected async buildSchedules(): Promise<EntitySchedule[]> {
    const calendar = await this.getCalendar();
    const offset = this.getTokyoOffset();

    // Initialize schedule map for both parks
    const scheduleMap = new Map<string, any[]>();
    scheduleMap.set('tdl', []);
    scheduleMap.set('tds', []);

    for (const entry of calendar) {
      // Skip closed or undecided days
      if (entry.closedDay || entry.undecided) continue;

      const parkId = entry.parkType.toLowerCase();
      if (!scheduleMap.has(parkId)) continue;

      const dateStr = entry.date; // Already in YYYY-MM-DD format

      // Operating hours
      if (entry.openTime && entry.closeTime) {
        scheduleMap.get(parkId)!.push({
          date: dateStr,
          openingTime: `${dateStr}T${entry.openTime}:00${offset}`,
          closingTime: `${dateStr}T${entry.closeTime}:00${offset}`,
          type: 'OPERATING',
        });
      }

      // Special hours (Extra Hours)
      if (entry.spOpenTime && entry.spCloseTime) {
        scheduleMap.get(parkId)!.push({
          date: dateStr,
          openingTime: `${dateStr}T${entry.spOpenTime}:00${offset}`,
          closingTime: `${dateStr}T${entry.spCloseTime}:00${offset}`,
          type: 'EXTRA_HOURS',
          description: 'Special Hours',
        });
      }
    }

    // Convert to EntitySchedule array
    const schedules: EntitySchedule[] = [];
    for (const [parkId, schedule] of scheduleMap) {
      if (schedule.length > 0) {
        schedules.push({id: parkId, schedule} as EntitySchedule);
      }
    }

    return schedules;
  }
}

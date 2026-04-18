import {Destination, DestinationConstructor} from '../../destination.js';
import {cache} from '../../cache.js';
import {http, HTTPObj} from '../../http.js';
import {inject} from '../../injector.js';
import config from '../../config.js';
import {destinationController} from '../../destinationRegistry.js';
import {Entity, LiveData, EntitySchedule} from '@themeparks/typelib';
import {TagBuilder} from '../../tags/index.js';
import {formatInTimezone, addDays, constructDateTime} from '../../datetime.js';

// ============================================================================
// Constants
// ============================================================================

/** Destination ID used across all entities */
const DESTINATION_ID = 'shanghaidisneyresort';

// ============================================================================
// Types
// ============================================================================

type SHDRFacility = {
  id: string;
  name: string;
  type: string;
  cacheId?: string;
  ancestors?: Array<{id: string; type: string}>;
  relatedLocations?: Array<{
    id: string;
    type: string;
    name?: string;
    coordinates?: Array<{
      latitude: string;
      longitude: string;
      type?: string;
    }>;
  }>;
  facets?: Array<{
    id: string;
    group: string;
    name?: string;
  }>;
  policies?: Array<{
    id: string;
    descriptions?: Array<{text: string}>;
  }>;
  fastPass?: string;
  webLink?: string;
};

type SHDRVersionResponse = {
  data?: {
    facility?: {
      added?: SHDRFacility[];
      updated?: SHDRFacility[];
      removed?: string[];
    };
  };
};

type SHDRWaitTimeEntry = {
  id: string;
  waitTime?: {
    status?: string;
    postedWaitMinutes?: number;
    singleRider?: boolean;
    fastPass?: {
      available?: boolean;
    };
  };
};

type SHDRWaitTimesResponse = {
  entries?: SHDRWaitTimeEntry[];
};

type SHDRScheduleActivity = {
  id: string;
  schedule?: {
    schedules?: Array<{
      type: string;
      date: string;
      startTime: string;
      endTime: string;
    }>;
  };
};

type SHDRScheduleResponse = {
  activities?: SHDRScheduleActivity[];
};

// ============================================================================
// Destination Implementation
// ============================================================================

@destinationController({category: 'Disney'})
export class ShanghaiDisneylandResort extends Destination {
  @config
  apiBase: string = '';

  @config
  timezone: string = 'Asia/Shanghai';

  constructor(options?: DestinationConstructor) {
    super(options);
    this.addConfigPrefix('SHDR');
  }

  // ===== Header Injection =====

  /**
   * Inject standard headers for all SHDR API requests.
   */
  @inject({
    eventName: 'httpRequest',
    hostname: function () {
      if (!this.apiBase) return '__noop__';
      return new URL(this.apiBase).hostname;
    },
  })
  async injectAPIHeaders(requestObj: HTTPObj): Promise<void> {
    requestObj.headers = {
      ...requestObj.headers,
      'Accept-Language': 'en',
      'Accept': 'application/json',
      'App-Version': '13.5.0',
      'Content-Type': 'application/json',
      'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 16; FP4 Build/BP4A.251205.006)',
    };
  }

  // ===== HTTP Fetch Methods =====

  /**
   * Fetch facility data via version compare endpoint
   */
  @http({cacheSeconds: 43200})
  async fetchFacilities(): Promise<HTTPObj> {
    return {
      method: 'POST',
      url: `${this.apiBase}resource-assembler-platform/v1/version/compare`,
      body: {
        facility: {versionId: 0},
        version: '10.3',
      },
      options: {json: true},
    } as any as HTTPObj;
  }

  /**
   * Get all facilities (cached 12h)
   */
  @cache({ttlSeconds: 43200})
  async getFacilities(): Promise<SHDRFacility[]> {
    const resp = await this.fetchFacilities();
    const data: SHDRVersionResponse = await resp.json();
    return data?.data?.facility?.added || [];
  }

  /**
   * Fetch live wait times
   */
  @http({cacheSeconds: 60})
  async fetchWaitTimes(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.apiBase}resource-assembler-platform/public/wait-times/shdr;entityType=destination?region=cn`,
      options: {json: true},
    } as any as HTTPObj;
  }

  /**
   * Get wait times (cached 1min)
   */
  @cache({ttlSeconds: 60})
  async getWaitTimes(): Promise<SHDRWaitTimeEntry[]> {
    const resp = await this.fetchWaitTimes();
    const data: SHDRWaitTimesResponse = await resp.json();
    return data?.entries || [];
  }

  /**
   * Fetch schedule data
   */
  @http({cacheSeconds: 43200})
  async fetchSchedules(): Promise<HTTPObj> {
    const now = new Date();
    const startDate = formatInTimezone(now, this.timezone, 'date');
    const endDate = formatInTimezone(addDays(now, 60), this.timezone, 'date');
    // formatInTimezone 'date' returns MM/DD/YYYY, convert to YYYY-MM-DD
    const [smm, sdd, syyyy] = startDate.split('/');
    const [emm, edd, eyyyy] = endDate.split('/');
    const start = `${syyyy}-${smm}-${sdd}`;
    const end = `${eyyyy}-${emm}-${edd}`;

    return {
      method: 'GET',
      url: `${this.apiBase}resource-assembler-platform/public/ancestor-activities-schedules/shdr;entityType=destination?filters=theme-park,Attraction,Entertainment&startDate=${start}&endDate=${end}&region=cn`,
      options: {json: true},
    } as any as HTTPObj;
  }

  /**
   * Get schedule activities (cached 12h)
   */
  @cache({ttlSeconds: 43200})
  async getScheduleActivities(): Promise<SHDRScheduleActivity[]> {
    const resp = await this.fetchSchedules();
    const data: SHDRScheduleResponse = await resp.json();
    return data?.activities || [];
  }

  // ===== Helper Methods =====

  /**
   * Extract the clean entity ID from a semicolon-delimited SHDR ID string.
   * Strips the cacheId segment if present.
   * e.g. "attName;entityType=Attraction;destination=shdr;cacheId=-123" -> "attName;entityType=Attraction;destination=shdr"
   */
  private cleanEntityId(rawId: string): string {
    return rawId.replace(/;cacheId=[^;]*/g, '');
  }

  /**
   * Get the primary location coordinates from an entity's relatedLocations.
   */
  private getPrimaryLocation(facility: SHDRFacility): {lat: number; lng: number} | undefined {
    if (!facility.relatedLocations) return undefined;

    const primaryLoc = facility.relatedLocations.find(
      (loc) => loc.type === 'primaryLocation' && loc.coordinates && loc.coordinates.length > 0,
    );

    if (!primaryLoc) return undefined;

    const coord = primaryLoc.coordinates![0];
    const lat = Number(coord.latitude);
    const lng = Number(coord.longitude);

    if (isNaN(lat) || isNaN(lng)) return undefined;
    return {lat, lng};
  }

  /**
   * Get the parent park ID from an entity's ancestors array.
   * Returns the full semicolon-delimited ID of the theme-park ancestor.
   */
  private getParentParkId(facility: SHDRFacility): string | undefined {
    if (!facility.ancestors) return undefined;

    const park = facility.ancestors.find((a) => a.type === 'theme-park');
    return park?.id;
  }

  /**
   * Parse a height facet ID to extract centimeters.
   * Format: "(\d+)cm-\d+in-or-taller"
   */
  private parseHeightCm(facetId: string): number | undefined {
    const match = /(\d+)cm/.exec(facetId);
    if (!match) return undefined;
    return Number(match[1]);
  }

  /**
   * Check if this is a non-ride attraction (merchandise, priority entrances,
   * disability services, land entrances/exits, standby-pass-only items).
   * SHDR tags all of these as type=Attraction with no distinguishing metadata,
   * so we filter by name patterns.
   */
  private isNonRideAttraction(name: string): boolean {
    const lower = name.toLowerCase();
    return (
      lower.includes('merchandise') ||
      lower.includes('purchase chance') ||
      lower.includes('purchase voucher') ||
      lower.includes('themed bucket') ||
      lower.includes('tumbler') ||
      lower.includes('priority entrance') ||
      lower.includes('premier admission') ||
      lower.includes('early park entry') ||
      lower.includes('disability access') ||
      lower.includes('standby pass required') ||
      /\b(entrance|exit)\s*(\(|$)/i.test(name)
    );
  }

  /**
   * Check if this is a duplicate show variant (DSP, DPA, or reserved viewing
   * entry for the same underlying show).
   */
  private isDuplicateShowVariant(name: string): boolean {
    const lower = name.toLowerCase();
    return (
      lower.includes('standby pass required') ||
      lower.includes('disney premier access') ||
      lower.includes('reserved viewing') ||
      / - (east|west) entrance$/i.test(name) ||
      / - close to /i.test(name)
    );
  }

  /**
   * Map SHDR wait time status to our standard status
   */
  private mapStatus(status?: string): string {
    switch (status) {
      case 'Operating':
        return 'OPERATING';
      case 'Closed':
        return 'CLOSED';
      case 'Down':
        return 'DOWN';
      case 'Renewal':
        return 'REFURBISHMENT';
      default:
        return 'OPERATING';
    }
  }

  // ===== Data Builder Methods =====

  async getDestinations(): Promise<Entity[]> {
    return [
      {
        id: DESTINATION_ID,
        name: 'Shanghai Disney Resort',
        entityType: 'DESTINATION',
        timezone: this.timezone,
        location: {latitude: 31.143040, longitude: 121.658369},
      } as Entity,
    ];
  }

  protected async buildEntityList(): Promise<Entity[]> {
    const facilities = await this.getFacilities();

    // Build a map of entity name -> facility for standby pass parent resolution
    const standbyPassMap = new Map<string, SHDRFacility>();

    // First pass: identify standby pass entities and store references
    for (const facility of facilities) {
      if (this.isNonRideAttraction(facility.name) && facility.name.toLowerCase().includes('standby pass')) {
        standbyPassMap.set(this.cleanEntityId(facility.id), facility);
      }
    }

    // Find park entities
    const parks = facilities.filter((f) => f.type === 'theme-park');

    const parkEntities = this.mapEntities(parks, {
      idField: (item) => this.cleanEntityId(item.id),
      nameField: 'name',
      entityType: 'PARK',
      parentIdField: () => DESTINATION_ID,
      destinationId: DESTINATION_ID,
      timezone: this.timezone,
      locationFields: {
        lat: (item) => this.getPrimaryLocation(item)?.lat,
        lng: (item) => this.getPrimaryLocation(item)?.lng,
      },
    });

    // Build attraction entities (type === 'Attraction', excluding non-ride items)
    const attractions = facilities.filter((f) => {
      return f.type === 'Attraction' && !this.isNonRideAttraction(f.name);
    });

    const attractionEntities = this.mapEntities(attractions, {
      idField: (item) => this.cleanEntityId(item.id),
      nameField: 'name',
      entityType: 'ATTRACTION',
      parentIdField: (item) => {
        const parkId = this.getParentParkId(item);
        return parkId || DESTINATION_ID;
      },
      destinationId: DESTINATION_ID,
      timezone: this.timezone,
      locationFields: {
        lat: (item) => this.getPrimaryLocation(item)?.lat,
        lng: (item) => this.getPrimaryLocation(item)?.lng,
      },
      transform: (entity, facility) => {
        const tags: any[] = [];

        // Height restriction from facets
        if (facility.facets) {
          const heightFacet = facility.facets.find((f) => f.group === 'height');
          if (heightFacet) {
            const heightCm = this.parseHeightCm(heightFacet.id);
            if (heightCm && heightCm > 0) {
              tags.push(TagBuilder.minimumHeight(heightCm, 'cm'));
            }
          }
        }

        // Unsuitable for pregnant people from facets
        if (facility.facets) {
          const hasExpectantMother = facility.facets.some(
            (f) => f.id && f.id.indexOf('expectant-mother') >= 0,
          );
          if (hasExpectantMother) {
            tags.push(TagBuilder.unsuitableForPregnantPeople());
          }
        }

        entity.tags = tags.filter(Boolean);
        return entity;
      },
    });

    // Build show entities (type === 'Entertainment', excluding DSP/DPA duplicates)
    const shows = facilities.filter((f) => {
      return f.type === 'Entertainment' && !this.isDuplicateShowVariant(f.name);
    });

    const showEntities = this.mapEntities(shows, {
      idField: (item) => this.cleanEntityId(item.id),
      nameField: 'name',
      entityType: 'SHOW',
      parentIdField: (item) => {
        const parkId = this.getParentParkId(item);
        return parkId || DESTINATION_ID;
      },
      destinationId: DESTINATION_ID,
      timezone: this.timezone,
      locationFields: {
        lat: (item) => this.getPrimaryLocation(item)?.lat,
        lng: (item) => this.getPrimaryLocation(item)?.lng,
      },
    });

    // Restaurants: empty array (match JS implementation)

    return [
      ...await this.getDestinations(),
      ...parkEntities,
      ...attractionEntities,
      ...showEntities,
    ];
  }

  protected async buildLiveData(): Promise<LiveData[]> {
    const waitTimes = await this.getWaitTimes();
    const facilities = await this.getFacilities();
    const liveData: LiveData[] = [];
    const liveDataMap = new Map<string, LiveData>();

    const getOrCreate = (id: string): LiveData => {
      let entry = liveDataMap.get(id);
      if (!entry) {
        entry = {id, status: 'CLOSED'} as LiveData;
        liveDataMap.set(id, entry);
        liveData.push(entry);
      }
      return entry;
    };

    // Build a map: standby pass entity name prefix -> parent attraction clean ID
    // "Buzz Lightyear Planet Rescue (Standby Pass Required)" maps to "attBuzzLightyearPlanetRescue"
    const standbyPassToParent = new Map<string, string>();
    const standbyPassIds = new Set<string>();

    for (const facility of facilities) {
      if (facility.name.toLowerCase().includes('standby pass required')) {
        const standbyCleanId = this.cleanEntityId(facility.id);
        standbyPassIds.add(standbyCleanId);

        // Find the parent attraction by stripping the standby suffix from the name
        const originalName = facility.name
          .replace(/\s*\(Disney Standby Pass Required\)\s*/i, '')
          .replace(/\s*\(Standby Pass Required\)\s*/i, '')
          .trim();
        const parentFacility = facilities.find(
          (f) => f.type === 'Attraction' && f.name === originalName && !this.isNonRideAttraction(f.name),
        );

        if (parentFacility) {
          standbyPassToParent.set(standbyCleanId, this.cleanEntityId(parentFacility.id));
        }
      }
    }

    for (const entry of waitTimes) {
      if (!entry.id) continue;

      const cleanId = this.cleanEntityId(entry.id);

      // Check if this is a standby pass entity
      if (standbyPassIds.has(cleanId)) {
        // Find the parent attraction and add RETURN_TIME queue to it
        const parentId = standbyPassToParent.get(cleanId);
        if (parentId) {
          const parentLd = getOrCreate(parentId);
          if (!parentLd.queue) parentLd.queue = {};

          const parentStatus = parentLd.status;
          parentLd.queue.RETURN_TIME = this.buildReturnTimeQueue(
            parentStatus === 'OPERATING' ? 'AVAILABLE' : 'FINISHED',
            null,
            null,
          );
        }
        continue;
      }

      const status = this.mapStatus(entry.waitTime?.status);
      const ld = getOrCreate(cleanId);
      ld.status = status as any;

      // Standby queue
      if (!ld.queue) ld.queue = {};
      ld.queue.STANDBY = {
        waitTime: entry.waitTime?.postedWaitMinutes !== undefined
          ? entry.waitTime.postedWaitMinutes
          : undefined,
      };

      // Single rider queue
      if (entry.waitTime?.singleRider === true) {
        ld.queue.SINGLE_RIDER = {
          waitTime: null,
        };
      }
    }

    return liveData;
  }

  protected async buildSchedules(): Promise<EntitySchedule[]> {
    const activities = await this.getScheduleActivities();
    const scheduleMap = new Map<string, any[]>();

    for (const activity of activities) {
      if (!activity.schedule?.schedules) continue;

      const cleanId = this.cleanEntityId(activity.id);

      for (const sched of activity.schedule.schedules) {
        if (sched.type !== 'Operating') continue;

        const dateStr = sched.date;
        const openingTime = constructDateTime(dateStr, sched.startTime, this.timezone);
        const closingTime = constructDateTime(dateStr, sched.endTime, this.timezone);

        if (!scheduleMap.has(cleanId)) {
          scheduleMap.set(cleanId, []);
        }

        scheduleMap.get(cleanId)!.push({
          date: dateStr,
          openingTime,
          closingTime,
          type: 'OPERATING',
        });
      }
    }

    const schedules: EntitySchedule[] = [];
    for (const [id, schedule] of scheduleMap) {
      if (schedule.length > 0) {
        schedules.push({id, schedule} as EntitySchedule);
      }
    }

    return schedules;
  }
}

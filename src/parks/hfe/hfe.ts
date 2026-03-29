/**
 * Herschend Family Entertainment (HFE) Theme Parks
 *
 * Shared base class for parks using the HFE Corp API:
 * - Dollywood (Pigeon Forge, TN)
 * - Silver Dollar City (Branson, MO)
 * - Kennywood (West Mifflin, PA)
 *
 * Supports entity data (attractions, restaurants), live wait times, and
 * park operating schedules.
 *
 * @module hfe
 */

import {Destination, type DestinationConstructor} from '../../destination.js';
import config from '../../config.js';
import {http, type HTTPObj} from '../../http.js';
import {cache} from '../../cache.js';
import {inject} from '../../injector.js';
import {destinationController} from '../../destinationRegistry.js';
import type {Entity, LiveData, EntitySchedule} from '@themeparks/typelib';
import {formatInTimezone, addDays, constructDateTime} from '../../datetime.js';
import {TagBuilder} from '../../tags/index.js';

// ============================================================================
// API Response Types
// ============================================================================

/** Activity from the HFE Corp activities endpoint */
type HFEActivity = {
  id: string;
  title: string;
  activityCategories: string[];
  latitudeForDirections?: string | number;
  longitudeForDirections?: string | number;
  type?: string[];
  heightRequirement?: string | number | null;
  rideWaitTimeRideId?: string | number | null;
};

/** Activities API response */
type HFEActivitiesResponse = {
  activities: HFEActivity[];
};

/** Single day schedule from HFE Corp */
type HFEScheduleDay = {
  date: string;
  parkHours: Array<{
    from: string;
    to: string;
    closedToPublic?: boolean;
    isAllDay?: boolean;
    cmsKey?: string;
  }>;
  activities: unknown[];
};

/** Wait time entry from the Pulse API */
type HFEWaitTime = {
  rideId: number | null;
  rideName: string;
  operationStatus: string;
  waitTime: number | null;
  waitTimeDisplay: string;
};

// ============================================================================
// HFE Base Class (not registered as a destination)
// ============================================================================

/**
 * Shared base class for Herschend Family Entertainment parks.
 * Subclasses provide park-specific config via @destinationController.
 */
@config
class HFEBase extends Destination {
  /** Base URL for the CRM/content API (per-park) */
  @config
  crmBaseUrl: string = '';

  /** Base URL for the wait times (Pulse) API (shared) */
  @config
  waitTimeUrl: string = '';

  /** Site ID for activities endpoint (per-park) */
  @config
  siteId: string = '';

  /** Park ID for schedule endpoint (per-park) */
  @config
  parkId: string = '';

  /** Destination ID for the wait times endpoint (per-park) */
  @config
  waitTimeDestId: string = '';

  /** Park timezone */
  @config
  timezone: string = 'America/New_York';

  /** Activity category string used to filter attractions (differs per park) */
  @config
  attractionCategory: string = 'All Attractions';

  /** Activity category string used to filter dining (differs per park) */
  @config
  diningCategory: string = 'All Dining';

  /** Destination entity ID (set by subclass) */
  protected destinationSlug: string = '';

  /** Park entity ID (set by subclass) */
  protected parkSlug: string = '';

  /** Display name for destination entity (set by subclass) */
  protected destinationName: string = '';

  /** Display name for park entity (set by subclass) */
  protected parkName: string = '';

  /** Park location latitude */
  protected parkLatitude: number = 0;

  /** Park location longitude */
  protected parkLongitude: number = 0;

  constructor(options?: DestinationConstructor) {
    super(options);
    // Shared prefix for waitTimeUrl
    this.addConfigPrefix('HERSCHEND');
  }

  // ============================================================================
  // Cache Key Prefix
  // ============================================================================

  getCacheKeyPrefix(): string {
    return `hfe:${this.siteId || this.destinationSlug}`;
  }

  // ============================================================================
  // Header Injection
  // ============================================================================

  /**
   * Inject user-agent header for CRM API requests.
   * Uses dynamic hostname matching based on configured crmBaseUrl.
   */
  @inject({
    eventName: 'httpRequest',
    hostname: function () {
      if (!this.crmBaseUrl) return undefined;
      try {
        return new URL(this.crmBaseUrl).hostname;
      } catch {
        return undefined;
      }
    },
  })
  async injectCrmHeaders(requestObj: HTTPObj): Promise<void> {
    requestObj.headers = {
      ...requestObj.headers,
      'user-agent': 'okhttp/5.1.0',
    };
  }

  /**
   * Inject user-agent header for Pulse (wait time) API requests.
   * Uses dynamic hostname matching based on configured waitTimeUrl.
   */
  @inject({
    eventName: 'httpRequest',
    hostname: function () {
      if (!this.waitTimeUrl) return undefined;
      try {
        return new URL(this.waitTimeUrl).hostname;
      } catch {
        return undefined;
      }
    },
  })
  async injectWaitTimeHeaders(requestObj: HTTPObj): Promise<void> {
    requestObj.headers = {
      ...requestObj.headers,
      'user-agent': 'okhttp/5.1.0',
    };
  }

  // ============================================================================
  // HTTP Fetch Methods
  // ============================================================================

  /**
   * Fetch activities (POI data) for the park site.
   * Cached for 12 hours at HTTP level.
   */
  @http({cacheSeconds: 43200})
  async fetchActivities(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.crmBaseUrl}/api/destination/activitiesbysite/${this.siteId}`,
      options: {json: true},
    } as any as HTTPObj;
  }

  /**
   * Fetch park schedule for a 7-day window.
   * The API times out on large day counts (e.g., days=60), so we
   * batch in 7-day chunks from the caller.
   */
  @http({cacheSeconds: 43200, healthCheckArgs: ['{today}']})
  async fetchSchedule(startDate: string): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.crmBaseUrl}/api/park/dailyschedulebytime?parkids=${this.parkId}&days=7&date=${startDate}`,
      options: {json: true},
    } as any as HTTPObj;
  }

  /**
   * Fetch live wait times from the Pulse API.
   * Cached for 1 minute at HTTP level.
   */
  @http({cacheSeconds: 60})
  async fetchWaitTimes(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.waitTimeUrl}/api/waitTimes/${this.waitTimeDestId}`,
      options: {json: true},
    } as any as HTTPObj;
  }

  // ============================================================================
  // Cached Getter Methods
  // ============================================================================

  /**
   * Get activities data (cached 12 hours).
   */
  @cache({ttlSeconds: 43200})
  async getActivities(): Promise<HFEActivity[]> {
    const resp = await this.fetchActivities();
    const data: HFEActivitiesResponse = await resp.json();
    return Array.isArray(data?.activities) ? data.activities : [];
  }

  /**
   * Get schedule data for ~60 days (cached 12 hours).
   * Batches in 7-day chunks to avoid API timeouts.
   */
  @cache({ttlSeconds: 43200})
  async getSchedule(): Promise<HFEScheduleDay[]> {
    const allDays: HFEScheduleDay[] = [];
    const now = new Date();

    for (let i = 0; i < 9; i++) { // 9 x 7 = 63 days
      const startDate = addDays(now, i * 7);
      const dateStr = formatInTimezone(startDate, this.timezone, 'iso').split('T')[0];
      try {
        const resp = await this.fetchSchedule(dateStr);
        const data: HFEScheduleDay[] = await resp.json();
        if (Array.isArray(data)) {
          allDays.push(...data);
        }
      } catch {
        // Skip failed batches gracefully
      }
    }

    return allDays;
  }

  /**
   * Get wait times data (cached 1 minute).
   */
  @cache({ttlSeconds: 60})
  async getWaitTimes(): Promise<HFEWaitTime[]> {
    const resp = await this.fetchWaitTimes();
    const data: HFEWaitTime[] = await resp.json();
    return Array.isArray(data) ? data : [];
  }

  // ============================================================================
  // Entity Building
  // ============================================================================

  async getDestinations(): Promise<Entity[]> {
    return [{
      id: this.destinationSlug,
      name: this.destinationName,
      entityType: 'DESTINATION',
      timezone: this.timezone,
      location: {latitude: this.parkLatitude, longitude: this.parkLongitude},
    } as Entity];
  }

  protected async buildEntityList(): Promise<Entity[]> {
    const activities = await this.getActivities();

    const parkEntity: Entity = {
      id: this.parkSlug,
      name: this.parkName,
      entityType: 'PARK',
      parentId: this.destinationSlug,
      destinationId: this.destinationSlug,
      timezone: this.timezone,
      location: {latitude: this.parkLatitude, longitude: this.parkLongitude},
    } as Entity;

    const attractions = this.mapEntities(
      activities.filter(a => a.activityCategories?.includes(this.attractionCategory)),
      {
        idField: 'id',
        nameField: 'title',
        entityType: 'ATTRACTION',
        parentIdField: () => this.parkSlug,
        destinationId: this.destinationSlug,
        timezone: this.timezone,
        locationFields: {
          lat: (item: HFEActivity) => this.parseCoord(item.latitudeForDirections),
          lng: (item: HFEActivity) => this.parseCoord(item.longitudeForDirections),
        },
        transform: (entity, activity) => {
          const tags = [];

          // Add location tag if available
          const lat = this.parseCoord(activity.latitudeForDirections);
          const lng = this.parseCoord(activity.longitudeForDirections);
          if (lat != null && lng != null) {
            tags.push(TagBuilder.location(
              lat,
              lng,
              typeof entity.name === 'string' ? entity.name : 'Attraction Location',
            ));
          }

          // Parse height requirement
          const heightReq = activity.heightRequirement;
          if (heightReq != null) {
            if (typeof heightReq === 'number' && heightReq > 0) {
              tags.push(TagBuilder.minimumHeight(heightReq, 'in'));
            } else if (typeof heightReq === 'string') {
              const heightMatch = heightReq.match(/(\d+)/);
              if (heightMatch) {
                tags.push(TagBuilder.minimumHeight(parseInt(heightMatch[1], 10), 'in'));
              }
            }
          }

          if (tags.length > 0) {
            entity.tags = tags;
          }
          return entity;
        },
      },
    );

    const restaurants = this.mapEntities(
      activities.filter(a => a.activityCategories?.includes(this.diningCategory)),
      {
        idField: 'id',
        nameField: 'title',
        entityType: 'RESTAURANT',
        parentIdField: () => this.parkSlug,
        destinationId: this.destinationSlug,
        timezone: this.timezone,
        locationFields: {
          lat: (item: HFEActivity) => this.parseCoord(item.latitudeForDirections),
          lng: (item: HFEActivity) => this.parseCoord(item.longitudeForDirections),
        },
        transform: (entity, activity) => {
          const lat = this.parseCoord(activity.latitudeForDirections);
          const lng = this.parseCoord(activity.longitudeForDirections);
          if (lat != null && lng != null) {
            entity.tags = [TagBuilder.location(
              lat,
              lng,
              typeof entity.name === 'string' ? entity.name : 'Restaurant Location',
            )];
          }
          return entity;
        },
      },
    );

    return [parkEntity, ...attractions, ...restaurants];
  }

  // ============================================================================
  // Live Data
  // ============================================================================

  protected async buildLiveData(): Promise<LiveData[]> {
    const activities = await this.getActivities();
    const attractionActivities = activities.filter(a =>
      a.activityCategories?.includes(this.attractionCategory),
    );

    let waitTimes: HFEWaitTime[];
    try {
      waitTimes = await this.getWaitTimes();
    } catch {
      // Wait times endpoint may not be available (wrong destId, park closed, etc.)
      return [];
    }

    if (!waitTimes.length) return [];

    // Build lookup maps for joining wait times to entities
    // 1. rideWaitTimeRideId -> activity ID (primary, more reliable)
    const rideIdLookup = new Map<number, string>();
    // 2. normalized name -> activity ID (fallback)
    const nameLookup = new Map<string, string>();

    for (const activity of attractionActivities) {
      nameLookup.set(this.normalizeName(activity.title), activity.id);

      if (activity.rideWaitTimeRideId != null) {
        const rideId = typeof activity.rideWaitTimeRideId === 'string'
          ? parseInt(activity.rideWaitTimeRideId, 10)
          : activity.rideWaitTimeRideId;
        if (!isNaN(rideId)) {
          rideIdLookup.set(rideId, activity.id);
        }
      }
    }

    const liveData: LiveData[] = [];

    for (const wt of waitTimes) {
      const entityId = this.resolveEntityId(wt, rideIdLookup, nameLookup);
      if (!entityId) continue;

      const ld: LiveData = {id: entityId, status: 'CLOSED'} as LiveData;
      const statusUpper = (wt.operationStatus || '').toUpperCase();
      const displayUpper = (wt.waitTimeDisplay || '').toUpperCase();

      if (statusUpper === 'CLOSED' || statusUpper === 'CLOSED FOR THE DAY' || statusUpper === 'UNKNOWN') {
        ld.status = 'CLOSED' as any;
      } else if (statusUpper === 'TEMPORARILY CLOSED') {
        ld.status = 'DOWN' as any;
      } else if (statusUpper === 'TEMPORARILY DELAYED') {
        ld.status = 'DOWN' as any;
      } else if (displayUpper.includes('UNDER')) {
        // "Under XX minutes" pattern
        ld.status = 'OPERATING' as any;
        const waitMatch = displayUpper.match(/UNDER\s+(\d+)/);
        if (waitMatch) {
          ld.queue = {STANDBY: {waitTime: parseInt(waitMatch[1], 10)}};
        }
      } else if (statusUpper === 'OPEN' || (wt.waitTime != null && wt.waitTime >= 0)) {
        ld.status = 'OPERATING' as any;
        if (wt.waitTime != null && wt.waitTime > 0) {
          ld.queue = {STANDBY: {waitTime: wt.waitTime}};
        }
      } else {
        ld.status = 'CLOSED' as any;
      }

      liveData.push(ld);
    }

    return liveData;
  }

  /**
   * Resolve wait time entry to entity ID.
   * First tries rideWaitTimeRideId match (most reliable), then falls back to name matching.
   */
  private resolveEntityId(
    wt: HFEWaitTime,
    rideIdLookup: Map<number, string>,
    nameLookup: Map<string, string>,
  ): string | null {
    // Primary: match by rideId to rideWaitTimeRideId
    if (wt.rideId != null) {
      const match = rideIdLookup.get(wt.rideId);
      if (match) return match;
    }

    // Fallback: name-based matching (strip parenthetical suffix from wait time rideName)
    const cleanName = this.normalizeName(wt.rideName.replace(/\s*\([^)]*\)\s*$/, ''));
    const match = nameLookup.get(cleanName);
    if (match) return match;

    return null;
  }

  /**
   * Parse a coordinate value that may be a string (possibly with leading spaces) or number.
   * Returns undefined if the value is falsy or not a valid number.
   */
  private parseCoord(value: string | number | undefined): number | undefined {
    if (value == null) return undefined;
    const num = typeof value === 'string' ? parseFloat(value.trim()) : value;
    return isNaN(num) ? undefined : num;
  }

  /**
   * Normalize a name for comparison: lowercase, strip non-alphanumeric.
   */
  private normalizeName(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  // ============================================================================
  // Schedules
  // ============================================================================

  protected async buildSchedules(): Promise<EntitySchedule[]> {
    let scheduleDays: HFEScheduleDay[];
    try {
      scheduleDays = await this.getSchedule();
    } catch {
      return [];
    }

    if (!scheduleDays.length) return [];

    const scheduleEntries: Array<{
      date: string;
      type: string;
      openingTime: string;
      closingTime: string;
    }> = [];

    for (const day of scheduleDays) {
      if (!day.parkHours || !day.parkHours.length) continue;

      for (const hours of day.parkHours) {
        // Skip closed-to-public, all-day (hotel/resort), and empty entries
        if (hours.closedToPublic) continue;
        if (hours.isAllDay) continue;
        if (!hours.from || !hours.to) continue;

        // Filter by cmsKey matching parkId (each destination has multiple sub-parks)
        if (hours.cmsKey && hours.cmsKey !== this.parkId) continue;

        // from/to are ISO-ish strings without timezone (e.g., "2026-04-19T11:00:00")
        // They're in the park's local timezone
        const dateStr = day.date.split('T')[0];
        const fromTime = hours.from.split('T')[1] || '00:00:00';
        const toTime = hours.to.split('T')[1] || '00:00:00';

        const openingTime = constructDateTime(dateStr, fromTime, this.timezone);
        const closingTime = constructDateTime(dateStr, toTime, this.timezone);

        scheduleEntries.push({
          date: dateStr,
          type: 'OPERATING',
          openingTime,
          closingTime,
        });
      }
    }

    return [{
      id: this.parkSlug,
      schedule: scheduleEntries,
    } as EntitySchedule];
  }

}

// ============================================================================
// Park Subclasses
// ============================================================================

/**
 * Dollywood - Pigeon Forge, Tennessee
 * Wait Time Dest ID: 1
 */
@destinationController({category: ['Herschend', 'Dollywood']})
export class Dollywood extends HFEBase {
  constructor(options?: DestinationConstructor) {
    super(options);
    this.addConfigPrefix('DOLLYWOOD');

    this.destinationSlug = 'dollywood';
    this.parkSlug = 'dollywoodpark';
    this.destinationName = 'Dollywood';
    this.parkName = 'Dollywood';
    this.parkLatitude = 35.794496;
    this.parkLongitude = -83.530368;
    this.attractionCategory = 'Theme Park Rides';
    this.diningCategory = 'Theme Park Dining';
  }
}

/**
 * Silver Dollar City - Branson, Missouri
 * Wait Time Dest ID: 2
 */
@destinationController({category: ['Herschend', 'Silver Dollar City']})
export class SilverDollarCity extends HFEBase {
  constructor(options?: DestinationConstructor) {
    super(options);
    this.addConfigPrefix('SILVERDOLLARCITY');

    this.destinationSlug = 'silverdollarcity';
    this.parkSlug = 'silverdollarcitypark';
    this.destinationName = 'Silver Dollar City';
    this.parkName = 'Silver Dollar City';
    this.parkLatitude = 36.604152;
    this.parkLongitude = -93.29991;
    this.timezone = 'America/Chicago';
    this.attractionCategory = 'Rides & Attractions';
    this.diningCategory = 'Dining';
  }
}

/**
 * Wild Adventures - Valdosta, Georgia
 * Wait Time Dest ID: 3
 */
@destinationController({category: ['Herschend', 'Wild Adventures']})
export class WildAdventures extends HFEBase {
  constructor(options?: DestinationConstructor) {
    super(options);
    this.addConfigPrefix('WILDADVENTURES');

    this.destinationSlug = 'wildadventures';
    this.parkSlug = 'wildadventurespark';
    this.destinationName = 'Wild Adventures';
    this.parkName = 'Wild Adventures';
    this.parkLatitude = 30.8474;
    this.parkLongitude = -83.2790;
  }
}

/**
 * Kennywood - West Mifflin, Pennsylvania
 * Wait Time Dest ID: 4
 */
@destinationController({category: ['Herschend', 'Kennywood']})
export class Kennywood extends HFEBase {
  constructor(options?: DestinationConstructor) {
    super(options);
    this.addConfigPrefix('KENNYWOOD');

    this.destinationSlug = 'kennywood';
    this.parkSlug = 'kennywoodpark';
    this.destinationName = 'Kennywood';
    this.parkName = 'Kennywood';
    this.parkLatitude = 40.3866;
    this.parkLongitude = -79.8625;
  }
}

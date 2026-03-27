/**
 * Kennywood Theme Park (HFE Corp API)
 *
 * Standalone park implementation using the Herschend Family Entertainment API.
 * Supports entity data (attractions, restaurants), live wait times, and
 * park operating schedules.
 *
 * @module kennywood
 */

import {Destination, type DestinationConstructor} from '../../destination.js';
import config from '../../config.js';
import {http, type HTTPObj} from '../../http.js';
import {cache} from '../../cache.js';
import {inject} from '../../injector.js';
import {destinationController} from '../../destinationRegistry.js';
import type {Entity, LiveData, EntitySchedule} from '@themeparks/typelib';
import {formatInTimezone} from '../../datetime.js';
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
  rideWaitTimeRideId?: string | null;
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
  }>;
  activities: unknown[];
};

/** Wait time entry from the Pulse API */
type HFEWaitTime = {
  rideId: number;
  rideName: string;
  operationStatus: string;
  waitTime: number;
  waitTimeDisplay: string;
};

// ============================================================================
// Kennywood Destination
// ============================================================================

@destinationController({category: 'Kennywood'})
export class Kennywood extends Destination {
  /** Base URL for the CRM/content API */
  @config
  crmBaseUrl: string = '';

  /** Base URL for the wait times (Pulse) API */
  @config
  waitTimeUrl: string = '';

  /** Site ID for activities endpoint */
  @config
  siteId: string = '';

  /** Park ID for schedule endpoint */
  @config
  parkId: string = '';

  /** Destination ID for the wait times endpoint */
  @config
  waitTimeDestId: string = '';

  /** Park timezone */
  @config
  timezone: string = 'America/New_York';

  constructor(options?: DestinationConstructor) {
    super(options);
    this.addConfigPrefix('KENNYWOOD');
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
   * Fetch park schedule for the next 60 days.
   * Cached for 12 hours at HTTP level.
   */
  @http({cacheSeconds: 43200})
  async fetchSchedule(): Promise<HTTPObj> {
    const today = formatInTimezone(new Date(), this.timezone, 'iso').split('T')[0];
    return {
      method: 'GET',
      url: `${this.crmBaseUrl}/api/park/dailyschedulebytime?parkids=${this.parkId}&days=60&date=${today}`,
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
   * Get schedule data (cached 12 hours).
   */
  @cache({ttlSeconds: 43200})
  async getSchedule(): Promise<HFEScheduleDay[]> {
    const resp = await this.fetchSchedule();
    const data: HFEScheduleDay[] = await resp.json();
    return Array.isArray(data) ? data : [];
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
      id: 'kennywood',
      name: 'Kennywood',
      entityType: 'DESTINATION',
      timezone: this.timezone,
      location: {latitude: 40.3866, longitude: -79.8625},
    } as Entity];
  }

  protected async buildEntityList(): Promise<Entity[]> {
    const activities = await this.getActivities();

    const parkEntity: Entity = {
      id: 'kennywoodpark',
      name: 'Kennywood',
      entityType: 'PARK',
      parentId: 'kennywood',
      destinationId: 'kennywood',
      timezone: this.timezone,
      location: {latitude: 40.3866, longitude: -79.8625},
    } as Entity;

    const attractions = this.mapEntities(
      activities.filter(a => a.activityCategories?.includes('All Attractions')),
      {
        idField: 'id',
        nameField: 'title',
        entityType: 'ATTRACTION',
        parentIdField: () => 'kennywoodpark',
        destinationId: 'kennywood',
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
              // Numeric value (assume inches)
              tags.push(TagBuilder.minimumHeight(heightReq, 'in'));
            } else if (typeof heightReq === 'string') {
              // String like "46 inches" or "46"
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
      activities.filter(a => a.activityCategories?.includes('All Dining')),
      {
        idField: 'id',
        nameField: 'title',
        entityType: 'RESTAURANT',
        parentIdField: () => 'kennywoodpark',
        destinationId: 'kennywood',
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
    // Build entity lookup from POI data for name matching
    const activities = await this.getActivities();
    const attractionActivities = activities.filter(a =>
      a.activityCategories?.includes('All Attractions'),
    );

    let waitTimes: HFEWaitTime[];
    try {
      waitTimes = await this.getWaitTimes();
    } catch {
      // Wait times endpoint may not be available yet (wrong destId, park closed, etc.)
      return [];
    }

    if (!waitTimes.length) return [];

    // Build name lookup: normalized name -> activity ID
    const nameLookup = new Map<string, string>();
    for (const activity of attractionActivities) {
      nameLookup.set(this.normalizeName(activity.title), activity.id);
    }

    const liveData: LiveData[] = [];

    for (const wt of waitTimes) {
      // Try to match wait time to an entity
      const entityId = this.resolveEntityId(wt, nameLookup);
      if (!entityId) continue;

      const ld: LiveData = {id: entityId, status: 'CLOSED'} as LiveData;
      const statusUpper = (wt.operationStatus || '').toUpperCase();
      const displayUpper = (wt.waitTimeDisplay || '').toUpperCase();

      if (statusUpper === 'CLOSED' || statusUpper === 'UNKNOWN') {
        ld.status = 'CLOSED' as any;
      } else if (statusUpper === 'TEMPORARILY CLOSED') {
        ld.status = 'DOWN' as any;
      } else if (displayUpper.includes('UNDER')) {
        // "Under XX minutes" pattern
        ld.status = 'OPERATING' as any;
        const waitMatch = displayUpper.match(/UNDER\s+(\d+)/);
        if (waitMatch) {
          ld.queue = {STANDBY: {waitTime: parseInt(waitMatch[1], 10)}};
        }
      } else if (wt.waitTime != null && wt.waitTime > 0) {
        ld.status = 'OPERATING' as any;
        ld.queue = {STANDBY: {waitTime: wt.waitTime}};
      } else {
        ld.status = 'CLOSED' as any;
      }

      liveData.push(ld);
    }

    return liveData;
  }

  /**
   * Resolve wait time entry to entity ID.
   * First tries rideWaitTimeRideId match, then falls back to name matching.
   */
  private resolveEntityId(
    wt: HFEWaitTime,
    nameLookup: Map<string, string>,
  ): string | null {
    // Name-based matching: strip parenthetical suffix from wait time rideName
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
        // Skip closed-to-public and empty entries
        if (hours.closedToPublic) continue;
        if (!hours.from || !hours.to) continue;

        // from/to are ISO-ish strings without timezone (e.g., "2026-04-19T11:00:00")
        // They're in the park's local timezone (America/New_York)
        const dateStr = day.date.split('T')[0];
        const offset = this.getTimezoneOffset(dateStr);

        // Append the timezone offset to make them proper ISO strings
        const openingTime = `${hours.from}${offset}`;
        const closingTime = `${hours.to}${offset}`;

        scheduleEntries.push({
          date: dateStr,
          type: 'OPERATING',
          openingTime,
          closingTime,
        });
      }
    }

    return [{
      id: 'kennywoodpark',
      schedule: scheduleEntries,
    } as EntitySchedule];
  }

  /**
   * Get the UTC offset string for a given date in the park's timezone.
   * Returns e.g. "-05:00" (EST winter) or "-04:00" (EDT summer).
   */
  private getTimezoneOffset(dateStr: string): string {
    const refDate = new Date(`${dateStr}T12:00:00Z`);
    const formatted = formatInTimezone(refDate, this.timezone, 'iso');
    const match = formatted.match(/([+-]\d{2}:\d{2})$/);
    if (match) return match[1];
    // Fallback: try GMT offset format (e.g., "GMT-4")
    const gmtMatch = formatted.match(/GMT([+-]\d+)$/);
    if (gmtMatch) {
      const num = parseInt(gmtMatch[1], 10);
      const sign = num >= 0 ? '+' : '-';
      return `${sign}${String(Math.abs(num)).padStart(2, '0')}:00`;
    }
    return '-05:00';
  }
}

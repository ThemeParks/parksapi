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
  activityListId?: string;
  duration?: string | null;
  latitudeForDirections?: string | number;
  longitudeForDirections?: string | number;
  type?: string[];
  heightRequirement?: string | number | null;
  rideWaitTimeRideId?: string | number | null;
};

/** Show performance event from the daily schedule activities array */
type HFEShowEvent = {
  from?: string;
  to: string | null;
};

/** Show entry in the daily schedule activities array */
type HFEScheduleActivity = {
  cmsKey?: string;
  events?: HFEShowEvent[];
  isAllDayEvent?: boolean;
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
  activities?: HFEScheduleActivity[];
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

  /** activityListId UUID for the attractions list — used as fallback for rides with empty activityCategories */
  @config
  attractionsListId: string = '';

  /** activityListId UUID used to filter shows (differs per park; empty = no shows) */
  @config
  showCategoryListId: string = '';

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
   * Fetch activities (POI data) for the park.
   * Cached for 12 hours at HTTP level.
   */
  @http({cacheSeconds: 43200, retries: 3})
  async fetchActivities(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.crmBaseUrl}/api/park/activitiesbypark/${this.parkId}`,
      options: {json: true},
    } as any as HTTPObj;
  }

  /**
   * Fetch park schedule for a 7-day window.
   * The API times out on large day counts (e.g., days=60), so we
   * batch in 7-day chunks from the caller.
   */
  @http({cacheSeconds: 43200, healthCheckArgs: ['{today}'], retries: 3})
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
  @http({cacheSeconds: 60, retries: 3})
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
   * Throws if every batch fails so callers can distinguish a total outage
   * from a genuinely empty schedule.
   */
  @cache({ttlSeconds: 43200})
  async getSchedule(): Promise<HFEScheduleDay[]> {
    const allDays: HFEScheduleDay[] = [];
    const now = new Date();
    let succeededAny = false;
    let lastError: unknown;

    for (let i = 0; i < 9; i++) { // 9 x 7 = 63 days
      const startDate = addDays(now, i * 7);
      const dateStr = formatInTimezone(startDate, this.timezone, 'iso').split('T')[0];
      try {
        const resp = await this.fetchSchedule(dateStr);
        const data: HFEScheduleDay[] = await resp.json();
        if (Array.isArray(data)) {
          allDays.push(...data);
        }
        succeededAny = true;
      } catch (err) {
        lastError = err;
      }
    }

    if (!succeededAny) {
      throw lastError ?? new Error('all HFE schedule batches failed');
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
      activities.filter(a =>
        a.activityCategories?.includes(this.attractionCategory) ||
        (!!this.attractionsListId && a.activityListId === this.attractionsListId && a.rideWaitTimeRideId != null),
      ),
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
      },
    );

    // Shows: filtered by activityListId. The CRM retains historical one-time performers
    // indefinitely without setting end dates, so a categorised seasonal show OR a currently
    // scheduled performance is required to keep the entity. This preserves off-season
    // seasonal shows (Christmas, Spring, etc.) while dropping the uncategorised ghosts.
    // If the schedule API is unreachable, fall back to category-only — we'd rather lose
    // a few uncategorised real shows for one cache cycle than readmit 100+ ghosts.
    const shows: Entity[] = [];
    if (this.showCategoryListId) {
      let scheduledIds: Set<string | undefined> = new Set();
      try {
        const scheduleDays = await this.getSchedule();
        scheduledIds = new Set(
          scheduleDays.flatMap(day => (day.activities ?? []).map(a => a.cmsKey)),
        );
      } catch {
        // Schedule API totally unavailable — proceed with category-only filter
      }

      const showActivities = activities.filter(
        a => a.activityListId === this.showCategoryListId &&
          ((a.activityCategories?.length ?? 0) > 0 || scheduledIds.has(a.id)),
      );

      shows.push(...this.mapEntities(showActivities, {
        idField: 'id',
        nameField: 'title',
        entityType: 'SHOW',
        parentIdField: () => this.parkSlug,
        destinationId: this.destinationSlug,
        timezone: this.timezone,
        locationFields: {
          lat: (item: HFEActivity) => this.parseCoord(item.latitudeForDirections),
          lng: (item: HFEActivity) => this.parseCoord(item.longitudeForDirections),
        },
      }));
    }

    return [parkEntity, ...attractions, ...restaurants, ...shows];
  }

  // ============================================================================
  // Live Data
  // ============================================================================

  protected async buildLiveData(): Promise<LiveData[]> {
    const activities = await this.getActivities();
    const attractionActivities = activities.filter(a =>
      a.activityCategories?.includes(this.attractionCategory) ||
      (!!this.attractionsListId && a.activityListId === this.attractionsListId && a.rideWaitTimeRideId != null),
    );

    let waitTimes: HFEWaitTime[];
    try {
      waitTimes = await this.getWaitTimes();
    } catch {
      // Wait times endpoint may not be available (wrong destId, park closed, etc.)
      return [];
    }

    if (!waitTimes.length) return [];

    // Pre-opening rides return "Temporarily Closed" — without context we can't tell
    // that apart from a genuine in-operation breakdown. The schedule-derived flag
    // disambiguates: DOWN only during operating hours, CLOSED otherwise.
    const parkIsOpen = await this.isParkCurrentlyOpen();

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
      } else if (statusUpper === 'TEMPORARILY CLOSED' || statusUpper === 'TEMPORARILY DELAYED') {
        ld.status = (parkIsOpen ? 'DOWN' : 'CLOSED') as any;
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
   * Check whether the park is currently within its scheduled operating hours.
   * Used by buildLiveData to map "Temporarily Closed/Delayed" — DOWN during
   * operating hours (genuine breakdown), CLOSED outside them (pre-opening or
   * post-closing pseudo-state the API reports for every ride).
   * Returns false when schedule data is unavailable, biasing toward CLOSED.
   */
  private async isParkCurrentlyOpen(): Promise<boolean> {
    let schedule: HFEScheduleDay[];
    try {
      schedule = await this.getSchedule();
    } catch {
      return false;
    }

    const now = new Date();
    const todayStr = formatInTimezone(now, this.timezone, 'iso').split('T')[0];
    const today = schedule.find(d => (d.date || '').startsWith(todayStr));
    if (!today) return false;

    for (const hours of (today.parkHours || [])) {
      if (hours.closedToPublic || hours.isAllDay) continue;
      if (!hours.from || !hours.to) continue;
      if (hours.cmsKey && hours.cmsKey !== this.parkId) continue;

      const fromTime = hours.from.split('T')[1] || '00:00:00';
      const toTime = hours.to.split('T')[1] || '00:00:00';
      const opening = new Date(constructDateTime(todayStr, fromTime, this.timezone));
      const closing = new Date(constructDateTime(todayStr, toTime, this.timezone));

      if (now >= opening && now <= closing) return true;
    }
    return false;
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

    const result: EntitySchedule[] = [{
      id: this.parkSlug,
      schedule: scheduleEntries,
    } as EntitySchedule];

    // Show performance schedules
    if (this.showCategoryListId) {
      let activities: HFEActivity[];
      try {
        activities = await this.getActivities();
      } catch {
        return result;
      }
      // Index shows by id for duration lookup (cmsKey in schedule == id in activities)
      const showById = new Map(
        activities
          .filter(a => a.activityListId === this.showCategoryListId)
          .map(a => [a.id, a]),
      );

      const showSchedules = new Map<string, Array<{date: string; type: string; openingTime: string; closingTime: string}>>();

      for (const day of scheduleDays) {
        if (!Array.isArray(day.activities)) continue;
        const dateStr = day.date.split('T')[0];

        for (const activity of day.activities) {
          if (!activity.cmsKey || !activity.events?.length) continue;

          const show = showById.get(activity.cmsKey);
          if (!show) continue;

          for (const event of activity.events) {
            if (!event.from) continue;

            const fromTime = event.from.split('T')[1] || '00:00:00';
            const openingTime = constructDateTime(dateStr, fromTime, this.timezone);

            let closingTime: string | undefined;
            if (event.to) {
              const toTime = event.to.split('T')[1] || '00:00:00';
              closingTime = constructDateTime(dateStr, toTime, this.timezone);
            } else if (show.duration) {
              // Duration formats: "35 Minutes", "15 minutes", "n/a", null
              const match = show.duration.match(/(\d+)/);
              if (match) {
                const durationMs = parseInt(match[1], 10) * 60 * 1000;
                closingTime = formatInTimezone(new Date(new Date(openingTime).getTime() + durationMs), this.timezone, 'iso');
              }
            }

            if (!closingTime) continue; // closingTime required by schema

            if (!showSchedules.has(show.id)) {
              showSchedules.set(show.id, []);
            }
            showSchedules.get(show.id)!.push({
              date: dateStr,
              type: 'OPERATING',
              openingTime,
              closingTime,
            });
          }
        }
      }

      for (const [id, schedule] of showSchedules) {
        result.push({id, schedule} as EntitySchedule);
      }
    }

    return result;
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
    this.attractionsListId = '96822fdb-77e5-4054-9f37-70f379f997d8';
    this.diningCategory = 'Theme Park Dining';
    this.showCategoryListId = 'b9acfd27-0545-4bb2-a6e8-072fda3b06dd';
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
    this.attractionsListId = '6cbebd47-facc-4c26-b1b2-4e0da4de0e6e';
    this.diningCategory = 'Dining';
    this.showCategoryListId = '9e8b88c7-6a31-46e2-b696-aad5a5ecfe3d';
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

/**
 * TE2 (Theme Entertainment Engine) - Australian Theme Parks Framework
 *
 * Provides support for 4 VRTP (Village Roadshow Theme Parks) parks
 * using the TE2 API platform. Supports real-time wait times, entity data,
 * operating schedules, and event calendars (showtimes).
 *
 * Parks: Sea World Gold Coast, Warner Bros. Movie World,
 *        Paradise Country, Wet'n'Wild Gold Coast
 *
 * @module te2
 */

import {Destination, type DestinationConstructor} from '../../destination.js';
import config from '../../config.js';
import {http, type HTTPObj} from '../../http.js';
import {cache} from '../../cache.js';
import {inject} from '../../injector.js';
import {destinationController} from '../../destinationRegistry.js';
import type {Entity, LiveData, EntitySchedule} from '@themeparks/typelib';
import {formatInTimezone} from '../../datetime.js';

// ============================================================================
// Constants
// ============================================================================

/** POI type labels that identify attractions/rides */
const RIDE_TYPES = new Set([
  'Ride', 'Coasters', 'Family', 'ThrillRides', 'Kids', 'Rides & Attractions',
]);

/** POI type labels that identify dining locations */
const DINING_TYPES = new Set([
  'Snacks', 'Meals', 'Dining',
]);

/** POI type labels that identify shows/entertainment */
const SHOW_TYPES = new Set([
  'Shows', 'Show', 'Entertainment', 'Live Entertainment', 'Presentation',
]);

/** Schedule hour labels that indicate park operating hours */
const PARK_SCHEDULE_LABELS = new Set(['park', 'gate']);

/** Tags on POI entries that indicate a ride (used for fallback classification) */
const RIDE_INDICATOR_LABELS = new Set(['thrill level', 'rider height', 'ages']);

// ============================================================================
// API Response Types
// ============================================================================

/** Venue info from GET /rest/venue/{venueId} */
type TE2VenueInfo = {
  name?: string;
  label?: string;
  location?: {
    lon?: number;
    lat?: number;
    center?: {
      lon?: number;
      lat?: number;
    };
  };
};

/** Single POI from GET /rest/venue/{venueId}/poi/all */
type TE2POI = {
  id: string;
  name?: string;
  label?: string;
  type?: string;
  location?: {
    lon?: number;
    lat?: number;
  };
  tags?: Array<{label?: string}>;
  status?: {
    isOpen?: boolean;
    waitTime?: number;
    operationalStatus?: string;
  };
};

/** POI status from GET /rest/venue/{venueId}/poi/all/status */
type TE2POIStatus = {
  id: string;
  status?: {
    isOpen?: boolean;
    waitTime?: number;
  };
};

/** Single queue entry from ride status endpoint */
type TE2QueueEntry = {
  isPrimary?: boolean;
  isDefault?: boolean;
  isOpen?: boolean;
  waitTimeMins?: number;
};

/** Ride status entry from external fastpass endpoint */
type TE2RideStatusEntry = {
  tags?: string[];
  queues?: TE2QueueEntry[];
  isOpen?: boolean;
  state?: string;
  waitTimeMins?: number;
};

/** Schedule data from GET /v2/venues/{venueId}/venue-hours */
type TE2ScheduleResponse = {
  days?: Array<{
    label?: string;
    hours?: Array<{
      label?: string;
      status?: string;
      schedule?: {
        start?: string;
        end?: string;
      };
    }>;
  }>;
};

/** Event calendar from GET /v2/venues/{venueId}/calendars/events */
type TE2EventCalendarResponse = {
  events?: Array<{
    id?: string;
    title?: string;
    description?: string;
    associatedPois?: Array<{id?: string}>;
  }>;
  schedules?: Array<{
    eventId?: string;
    start?: string;
    end?: string;
  }>;
};

/** Normalized status entry used internally */
type NormalizedStatusEntry = {
  id: string;
  isOpen: boolean;
  waitTime: number | null;
};

// ============================================================================
// Base Class
// ============================================================================

/**
 * Base class for TE2-powered Australian theme parks.
 *
 * NOT registered as a destination. Subclasses use @destinationController
 * to register individual parks.
 */
@config
class TE2Destination extends Destination {
  /** Basic auth username for TE2 API */
  @config
  apiUser: string = '';

  /** Basic auth password for TE2 API */
  @config
  apiPass: string = '';

  /** Base URL for the TE2 API (e.g., https://vrtp.te2.biz) */
  @config
  baseUrl: string = '';

  /** TE2 venue identifier (e.g., VRTP_SW) */
  @config
  venueId: string = '';

  /** Optional external ride status URL (richer wait time data) */
  @config
  rideStatusUrl: string = '';

  /** Park timezone */
  @config
  timezone: string = 'Australia/Brisbane';

  /** Destination ID (set by subclasses) */
  protected destinationId: string = '';

  constructor(options?: DestinationConstructor) {
    super(options);
    this.addConfigPrefix('TE2');
  }

  /**
   * Cache key prefix to prevent collisions between parks sharing the base class.
   */
  getCacheKeyPrefix(): string {
    return `te2:${this.venueId}`;
  }

  // ============================================================================
  // Header Injection
  // ============================================================================

  /**
   * Inject Basic Auth header for TE2 API requests on the baseUrl hostname.
   * Only applies to /rest/ and /v2/ paths (the authenticated API endpoints).
   */
  @inject({
    eventName: 'httpRequest',
    hostname: function () {
      if (!this.baseUrl) return undefined;
      try {
        return new URL(this.baseUrl).hostname;
      } catch {
        return undefined;
      }
    },
  })
  async injectBasicAuth(requestObj: HTTPObj): Promise<void> {
    const url = new URL(requestObj.url);
    if (url.pathname.startsWith('/rest/') || url.pathname.startsWith('/v2/')) {
      const credentials = Buffer.from(`${this.apiUser}:${this.apiPass}`).toString('base64');
      requestObj.headers = {
        ...requestObj.headers,
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/json',
      };
    }
  }

  // ============================================================================
  // HTTP Fetch Methods
  // ============================================================================

  /**
   * Fetch venue metadata (name, location).
   * Cached 24h at HTTP level.
   */
  @http({cacheSeconds: 86400})
  async fetchVenue(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.baseUrl}/rest/venue/${this.venueId}`,
      options: {json: true},
    } as any as HTTPObj;
  }

  /**
   * Fetch all POIs for this venue (entities + inline status).
   * Cached 24h at HTTP level (entity data).
   */
  @http({cacheSeconds: 86400})
  async fetchPOIAll(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.baseUrl}/rest/venue/${this.venueId}/poi/all`,
      options: {json: true},
    } as any as HTTPObj;
  }

  /**
   * Fetch display categories for POI classification.
   * Used to discover which POIs belong to ride/show/dining categories.
   * Cached 24h at HTTP level.
   */
  @http({cacheSeconds: 86400})
  async fetchDisplayCategories(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.baseUrl}/rest/app/${this.venueId}/displayCategories`,
      options: {json: true},
    } as any as HTTPObj;
  }

  /**
   * Fetch POI status (live data fallback when no rideStatusUrl).
   * Cached 1min at HTTP level.
   */
  @http({cacheSeconds: 60})
  async fetchPOIStatus(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.baseUrl}/rest/venue/${this.venueId}/poi/all/status`,
      options: {json: true},
    } as any as HTTPObj;
  }

  /**
   * Fetch external ride status endpoint (richer wait time data).
   * Only used when rideStatusUrl is configured. No auth headers.
   * Cached 1min at HTTP level.
   */
  @http({cacheSeconds: 60})
  async fetchRideStatus(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: this.rideStatusUrl,
      options: {json: true},
    } as any as HTTPObj;
  }

  /**
   * Fetch venue operating hours schedule.
   * Cached 24h at HTTP level.
   */
  @http({cacheSeconds: 86400})
  async fetchSchedule(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.baseUrl}/v2/venues/${this.venueId}/venue-hours?days=120`,
      options: {json: true},
    } as any as HTTPObj;
  }

  /**
   * Fetch event calendar (shows/entertainment).
   * Cached 30min at HTTP level.
   */
  @http({cacheSeconds: 1800})
  async fetchEventCalendar(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.baseUrl}/v2/venues/${this.venueId}/calendars/events?days=14`,
      options: {json: true},
    } as any as HTTPObj;
  }

  // ============================================================================
  // Cached Getter Methods
  // ============================================================================

  /**
   * Get venue metadata (cached 24h).
   */
  @cache({ttlSeconds: 86400})
  async getVenue(): Promise<TE2VenueInfo> {
    const resp = await this.fetchVenue();
    const data = await resp.json();
    return data || {};
  }

  /**
   * Get all POI data (cached 24h).
   */
  @cache({ttlSeconds: 86400})
  async getPOIAll(): Promise<TE2POI[]> {
    const resp = await this.fetchPOIAll();
    const data = await resp.json();
    return Array.isArray(data) ? data : [];
  }

  /**
   * Get display categories with POI membership (cached 24h).
   * Returns a map of category labels to sets of POI IDs.
   */
  @cache({ttlSeconds: 86400})
  async getDisplayCategories(): Promise<{ ridePoiIds: Record<string, true>; showPoiIds: Record<string, true>; diningPoiIds: Record<string, true> }> {
    const ridePoiIds: Record<string, true> = {};
    const showPoiIds: Record<string, true> = {};
    const diningPoiIds: Record<string, true> = {};

    try {
      const resp = await this.fetchDisplayCategories();
      const data = await resp.json();
      const categories: Array<{ id: string; label: string; parent: string | null; poi: string[] }> = data?.categories || [];

      // Build parent→children map
      const childrenOf = new Map<string, typeof categories>();
      for (const cat of categories) {
        const parent = cat.parent || 'root';
        if (!childrenOf.has(parent)) childrenOf.set(parent, []);
        childrenOf.get(parent)!.push(cat);
      }

      // Collect POI IDs from categories matching our type labels + their children
      const collectPois = (labels: string[], targetObj: Record<string, true>) => {
        const matchedIds = new Set<string>();
        // Find matching root/top-level categories
        for (const cat of categories) {
          if (labels.some(l => cat.label.toLowerCase().includes(l.toLowerCase()))) {
            matchedIds.add(cat.id);
            for (const poiId of (cat.poi || [])) targetObj[poiId] = true;
          }
        }
        // Also collect from children of matched categories
        for (const cat of categories) {
          if (cat.parent && matchedIds.has(cat.parent)) {
            for (const poiId of (cat.poi || [])) targetObj[poiId] = true;
          }
        }
      };

      collectPois(['Ride', 'Coaster', 'Thrill', 'Family', 'Kids', 'Attractions'], ridePoiIds);
      collectPois(['Show', 'Entertainment', 'Presentation', 'Meet & Greet'], showPoiIds);
      collectPois(['Dining', 'Snack', 'Meal', 'Food', 'Drink'], diningPoiIds);
    } catch {
      // If categories fail, fall back to type-based filtering only
    }

    return { ridePoiIds, showPoiIds, diningPoiIds };
  }

  /**
   * Get normalized live status data (cached 1min).
   *
   * If rideStatusUrl is configured, fetches from the external endpoint
   * (which provides richer queue data). Otherwise falls back to the
   * standard POI status endpoint.
   */
  @cache({ttlSeconds: 60})
  async getLiveStatus(): Promise<NormalizedStatusEntry[]> {
    if (this.rideStatusUrl) {
      return this.parseRideStatusEndpoint();
    }
    return this.parsePOIStatusEndpoint();
  }

  /**
   * Parse the standard POI status endpoint into normalized entries.
   */
  private async parsePOIStatusEndpoint(): Promise<NormalizedStatusEntry[]> {
    const resp = await this.fetchPOIStatus();
    const data: TE2POIStatus[] = await resp.json();
    if (!Array.isArray(data)) return [];

    const entries: NormalizedStatusEntry[] = [];
    for (const item of data) {
      if (!item?.id || !item.status) continue;

      const rawWait = item.status.waitTime;
      const waitTime = (rawWait !== undefined && rawWait !== null && Number.isFinite(Number(rawWait)))
        ? Math.max(0, Math.round(Number(rawWait)))
        : null;

      entries.push({
        id: String(item.id),
        isOpen: item.status.isOpen === true,
        waitTime,
      });
    }
    return entries;
  }

  /**
   * Parse the external ride status endpoint into normalized entries.
   * Extracts entity ID from `te2_rideid:` tags.
   */
  private async parseRideStatusEndpoint(): Promise<NormalizedStatusEntry[]> {
    const resp = await this.fetchRideStatus();
    const data: TE2RideStatusEntry[] = await resp.json();
    if (!Array.isArray(data)) return [];

    const entries: NormalizedStatusEntry[] = [];
    for (const ride of data) {
      const te2Id = this.extractTe2RideId(ride.tags);
      if (!te2Id) continue;

      const primaryQueue = this.getPrimaryQueue(ride);
      const isOpen = this.isRideOpen(ride, primaryQueue);

      // Prefer ride-level waitTimeMins, fall back to queue-level
      const rawWait = ride.waitTimeMins ?? primaryQueue?.waitTimeMins;
      const waitValue = Number(rawWait);
      const waitTime = Number.isFinite(waitValue) ? Math.max(0, Math.round(waitValue)) : null;

      entries.push({
        id: te2Id,
        isOpen,
        waitTime,
      });
    }
    return entries;
  }

  /**
   * Extract TE2 ride ID from tags array (looks for `te2_rideid:ACTUAL_ID`).
   */
  private extractTe2RideId(tags?: string[]): string | null {
    if (!Array.isArray(tags)) return null;

    for (const tag of tags) {
      if (typeof tag !== 'string') continue;
      const match = tag.match(/^te2_rideid:(.+)$/i);
      if (match?.[1]) return match[1];
    }
    return null;
  }

  /**
   * Select the primary queue entry for a ride.
   * Priority: isPrimary > isDefault > first queue.
   */
  private getPrimaryQueue(ride: TE2RideStatusEntry) {
    const queues = Array.isArray(ride.queues) ? ride.queues : [];
    return queues.find(q => q?.isPrimary) || queues.find(q => q?.isDefault) || queues[0] || null;
  }

  /**
   * Determine if a ride is open from queue or state data.
   */
  private isRideOpen(ride: TE2RideStatusEntry, primaryQueue: TE2QueueEntry | null): boolean {
    if (typeof primaryQueue?.isOpen === 'boolean') return primaryQueue.isOpen;
    if (typeof ride?.isOpen === 'boolean') return ride.isOpen;

    if (typeof ride?.state === 'string') {
      const normalized = ride.state.toLowerCase();
      if (normalized.includes('open')) return true;
      if (normalized.includes('closed') || normalized.includes('down') || normalized.includes('maintenance')) {
        return false;
      }
    }
    return false;
  }

  /**
   * Get event calendar data (cached 30min).
   */
  @cache({ttlSeconds: 1800})
  async getEventCalendar(): Promise<TE2EventCalendarResponse> {
    try {
      const resp = await this.fetchEventCalendar();
      const data: TE2EventCalendarResponse = await resp.json();
      return data || {};
    } catch {
      return {};
    }
  }

  /**
   * Get schedule data (cached 24h).
   */
  @cache({ttlSeconds: 86400})
  async getScheduleData(): Promise<TE2ScheduleResponse> {
    const resp = await this.fetchSchedule();
    const data: TE2ScheduleResponse = await resp.json();
    return data || {};
  }

  // ============================================================================
  // Location Helpers
  // ============================================================================

  /**
   * Extract location from venue data.
   * Prefers center coordinates, falls back to top-level lon/lat.
   */
  private getVenueLocation(venue: TE2VenueInfo): {latitude: number; longitude: number} | undefined {
    const loc = venue.location;
    if (!loc) return undefined;

    // Prefer center coordinates
    if (loc.center?.lon !== undefined && loc.center?.lat !== undefined) {
      const lon = Number(loc.center.lon);
      const lat = Number(loc.center.lat);
      if (Number.isFinite(lon) && Number.isFinite(lat)) {
        return {latitude: lat, longitude: lon};
      }
    }

    // Fall back to top-level
    if (loc.lon !== undefined && loc.lat !== undefined) {
      const lon = Number(loc.lon);
      const lat = Number(loc.lat);
      if (Number.isFinite(lon) && Number.isFinite(lat)) {
        return {latitude: lat, longitude: lon};
      }
    }

    return undefined;
  }

  /**
   * Extract location from a POI entry.
   * Note: TE2 POI uses lon/lat (longitude first).
   */
  private getPOILocation(poi: TE2POI): {latitude: number; longitude: number} | undefined {
    if (!poi.location) return undefined;

    const lon = Number(poi.location.lon);
    const lat = Number(poi.location.lat);
    if (Number.isFinite(lon) && Number.isFinite(lat) && lon !== 0 && lat !== 0) {
      return {latitude: lat, longitude: lon};
    }
    return undefined;
  }

  // ============================================================================
  // Entity Building
  // ============================================================================

  async getDestinations(): Promise<Entity[]> {
    const venue = await this.getVenue();
    const location = this.getVenueLocation(venue);

    const destId = `${this.destinationId}_destination`;
    return [{
      id: destId,
      name: venue.name || venue.label || destId,
      entityType: 'DESTINATION',
      timezone: this.timezone,
      location,
    } as Entity];
  }

  protected async buildEntityList(): Promise<Entity[]> {
    const venue = await this.getVenue();
    const pois = await this.getPOIAll();
    const location = this.getVenueLocation(venue);

    const destId = `${this.destinationId}_destination`;
    const parkId = this.destinationId;

    // Park entity
    const parkEntity: Entity = {
      id: parkId,
      name: venue.name || venue.label || parkId,
      entityType: 'PARK',
      parentId: destId,
      destinationId: destId,
      timezone: this.timezone,
      location,
    } as Entity;

    // Get category-based POI membership from displayCategories API
    const categories = await this.getDisplayCategories();

    // Collect IDs from live status to help with ride classification
    const liveStatusIds = new Set((await this.getLiveStatus()).map(e => e.id));

    // Build attraction entities — include if type matches OR in ride category OR in live status
    const attractions = this.buildFilteredEntities(pois, RIDE_TYPES, parkId, 'ATTRACTION', (poi) => {
      // Include if the displayCategories API lists it as a ride
      if (poi.id && poi.id in categories.ridePoiIds) return true;

      // Include if it appears in the live status endpoint
      if (poi.id && liveStatusIds.has(poi.id)) return true;

      // Include if it has status data with ride indicator tags
      const status = poi.status;
      if (!status || (status.waitTime === undefined && status.operationalStatus === undefined)) {
        return false;
      }
      const tags = Array.isArray(poi.tags) ? poi.tags : [];
      return tags.some(tag => {
        const label = (tag?.label || '').toLowerCase();
        return RIDE_INDICATOR_LABELS.has(label);
      });
    });

    // Build restaurant entities — include if type matches OR in dining category
    const restaurantIds = new Set<string>();
    const restaurants = this.buildFilteredEntities(pois, DINING_TYPES, parkId, 'RESTAURANT', (poi) => {
      return !!(poi.id && poi.id in categories.diningPoiIds);
    });
    restaurants.forEach(r => restaurantIds.add(r.id));

    // Filter attractions to exclude dining entries
    const filteredAttractions = attractions.filter(a => !restaurantIds.has(a.id));

    // Build show entities from POI — include if type matches OR in show category
    const shows = this.buildFilteredEntities(pois, SHOW_TYPES, parkId, 'SHOW', (poi) => {
      return !!(poi.id && poi.id in categories.showPoiIds);
    });
    const showIds = new Set(shows.map(s => s.id));

    // Merge in event calendar shows
    const eventShows = await this.buildEventShowEntities(parkId, showIds, pois);

    return [parkEntity, ...filteredAttractions, ...restaurants, ...shows, ...eventShows];
  }

  /**
   * Filter POIs by type and build Entity objects.
   * Optionally applies an additional inclusion function for fallback matching.
   */
  private buildFilteredEntities(
    pois: TE2POI[],
    typeSet: Set<string>,
    parkId: string,
    entityType: Entity['entityType'],
    includeFn?: (poi: TE2POI) => boolean,
  ): Entity[] {
    const seenIds = new Set<string>();
    const entities: Entity[] = [];

    for (const poi of pois) {
      if (!poi?.id) continue;
      const poiId = String(poi.id);
      if (seenIds.has(poiId)) continue;

      const matchesType = !!poi.type && typeSet.has(poi.type);
      const matchesFallback = !matchesType && typeof includeFn === 'function' && includeFn(poi);

      if (!matchesType && !matchesFallback) continue;

      seenIds.add(poiId);
      const location = this.getPOILocation(poi);

      const entity: Entity = {
        id: poiId,
        name: poi.name || poi.label || `${entityType} ${poiId}`,
        entityType,
        parentId: parkId,
        destinationId: `${this.destinationId}_destination`,
        timezone: this.timezone,
        location,
      } as Entity;

      entities.push(entity);
    }

    return entities;
  }

  /**
   * Build show entities from event calendar that don't already exist in POI data.
   */
  private async buildEventShowEntities(
    parkId: string,
    existingShowIds: Set<string>,
    pois: TE2POI[],
  ): Promise<Entity[]> {
    const calendar = await this.getEventCalendar();
    const events = Array.isArray(calendar.events) ? calendar.events : [];
    if (events.length === 0) return [];

    // Build POI lookup for location fallback
    const poiMap = new Map<string, TE2POI>();
    for (const poi of pois) {
      if (poi?.id) poiMap.set(poi.id, poi);
    }

    const entities: Entity[] = [];
    for (const event of events) {
      if (!event?.id) continue;
      if (existingShowIds.has(event.id)) continue;

      // Try to find location from associated POIs
      let location: {latitude: number; longitude: number} | undefined;
      const assocPois = Array.isArray(event.associatedPois) ? event.associatedPois : [];
      for (const assoc of assocPois) {
        if (assoc?.id && poiMap.has(assoc.id)) {
          location = this.getPOILocation(poiMap.get(assoc.id)!);
          if (location) break;
        }
      }

      // Fallback to venue location
      if (!location) {
        const venue = await this.getVenue();
        location = this.getVenueLocation(venue);
      }

      const entity: Entity = {
        id: String(event.id),
        name: event.title || `Show ${event.id}`,
        entityType: 'SHOW',
        parentId: parkId,
        destinationId: `${this.destinationId}_destination`,
        timezone: this.timezone,
        location,
      } as Entity;

      entities.push(entity);
      existingShowIds.add(String(event.id));
    }

    return entities;
  }

  // ============================================================================
  // Live Data
  // ============================================================================

  protected async buildLiveData(): Promise<LiveData[]> {
    const liveDataMap = new Map<string, LiveData>();

    // Get entity IDs for filtering
    const entities = await this.getEntities();
    const entityIds = new Set(entities.map(e => e.id));

    // Process ride/attraction status
    const statusEntries = await this.getLiveStatus();
    for (const entry of statusEntries) {
      if (!entityIds.has(entry.id)) continue;
      // Skip beacon entries
      if (entry.id.includes('_STANDING_OFFER_BEACON')) continue;

      const ld: LiveData = {
        id: entry.id,
        status: entry.isOpen ? 'OPERATING' : 'CLOSED',
      } as LiveData;

      if (entry.waitTime !== null) {
        ld.queue = {
          STANDBY: {waitTime: entry.waitTime},
        };
      }

      liveDataMap.set(entry.id, ld);
    }

    // Process show schedule (event calendar for today)
    await this.addShowLiveData(liveDataMap);

    return Array.from(liveDataMap.values());
  }

  /**
   * Add live data for shows from event calendar (today's showtimes).
   */
  private async addShowLiveData(liveDataMap: Map<string, LiveData>): Promise<void> {
    const calendar = await this.getEventCalendar();
    const events = Array.isArray(calendar.events) ? calendar.events : [];
    const schedules = Array.isArray(calendar.schedules) ? calendar.schedules : [];
    if (events.length === 0 || schedules.length === 0) return;

    // Build event lookup
    const eventsById = new Map<string, typeof events[0]>();
    for (const event of events) {
      if (event?.id) eventsById.set(event.id, event);
    }

    // Get current time in park timezone
    const now = new Date();
    const todayStr = formatInTimezone(now, this.timezone, 'iso').slice(0, 10);

    // Group schedules by event, filter to today
    const showtimesByEvent = new Map<string, Array<{startTime: string; endTime: string}>>();

    for (const slot of schedules) {
      if (!slot?.eventId || !slot.start) continue;
      if (!eventsById.has(slot.eventId)) continue;

      const startDate = new Date(slot.start);
      if (isNaN(startDate.getTime())) continue;

      const endDate = slot.end ? new Date(slot.end) : null;
      if (endDate && isNaN(endDate.getTime())) continue;

      // Filter to today's events in park timezone
      const slotDateStr = formatInTimezone(startDate, this.timezone, 'iso').slice(0, 10);
      const endDateStr = endDate ? formatInTimezone(endDate, this.timezone, 'iso').slice(0, 10) : null;
      if (slotDateStr !== todayStr && endDateStr !== todayStr) continue;

      // Filter out past events
      const endTime = endDate || startDate;
      if (endTime.getTime() < now.getTime()) continue;

      const showtime = {
        startTime: formatInTimezone(startDate, this.timezone, 'iso'),
        endTime: formatInTimezone(endDate || startDate, this.timezone, 'iso'),
      };

      if (!showtimesByEvent.has(slot.eventId)) {
        showtimesByEvent.set(slot.eventId, []);
      }
      showtimesByEvent.get(slot.eventId)!.push(showtime);
    }

    // Add showtimes to live data
    for (const [eventId, showtimes] of showtimesByEvent) {
      if (showtimes.length === 0) continue;

      // Sort by start time
      showtimes.sort((a, b) => a.startTime.localeCompare(b.startTime));

      const ld = liveDataMap.get(eventId) || {id: eventId} as LiveData;
      (ld as any).showtimes = showtimes.map(st => ({
        type: 'Performance Time',
        startTime: st.startTime,
        endTime: st.endTime,
      }));
      ld.status = 'OPERATING' as any;
      liveDataMap.set(eventId, ld);
    }
  }

  // ============================================================================
  // Schedules
  // ============================================================================

  protected async buildSchedules(): Promise<EntitySchedule[]> {
    const scheduleData = await this.getScheduleData();
    if (!Array.isArray(scheduleData.days)) return [];

    const parkId = this.destinationId;
    const scheduleEntries: Array<{
      date: string;
      type: string;
      description?: string;
      openingTime: string;
      closingTime: string;
    }> = [];

    for (const day of scheduleData.days) {
      const hours = Array.isArray(day.hours) ? day.hours : [];

      for (const hour of hours) {
        // Skip closed entries unless it's specifically the Park schedule
        if (day.label !== 'Park' && hour.status === 'CLOSED') continue;

        const start = hour.schedule?.start;
        const end = hour.schedule?.end;
        if (!start || !end) continue;

        const startDate = new Date(start);
        const endDate = new Date(end);
        if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) continue;

        const label = typeof hour.label === 'string' ? hour.label.trim() : '';
        const normalizedLabel = label.toLowerCase();

        // Determine schedule type
        const scheduleType = PARK_SCHEDULE_LABELS.has(normalizedLabel) ? 'OPERATING' : 'INFO';

        const startFormatted = formatInTimezone(startDate, this.timezone, 'iso');
        const endFormatted = formatInTimezone(endDate, this.timezone, 'iso');

        scheduleEntries.push({
          date: startFormatted.slice(0, 10),
          type: scheduleType,
          description: normalizedLabel === 'park' ? undefined : (label || undefined),
          openingTime: startFormatted,
          closingTime: endFormatted,
        });
      }
    }

    // Sort by date then opening time
    scheduleEntries.sort((a, b) => {
      const dateCompare = a.date.localeCompare(b.date);
      if (dateCompare !== 0) return dateCompare;
      return a.openingTime.localeCompare(b.openingTime);
    });

    if (scheduleEntries.length === 0) return [];

    return [{
      id: parkId,
      schedule: scheduleEntries,
    } as EntitySchedule];
  }
}

// ============================================================================
// Park Subclasses
// ============================================================================

/**
 * Sea World Gold Coast - Gold Coast, Queensland, Australia
 */
@destinationController({category: ['TE2', 'Sea World Gold Coast']})
export class SeaWorldGoldCoast extends TE2Destination {
  constructor(options?: DestinationConstructor) {
    super(options);
    this.destinationId = 'vrtp_sw_te2';
    this.addConfigPrefix('SEAWORLDGOLDCOAST');
  }
}

/**
 * Warner Bros. Movie World - Gold Coast, Queensland, Australia
 */
@destinationController({category: ['TE2', 'Warner Bros Movie World']})
export class WarnerBrosMovieWorld extends TE2Destination {
  constructor(options?: DestinationConstructor) {
    super(options);
    this.destinationId = 'vrtp_mw_te2';
    this.addConfigPrefix('WARNERBROSMOVIEWORLD');
  }
}

/**
 * Paradise Country - Gold Coast, Queensland, Australia
 */
@destinationController({category: ['TE2', 'Paradise Country']})
export class ParadiseCountry extends TE2Destination {
  constructor(options?: DestinationConstructor) {
    super(options);
    this.destinationId = 'vrtp_pc_te2';
    this.addConfigPrefix('PARADISECOUNTRY');
  }
}

/**
 * Wet'n'Wild Gold Coast - Gold Coast, Queensland, Australia
 */
@destinationController({category: ['TE2', 'Wet\'n\'Wild Gold Coast']})
export class WetNWildGoldCoast extends TE2Destination {
  constructor(options?: DestinationConstructor) {
    super(options);
    this.destinationId = 'vrtp_ww_te2';
    this.addConfigPrefix('WETNWILDGOLDCOAST');
  }
}

export {TE2Destination};

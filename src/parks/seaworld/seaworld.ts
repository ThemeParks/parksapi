/**
 * SeaWorld / Busch Gardens Parks TypeScript Implementation
 *
 * Supports 5 destinations:
 *  - SeaWorld Orlando (SeaWorld + Aquatica)
 *  - SeaWorld San Antonio
 *  - SeaWorld San Diego
 *  - Busch Gardens Tampa
 *  - Busch Gardens Williamsburg
 *
 * API: https://public.api.seaworld.com/ (no auth required)
 */

import {Destination, type DestinationConstructor} from '../../destination.js';
import config from '../../config.js';
import {http, type HTTPObj} from '../../http.js';
import {cache} from '../../cache.js';
import {destinationController} from '../../destinationRegistry.js';
import type {Entity, LiveData, EntitySchedule} from '@themeparks/typelib';
import {localFromFakeUtc} from '../../datetime.js';

// ---------------------------------------------------------------------------
// API response types
// ---------------------------------------------------------------------------

type SeaworldPOIData = {
  Id: string;
  Name: string;
  Type: string;
  Coordinate?: {Latitude: number; Longitude: number};
  MinimumHeight?: string;
  ShowTimes?: unknown[];
};

type SeaworldParkDetail = {
  Id: string;
  park_Name: string;
  TimeZone: string;
  map_center?: {Latitude: number; Longitude: number};
  POIs: Record<string, SeaworldPOIData[]>;
  open_hours: Array<{
    opens_at: string;
    closes_at: string;
    date: string;
  }>;
};

type SeaworldAvailabilityResponse = {
  WaitTimes: Array<{
    Id: string;
    Minutes: number;
    Status: string;
    StatusDisplay: string | null;
    Title: string;
    LastUpDateTime: string;
  }>;
  ShowTimes: Array<{
    Id: string;
    ShowTimes: Array<{
      StartDateTime: string;
      EndDateTime: string;
      // Local time strings (no timezone suffix) — same value as StartDateTime/EndDateTime
      // minus the UTC offset.  The JS used StartTime/EndTime as local times.
      StartTime: string;
      EndTime: string;
    }>;
  }>;
};

// ---------------------------------------------------------------------------
// Base class shared by all SeaWorld/Busch Gardens destinations
// ---------------------------------------------------------------------------

/**
 * SeaworldDestination is a shared base class for all SeaWorld and Busch
 * Gardens destinations. Subclasses specify which park UUIDs (resortIds) to
 * include, their timezone, and their destinationId.
 */
@config
export class SeaworldDestination extends Destination {
  // -------------------------------------------------------------------------
  // Config properties (loaded from env vars with SEAWORLD_ prefix)
  // -------------------------------------------------------------------------

  @config
  baseURL: string = '';

  @config
  appVersion: string = 'android-7.1.17.117525';

  // The list of park UUIDs for this destination (set by subclasses)
  resortIds: string[] = [];

  // Human-readable destination name (set by subclasses)
  destinationName: string = '';

  // Canonical ID used for this destination's entity (set by subclasses)
  destinationId: string = '';

  // IANA timezone for this destination (set by subclasses)
  timezone: string = 'America/New_York';

  constructor(options?: DestinationConstructor) {
    super(options);
    this.addConfigPrefix('SEAWORLD');
  }

  // -------------------------------------------------------------------------
  // Cache key prefix — prevents cross-park cache collisions since all parks
  // share this base class and the same cached method names.
  // -------------------------------------------------------------------------
  getCacheKeyPrefix(): string {
    return `seaworld:${this.destinationId}`;
  }

  // -------------------------------------------------------------------------
  // HTTP fetch methods
  // -------------------------------------------------------------------------

  /**
   * Fetch detailed data for a single park UUID.
   * Cached for 12 hours — POIs and schedules rarely change.
   */
  @http({cacheSeconds: 12 * 60 * 60, retries: 2})
  async fetchParkDetail(parkId: string): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.baseURL}v1/park/${parkId}`,
      headers: {
        'user-agent': 'okhttp/4.12.0',
        'app_version': this.appVersion,
      },
      options: {json: true},
    } as any as HTTPObj;
  }

  /**
   * Fetch live availability data (wait times + show times) for a single park.
   * Cached for 1 minute.
   */
  @http({cacheSeconds: 60, retries: 2})
  async fetchAvailability(parkId: string, searchDate: string): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.baseURL}v1/park/${parkId}/availability/`,
      queryParams: {searchDate},
      headers: {
        'user-agent': 'okhttp/4.12.0',
        'app_version': this.appVersion,
      },
      options: {json: true},
    } as any as HTTPObj;
  }

  // -------------------------------------------------------------------------
  // Cached data retrieval methods
  // -------------------------------------------------------------------------

  /**
   * Get detailed park data for a single park UUID.
   */
  @cache({ttlSeconds: 12 * 60 * 60})
  async getParkDetail(parkId: string): Promise<SeaworldParkDetail> {
    const resp = await this.fetchParkDetail(parkId);
    return await resp.json();
  }

  /**
   * Get live availability for a single park UUID.
   */
  @cache({ttlSeconds: 60})
  async getAvailability(parkId: string, searchDate: string): Promise<SeaworldAvailabilityResponse> {
    const resp = await this.fetchAvailability(parkId, searchDate);
    return await resp.json();
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Collect all POIs from all groups in the park detail, filtered by the
   * supplied Type values.  The JS code iterates all groups because some POIs
   * can appear in the "wrong" group.
   */
  private getAllPoisOfTypes(
    parkDetail: SeaworldParkDetail,
    types: string[],
  ): SeaworldPOIData[] {
    const pois: SeaworldPOIData[] = [];
    for (const group of Object.values(parkDetail.POIs)) {
      for (const poi of group) {
        if (types.includes(poi.Type)) {
          pois.push(poi);
        }
      }
    }
    return pois;
  }

  /**
   * Return today's date string in YYYY-MM-DD format (used as searchDate).
   */
  private getTodayDateString(): string {
    return new Date().toISOString().slice(0, 10);
  }

  // -------------------------------------------------------------------------
  // Destination entity (optional override for custom names)
  // -------------------------------------------------------------------------

  async getDestinations(): Promise<Entity[]> {
    // Build location from the first park's map_center
    let location: {latitude: number; longitude: number} | undefined;
    if (this.resortIds.length > 0) {
      try {
        const firstPark = await this.getParkDetail(this.resortIds[0]);
        if (firstPark.map_center) {
          location = {
            latitude: firstPark.map_center.Latitude,
            longitude: firstPark.map_center.Longitude,
          };
        }
      } catch {
        // ignore — location is optional
      }
    }

    return [
      {
        id: this.destinationId,
        name: this.destinationName,
        entityType: 'DESTINATION',
        timezone: this.timezone,
        ...(location ? {location} : {}),
      } as Entity,
    ];
  }

  // -------------------------------------------------------------------------
  // Template Method: buildEntityList
  // -------------------------------------------------------------------------

  protected async buildEntityList(): Promise<Entity[]> {
    const entities: Entity[] = [];

    // Destination
    entities.push(...await this.getDestinations());

    // Parks, Attractions, Shows, Restaurants
    for (const parkId of this.resortIds) {
      const parkDetail = await this.getParkDetail(parkId);

      // --- PARK entity ---
      const parkEntity: Entity = {
        id: parkDetail.Id,
        name: parkDetail.park_Name,
        entityType: 'PARK',
        parentId: this.destinationId,
        destinationId: this.destinationId,
        timezone: this.timezone,
      };
      if (parkDetail.map_center) {
        parkEntity.location = {
          latitude: parkDetail.map_center.Latitude,
          longitude: parkDetail.map_center.Longitude,
        };
      }
      entities.push(parkEntity);

      // --- ATTRACTIONs (Rides + Slides) ---
      const rides = this.getAllPoisOfTypes(parkDetail, ['Rides', 'Slides']);
      for (const poi of rides) {
        const entity: Entity = {
          id: poi.Id,
          name: poi.Name,
          entityType: 'ATTRACTION',
          attractionType: 'RIDE',
          parentId: parkDetail.Id,
          destinationId: this.destinationId,
          timezone: this.timezone,
        };
        if (poi.Coordinate) {
          entity.location = {
            latitude: poi.Coordinate.Latitude,
            longitude: poi.Coordinate.Longitude,
          };
        }
        entities.push(entity);
      }

      // --- SHOWs ---
      const shows = this.getAllPoisOfTypes(parkDetail, ['Shows']);
      for (const poi of shows) {
        const entity: Entity = {
          id: poi.Id,
          name: poi.Name,
          entityType: 'SHOW',
          parentId: parkDetail.Id,
          destinationId: this.destinationId,
          timezone: this.timezone,
        };
        if (poi.Coordinate) {
          entity.location = {
            latitude: poi.Coordinate.Latitude,
            longitude: poi.Coordinate.Longitude,
          };
        }
        entities.push(entity);
      }

      // --- RESTAURANTs (Dining) ---
      const dining = this.getAllPoisOfTypes(parkDetail, ['Dining']);
      for (const poi of dining) {
        const entity: Entity = {
          id: poi.Id,
          name: poi.Name,
          entityType: 'RESTAURANT',
          parentId: parkDetail.Id,
          destinationId: this.destinationId,
          timezone: this.timezone,
        };
        if (poi.Coordinate) {
          entity.location = {
            latitude: poi.Coordinate.Latitude,
            longitude: poi.Coordinate.Longitude,
          };
        }
        entities.push(entity);
      }
    }

    return entities;
  }

  // -------------------------------------------------------------------------
  // Template Method: buildLiveData
  // -------------------------------------------------------------------------

  protected async buildLiveData(): Promise<LiveData[]> {
    const liveDataMap = new Map<string, LiveData>();
    const searchDate = this.getTodayDateString();

    const getOrCreate = (id: string): LiveData => {
      let entry = liveDataMap.get(id);
      if (!entry) {
        entry = {id, status: 'CLOSED'};
        liveDataMap.set(id, entry);
      }
      return entry;
    };

    for (const parkId of this.resortIds) {
      const availability = await this.getAvailability(parkId, searchDate);

      // --- Wait times ---
      for (const wt of (availability.WaitTimes || [])) {
        if (!wt.Id) continue;
        const entry = getOrCreate(wt.Id);

        if (wt.Minutes !== undefined) {
          if (wt.Minutes < 0) {
            // Negative minutes = closed (e.g. -1 = "Closed Temporarily")
            entry.status = 'CLOSED';
            entry.queue = {STANDBY: {waitTime: undefined}};
          } else {
            entry.status = 'OPERATING';
            entry.queue = {STANDBY: {waitTime: wt.Minutes}};
          }
        }
      }

      // --- Show times ---
      for (const st of (availability.ShowTimes || [])) {
        if (!st.Id) continue;
        const entry = getOrCreate(st.Id);

        if (st.ShowTimes && st.ShowTimes.length > 0) {
          entry.status = 'OPERATING';
          entry.showtimes = st.ShowTimes.map((time) => {
            // StartTime/EndTime are local datetime strings without a timezone
            // suffix (e.g. "2026-04-01T12:00:00").  Use constructDateTime to
            // attach the correct offset for this destination's timezone.
            const startLocal = localFromFakeUtc(time.StartTime, this.timezone);
            const endLocal = localFromFakeUtc(time.EndTime, this.timezone);
            return {
              startTime: startLocal,
              endTime: endLocal,
              type: 'Performance',
            };
          });
        }
      }
    }

    // Post-process: mark attractions with "Closed" in their name as
    // refurbishment if they have no live data yet (matches JS behaviour).
    try {
      const entities = await this.buildEntityList();
      const attractions = entities.filter(e => e.entityType === 'ATTRACTION');
      for (const attraction of attractions) {
        if (!liveDataMap.has(attraction.id)) {
          const name = typeof attraction.name === 'string'
            ? attraction.name
            : Object.values(attraction.name as Record<string, string>)[0] || '';
          if (name.includes('Closed')) {
            liveDataMap.set(attraction.id, {
              id: attraction.id,
              status: 'REFURBISHMENT',
            });
          }
        }
      }
    } catch {
      // ignore — entity list failure should not block live data
    }

    return Array.from(liveDataMap.values());
  }

  // -------------------------------------------------------------------------
  // Template Method: buildSchedules
  // -------------------------------------------------------------------------

  protected async buildSchedules(): Promise<EntitySchedule[]> {
    const schedules: EntitySchedule[] = [];

    for (const parkId of this.resortIds) {
      const parkDetail = await this.getParkDetail(parkId);
      if (!parkDetail.open_hours || parkDetail.open_hours.length === 0) continue;

      // On event days the API returns a second open_hours block for the SAME
      // date — the park's daytime session (e.g. 9:00–19:30) plus a separate
      // ticketed event (evening "summer nights" 20:00–23:00, a pre-opening
      // early-entry event, or an overnight event). The blocks are type-less, so
      // emitting them all as OPERATING makes the event masquerade as (or
      // overwrite) the normal operating hours. There is no event flag on the
      // hours entries and the /events endpoint is a noisy mixed list (festivals,
      // shows, private events) that doesn't reliably map to a block — so classify
      // by time of day: the block overlapping core midday IS the operating
      // session; every other same-date block is a TICKETED_EVENT. Robust to
      // events that open before OR after normal hours (unlike "earliest block").
      const byDate = new Map<string, Array<{openingTime: string; closingTime: string}>>();
      for (const oh of parkDetail.open_hours) {
        const openingTime = localFromFakeUtc(oh.opens_at, this.timezone);
        const closingTime = localFromFakeUtc(oh.closes_at, this.timezone);
        const date = openingTime.slice(0, 10);
        const entries = byDate.get(date);
        if (entries) entries.push({openingTime, closingTime});
        else byDate.set(date, [{openingTime, closingTime}]);
      }

      // Local minutes-since-midnight from a "…THH:MM…" ISO string.
      const minsOfDay = (iso: string) =>
        parseInt(iso.slice(11, 13), 10) * 60 + parseInt(iso.slice(14, 16), 10);
      const MIDDAY_START = 12 * 60; // 12:00 local
      const MIDDAY_END = 16 * 60; //   16:00 local

      const schedule = [];
      for (const [date, entries] of byDate) {
        const spans = entries.map((e) => {
          const open = minsOfDay(e.openingTime);
          // Next-day close (crosses midnight) rolls the close minutes past 24h.
          const close =
            minsOfDay(e.closingTime) + (e.closingTime.slice(0, 10) > date ? 24 * 60 : 0);
          return {...e, open, close};
        });
        // Operating session = block(s) overlapping the midday window. Events
        // (early-morning, evening, overnight) don't reach it. Fall back to the
        // longest block if none overlaps (e.g. an evening-event-only day) so a
        // day never loses its operating hours entirely.
        let operating = spans.filter((s) => s.open < MIDDAY_END && s.close > MIDDAY_START);
        if (operating.length === 0 && spans.length > 0) {
          operating = [spans.reduce((a, b) => (b.close - b.open > a.close - a.open ? b : a))];
        }
        const operatingSet = new Set(operating);
        for (const s of spans) {
          schedule.push({
            date,
            openingTime: s.openingTime,
            closingTime: s.closingTime,
            type: operatingSet.has(s) ? ('OPERATING' as const) : ('TICKETED_EVENT' as const),
          });
        }
      }

      schedules.push({
        id: parkDetail.Id,
        schedule,
      });
    }

    return schedules;
  }
}

// ---------------------------------------------------------------------------
// Concrete destination classes
// ---------------------------------------------------------------------------

/**
 * SeaWorld Parks and Resorts Orlando
 * Includes: SeaWorld Orlando + Aquatica Orlando
 */
@destinationController({category: 'SeaWorld'})
export class SeaworldOrlando extends SeaworldDestination {
  constructor(options?: DestinationConstructor) {
    super(options);
    this.resortIds = [
      'AC3AF402-3C62-4893-8B05-822F19B9D2BC', // SeaWorld Orlando
      '4B040706-968A-41B4-9967-D93C7814E665', // Aquatica Orlando
    ];
    this.timezone = 'America/New_York';
    this.destinationName = 'SeaWorld Parks and Resorts Orlando';
    this.destinationId = 'seaworldorlandoresort';
  }
}

/**
 * SeaWorld San Antonio
 */
@destinationController({category: 'SeaWorld'})
export class SeaworldSanAntonio extends SeaworldDestination {
  constructor(options?: DestinationConstructor) {
    super(options);
    this.resortIds = [
      'F4040D22-8B8D-4394-AEC7-D05FA5DEA945',
    ];
    this.timezone = 'America/Chicago';
    this.destinationName = 'SeaWorld San Antonio';
    this.destinationId = 'seaworldsanantonio';
  }
}

/**
 * SeaWorld San Diego
 */
@destinationController({category: 'SeaWorld'})
export class SeaworldSanDiego extends SeaworldDestination {
  constructor(options?: DestinationConstructor) {
    super(options);
    this.resortIds = [
      '4325312F-FDF1-41FF-ABF4-361A4FF03443',
    ];
    this.timezone = 'America/Los_Angeles';
    this.destinationName = 'SeaWorld San Diego';
    this.destinationId = 'seaworldsandiego';
  }
}

/**
 * Busch Gardens Tampa
 */
@destinationController({category: 'Busch Gardens'})
export class BuschGardensTampa extends SeaworldDestination {
  constructor(options?: DestinationConstructor) {
    super(options);
    this.resortIds = [
      'C001866B-555D-4E92-B48E-CC67E195DE96',
    ];
    this.timezone = 'America/New_York';
    this.destinationName = 'Busch Gardens Tampa';
    this.destinationId = 'buschgardenstampa';
  }
}

/**
 * Busch Gardens Williamsburg
 * Note: destinationId preserves legacy typo "willamsburg" (one 'l') for
 * backwards compatibility with the JS implementation.
 */
@destinationController({category: 'Busch Gardens'})
export class BuschGardensWilliamsburg extends SeaworldDestination {
  constructor(options?: DestinationConstructor) {
    super(options);
    this.resortIds = [
      '45FE1F31-D4E4-4B1E-90E0-5255111070F2',
    ];
    this.timezone = 'America/New_York';
    this.destinationName = 'Busch Gardens Williamsburg';
    this.destinationId = 'buschgardenswillamsburg';
  }
}

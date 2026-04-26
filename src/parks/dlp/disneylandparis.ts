import {Destination, DestinationConstructor} from '../../destination.js';
import crypto from 'crypto';

import {cache, CacheLib} from '../../cache.js';
import {http, HTTPObj} from '../../http.js';
import {inject} from '../../injector.js';
import config from '../../config.js';
import {destinationController} from '../../destinationRegistry.js';
import {
  Entity,
  LiveData,
  EntitySchedule,
  LanguageCode,
} from '@themeparks/typelib';
import {formatInTimezone, addDays, constructDateTime} from '../../datetime.js';
import {TagBuilder} from '../../tags/index.js';

// ============================================================================
// Constants
// ============================================================================

/** Entities to ignore entirely */
const IGNORE_ENTITIES = new Set([
  '00000',
  'P1NA18',
  'test2',
  'P2AC00-REMOVED',
  'P2AC00',
  'armageddon',
]);

/** Entities that bypass visibility/hide rules */
const VISIBILITY_EXCEPTIONS = new Set([
  'P2EA00', // Frozen Ever After
  'P2DA00', // Tangled Spin
  'P2EA02', // Entry to World of Frozen
]);

/** Hide rules that exclude entities from the POI list */
const HIDE_RULES = new Set([
  'Hide from Web List + Mobile App',
  'Hide from the Service',
  'Hide from Mobile App',
]);

/** Entertainment subtypes that map to SHOW entity type */
const SHOW_SUBTYPES = new Set([
  'Stage Show',
  'Fireworks',
  'Atmosphere',
  'Parade',
]);

/**
 * DLP’s mobile app lists some map walkthroughs / placemarks as
 * `Attraction` in GraphQL, but they are not in the wait-time product; the
 * REST wait feed has no (or null) rows for them. We exclude their IDs from
 * queue live data and the attraction STANDBY baseline so ParksAPI does not
 * synthesize a misleading `CLOSED` with `STANDBY: null` for a non-queue POI.
 */
const dlpMapOnlyNonQueueAttractionIdSet = new Set(
  [
    '7d90d4e6-8c15-44ee-9e94-feb07788f02f', // Discovery Arcade
    'a61aeee6-bed5-4890-8209-5249e689b1a1', // Liberty Arcade
    '38bafc85-cb48-488e-aa68-3e2d01ae6a10', // La Galerie de la Belle au Bois
    '6bb88973-80d0-45cf-bffe-433f1c551362', // Horsedrawn Streetcars
    'a620015d-091d-4f82-b8b2-a97bc8641f07', // Sleeping Beauty Castle
  ].map((id) => id.toLowerCase()),
);

/** IDs of map-only DLP “attractions” with no queue product (for tests / enumeration). */
export const DLP_NON_QUEUE_STANDALONE_ATTRACTION_IDS: ReadonlySet<string> =
  dlpMapOnlyNonQueueAttractionIdSet;

/**
 * @returns `false` for the {@link DLP_NON_QUEUE_STANDALONE_ATTRACTION_IDS}
 *   when the POI is an `Attraction` (so those rows do not receive queue
 *   live data). All other categories are unchanged.
 */
export function dlpPoiEmitsQueueLiveData(poi: {category: string; id: string}): boolean {
  if (poi.category !== 'Attraction') return true;
  return !dlpMapOnlyNonQueueAttractionIdSet.has(poi.id.toLowerCase());
}

function dlpPoiIdIsMapOnlyNonQueueAttractionId(entityId: string): boolean {
  return dlpMapOnlyNonQueueAttractionIdSet.has(entityId.toLowerCase());
}

/**
 * Internal key for DLP `LiveData` maps and cross-feed joins: REST, PA, and
 * schedule rows sometimes use different casing for the same UUID as GraphQL
 * `activities.id` — this prevents duplicate rows or `getOrCreate` misses.
 */
function dlpLiveDataEntityIdKey(id: string): string {
  return id.toLowerCase();
}

// ============================================================================
// Types
// ============================================================================

type DLPCoordinate = {
  lat: number;
  lng: number;
  type?: string;
};

type DLPScheduleEntry = {
  language?: string;
  date: string;
  startTime: string;
  endTime: string;
  status: string;
  closed?: boolean;
};

type DLPPOIEntity = {
  id: string;
  name: string;
  type: string; // __typename: 'Attraction', 'Entertainment', etc.
  hideFunctionality?: string;
  location?: { id: string; value?: string };
  coordinates?: DLPCoordinate[];
  schedules?: DLPScheduleEntry[];
  subType?: string;
  // Extended fields from detailed queries
  height?: Array<{ id: string; value: string; iconFont?: string }>;
  minimumHeight?: string;
  physicalConsiderations?: Array<{ id: string }>;
  interests?: Array<{ id: string }>;
  duration?: { hours?: number; minutes?: number };
};

type DLPWaitTimeEntry = {
  entityId: string;
  type: string;
  status: string | null;
  // API returns numeric strings ("5", "40"); coerce via parseDLPWait before use.
  postedWaitMinutes: string | number | null;
  singleRider?: {
    isAvailable: boolean;
    singleRiderWaitMinutes?: string | number;
  };
};

function parseDLPWait(v: unknown): number | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Parse a DLP API timestamp like `2026-04-25T21:35:00.000+0200` into a Date.
 * Returns null for empty/invalid input. The non-canonical offset format
 * (`+0200` without a colon) is accepted by V8 but is not RFC 3339 — guard
 * against runtimes that reject it by falling back to null rather than
 * emitting an Invalid Date through the queue helpers.
 */
function parseDLPDate(v: string | null | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
}

type DLPPremierAccessEntry = {
  attractionId: string;
  available: boolean;
  nextTimeSlotStartDateTime?: string;
  nextTimeSlotEndDateTime?: string;
  price?: number;
};

type DLPVQueueWave = {
  waveId: string;
  name?: string;
  openAt?: string | null;
  closedAt?: string | null;
  status?: string;
};

type DLPVQueueEntry = {
  queueId: string;
  enabled: boolean;
  queueContentId: string;
  activityId: string;
  nextWaveId?: string;
  waves?: DLPVQueueWave[];
};

type DLPVQueueResponse = {
  queues?: DLPVQueueEntry[];
};

type DLPScheduleActivityEntry = {
  id: string;
  name?: string;
  subType?: string;
  schedules?: DLPScheduleEntry[];
  location?: { id: string; value?: string };
};

// ============================================================================
// Destination Implementation
// ============================================================================

@destinationController({category: 'Disney'})
export class DisneylandParis extends Destination {
  @config
  apiBase: string = '';

  @config
  apiKey: string = '';

  @config
  apiBaseWaitTimes: string = '';

  @config
  premierAccessUrl: string = '';

  @config
  premierAccessApiKey: string = '';

  /**
   * Free standby virtual-queue endpoint base.
   *
   * The API is scoped per "activity" — a meta-grouping of VQ-enabled
   * attractions (e.g. meet & greets share one activity). The activity
   * names are stable but not discoverable programmatically; configure
   * via DLP_VQUEUEACTIVITIES (comma-separated). When empty, VQ fetching
   * is a no-op.
   */
  @config
  vqueueApiBase: string = '';

  @config
  vqueueApiKey: string = '';

  @config
  vqueueActivities: string = '';

  @config
  language: LanguageCode = 'en-gb' as LanguageCode;

  @config
  timezone: string = 'Europe/Paris';

  /** Cache of show entities with duration data (populated during entity building) */
  private showDurationMap: Map<string, number> = new Map();

  constructor(options?: DestinationConstructor) {
    super(options);
    this.addConfigPrefix('DLP');
  }

  /**
   * All cache entries are namespaced under the class name so
   * `CacheLib.clearByClassName('DisneylandParis')` (used by the test
   * harness `--clear-cache`) sweeps everything for this destination,
   * including methods that opt into a stable named cache key like the
   * `dlp:get*` keys below.
   */
  getCacheKeyPrefix(): string {
    return 'DisneylandParis';
  }

  // ===== Header Injection =====

  /**
   * Inject headers into GraphQL API requests
   */
  @inject({
    eventName: 'httpRequest',
    hostname: function () {
      if (!this.apiBase) return '__noop__';
      return new URL(this.apiBase).hostname;
    },
  })
  async injectGraphQLHeaders(requestObj: HTTPObj): Promise<void> {
    requestObj.headers = {
      ...requestObj.headers,
      'x-application-id': 'mobile-app',
      'x-request-id': crypto.randomUUID(),
    };
  }

  /**
   * Inject headers into wait time API requests
   */
  @inject({
    eventName: 'httpRequest',
    hostname: function () {
      if (!this.apiBaseWaitTimes) return '__noop__';
      return new URL(this.apiBaseWaitTimes).hostname;
    },
  })
  async injectWaitTimeHeaders(requestObj: HTTPObj): Promise<void> {
    requestObj.headers = {
      ...requestObj.headers,
      'x-api-key': this.apiKey,
      'accept': 'application/json',
    };
  }

  /**
   * Inject headers into premier access API requests
   */
  @inject({
    eventName: 'httpRequest',
    hostname: function () {
      if (!this.premierAccessUrl) return '__noop__';
      return new URL(this.premierAccessUrl).hostname;
    },
    tags: {$in: ['premierAccess']},
  })
  async injectPremierAccessHeaders(requestObj: HTTPObj): Promise<void> {
    requestObj.headers = {
      ...requestObj.headers,
      'x-api-key': this.premierAccessApiKey,
      'accept': 'application/json',
    };
  }

  /**
   * Inject headers into virtual-queue API requests
   */
  @inject({
    eventName: 'httpRequest',
    hostname: function () {
      if (!this.vqueueApiBase) return '__noop__';
      return new URL(this.vqueueApiBase).hostname;
    },
    tags: {$in: ['vqueue']},
  })
  async injectVQueueHeaders(requestObj: HTTPObj): Promise<void> {
    requestObj.headers = {
      ...requestObj.headers,
      'x-api-key': this.vqueueApiKey,
      'accept': 'application/json, text/plain, */*',
    };
  }

  // ===== HTTP Fetch Methods =====

  /**
   * GraphQL query fields shared across entity queries
   */
  private get entityFields(): string {
    return `id
    name
    type: __typename
    hideFunctionality
    location {
      id
      value
    }
    coordinates {
      lat
      lng
      type
    }
    schedules {
      language
      date
      startTime
      endTime
      status
      closed
    }
    subType`;
  }

  /**
   * Fetch all POI data via GraphQL
   */
  @http({cacheSeconds: 43200})
  async fetchPOI(): Promise<HTTPObj> {
    return {
      method: 'POST',
      url: `${this.apiBase}/query`,
      body: {
        query: `query activities($market: String!) {
          Attraction: activities(market: $market, types: "Attraction") {
            ${this.entityFields}
          }
          DiningEvent: activities(market: $market, types: "DiningEvent") {
            ${this.entityFields}
          }
          DinnerShow: activities(market: $market, types: "DinnerShow") {
            ${this.entityFields}
          }
          Entertainment: activities(market: $market, types: "Entertainment") {
            ${this.entityFields}
          }
          Event: activities(market: $market, types: "Event") {
            ${this.entityFields}
          }
          GuestService: activities(market: $market, types: "GuestService") {
            ${this.entityFields}
          }
          Recreation: activities(market: $market, types: "Recreation") {
            ${this.entityFields}
          }
          Resort: activities(market: $market, types: "Resort") {
            ${this.entityFields}
          }
          Restaurant: activities(market: $market, types: "Restaurant") {
            ${this.entityFields}
          }
          Shop: activities(market: $market, types: "Shop") {
            ${this.entityFields}
          }
          Spa: activities(market: $market, types: "Spa") {
            ${this.entityFields}
          }
          Tour: activities(market: $market, types: "Tour") {
            ${this.entityFields}
          }
          ThemePark: activities(market: $market, types: "ThemePark") {
            ${this.entityFields}
          }
        }`,
        variables: {
          market: this.language,
        },
      },
      options: {json: true},
    } as any as HTTPObj;
  }

  /**
   * Get POI data (cached 12h)
   */
  @cache({ttlSeconds: 43200, cacheVersion: 2})
  async getPOIData(): Promise<Record<string, DLPPOIEntity[]>> {
    const resp = await this.fetchPOI();
    const data = await resp.json();
    return data?.data || {};
  }

  /**
   * Fetch schedule data for a specific date via GraphQL
   */
  @http({cacheSeconds: 86400, healthCheckArgs: ['{today}']})
  async fetchScheduleForDate(date: string): Promise<HTTPObj> {
    return {
      method: 'POST',
      url: `${this.apiBase}/query`,
      body: {
        query: `query activitySchedules($market: String!, $types: [ActivityScheduleStatusInput]!, $date: String!) {
          activitySchedules(market: $market, date: $date, types: $types) {
            __typename
            id
            name
            subType
            hideFunctionality
            location {
              id
              value
            }
            schedules(date: $date, types: $types) {
              startTime
              endTime
              date
              status
              closed
              language
            }
          }
        }`,
        variables: {
          market: 'en-gb',
          types: [
            {type: 'ThemePark', status: ['OPERATING', 'EXTRA_MAGIC_HOURS']},
            {type: 'Attraction', status: ['OPERATING', 'REFURBISHMENT', 'CLOSED']},
            {type: 'Entertainment', status: ['PERFORMANCE_TIME']},
            {type: 'Resort', status: ['OPERATING', 'REFURBISHMENT', 'CLOSED']},
            {type: 'Shop', status: ['REFURBISHMENT', 'CLOSED']},
            {type: 'Restaurant', status: ['REFURBISHMENT', 'CLOSED', 'OPERATING']},
            {type: 'DiningEvent', status: ['REFURBISHMENT', 'CLOSED']},
            {type: 'DinnerShow', status: ['REFURBISHMENT', 'CLOSED']},
          ],
          date,
        },
      },
      options: {json: true},
    } as any as HTTPObj;
  }

  /**
   * Get schedule data for a date (cached 24h per date)
   */
  @cache({ttlSeconds: 86400})
  async getScheduleForDate(date: string): Promise<DLPScheduleActivityEntry[]> {
    const resp = await this.fetchScheduleForDate(date);
    const data = await resp.json();
    return data?.data?.activitySchedules || [];
  }

  // ── Live-data cache keys ─────────────────────────────────────────────
  //
  // Each parsed live-data getter below has a stable named cache key so a
  // caller can invalidate it deterministically with `CacheLib.delete(key)`
  // to force a fresh fetch outside the normal 60s TTL. This is useful for
  // time-sensitive moments like a Virtual Queue or Premier Access slot
  // release where the consumer needs sub-TTL latency.
  //
  //   dlp:getWaitTimes          — parsed waittimes
  //   dlp:getPremierAccess      — parsed Premier Access slots
  //   dlp:getVirtualQueueData   — aggregated VQ data across all activities
  //
  // The lower fetch* methods are NOT cached at the HTTP layer; the @cache
  // wrapper above them is the single source of truth, so invalidating the
  // key above guarantees the next call hits the network.

  /**
   * Fetch wait time data from REST API
   */
  @http()
  async fetchWaitTimes(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.apiBaseWaitTimes}waitTimes`,
      options: {json: true},
    } as any as HTTPObj;
  }

  /**
   * Get wait times (cached 1min)
   */
  @cache({ttlSeconds: 60, key: 'dlp:getWaitTimes'})
  async getWaitTimes(): Promise<DLPWaitTimeEntry[]> {
    const resp = await this.fetchWaitTimes();
    const data = await resp.json();
    return Array.isArray(data) ? data : [];
  }

  /**
   * Fetch premier access data
   */
  @http()
  async fetchPremierAccess(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: this.premierAccessUrl,
      options: {json: true},
      tags: ['premierAccess'],
    } as any as HTTPObj;
  }

  /**
   * Get premier access data (cached 1min)
   * Returns empty array if premierAccessApiKey is not configured
   */
  @cache({ttlSeconds: 60, key: 'dlp:getPremierAccess'})
  async getPremierAccess(): Promise<DLPPremierAccessEntry[]> {
    if (!this.premierAccessApiKey) {
      return [];
    }
    try {
      const resp = await this.fetchPremierAccess();
      const data = await resp.json();
      return Array.isArray(data) ? data : [];
    } catch (e) {
      console.error(`[DLP] Error fetching premier access data: ${e}`);
      return [];
    }
  }

  /** Fetch a single activity's virtual-queue state. */
  @http()
  async fetchVQueueActivity(activityId: string): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.vqueueApiBase}/activities/${activityId}/queues`,
      options: {json: true},
      tags: ['vqueue'],
    } as any as HTTPObj;
  }

  /**
   * Aggregate VQ data across every configured activity into a flat list.
   * Activities are listed via `vqueueActivities` (comma-separated). Returns
   * an empty array if the feature is unconfigured, so callers can always
   * dereference.
   */
  @cache({ttlSeconds: 60, key: 'dlp:getVirtualQueueData'})
  async getVirtualQueueData(): Promise<DLPVQueueEntry[]> {
    if (!this.vqueueApiBase || !this.vqueueApiKey || !this.vqueueActivities) {
      return [];
    }
    const activities = this.vqueueActivities
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (activities.length === 0) return [];

    const results: DLPVQueueEntry[] = [];
    await Promise.all(
      activities.map(async (activity) => {
        try {
          const resp = await this.fetchVQueueActivity(activity);
          const data = (await resp.json()) as DLPVQueueResponse;
          if (Array.isArray(data?.queues)) {
            results.push(...data.queues);
          }
        } catch (e) {
          console.error(`[DLP] Error fetching vqueue activity ${activity}: ${e}`);
        }
      }),
    );
    return results;
  }

  // ===== Helper Methods =====

  /**
   * Flatten all POI categories into a single array with category tag
   */
  private flattenPOI(poiData: Record<string, DLPPOIEntity[]>): Array<DLPPOIEntity & {category: string}> {
    const result: Array<DLPPOIEntity & {category: string}> = [];
    for (const [category, entities] of Object.entries(poiData)) {
      if (!Array.isArray(entities)) continue;
      for (const entity of entities) {
        result.push({...entity, category});
      }
    }
    return result;
  }

  /**
   * Filter POI entities to only include those in P1 or P2 parks,
   * excluding hidden and ignored entities.
   */
  private filterPOIEntities(entities: Array<DLPPOIEntity & {category: string}>): Array<DLPPOIEntity & {category: string}> {
    return entities.filter((entity) => {
      // Must be in a park (P1 or P2)
      const parkId = entity.location?.id;
      if (parkId !== 'P1' && parkId !== 'P2') return false;

      // Skip ignored entities
      if (IGNORE_ENTITIES.has(entity.id)) return false;

      // Visibility exceptions bypass hide rules
      if (VISIBILITY_EXCEPTIONS.has(entity.id)) return true;

      // Filter hidden entities
      if (entity.hideFunctionality && HIDE_RULES.has(entity.hideFunctionality)) return false;

      return true;
    });
  }

  /**
   * Get preferred coordinates from entity data.
   * Prefers "Guest Entrance" type if available.
   */
  private getCoordinates(entity: DLPPOIEntity): {lat: number; lng: number} | undefined {
    if (!entity.coordinates || entity.coordinates.length === 0) return undefined;

    const entrance = entity.coordinates.find((c) => c.type === 'Guest Entrance');
    if (entrance) return {lat: entrance.lat, lng: entrance.lng};

    // Fall back to first coordinate
    return {lat: entity.coordinates[0].lat, lng: entity.coordinates[0].lng};
  }

  /**
   * Parse height string into centimeters.
   * Handles "1.2 m" -> 120, "102 cm" -> 102
   */
  private parseHeightCm(heightStr: string): number | undefined {
    const match = /([\d.]+)\s*(\w+)/.exec(heightStr);
    if (!match) return undefined;

    const value = parseFloat(match[1]);
    const unit = match[2].toLowerCase();

    if (unit === 'm') return Math.round(value * 100);
    if (unit === 'cm') return Math.round(value);

    return undefined;
  }

  /**
   * Map DLP entity type to our entity type
   */
  private mapEntityType(entity: DLPPOIEntity & {category: string}): Entity['entityType'] | undefined {
    if (entity.category === 'Attraction') return 'ATTRACTION';
    if (entity.category === 'Restaurant') return 'RESTAURANT';
    if (entity.category === 'Entertainment') {
      if (entity.subType && SHOW_SUBTYPES.has(entity.subType)) return 'SHOW';
      return undefined; // Non-show entertainment filtered out
    }
    return undefined;
  }

  /**
   * Resolve POI down to the entities we actually emit. Shared by
   * buildEntityList and buildLiveData so the wait-times / premier-access /
   * vqueue / showtimes paths can't surface IDs that fall outside the
   * published POI set.
   */
  private async getEmittablePOIEntities(): Promise<Array<DLPPOIEntity & {category: string}>> {
    const poiData = await this.getPOIData();
    const allEntities = this.flattenPOI(poiData);
    return this.filterPOIEntities(allEntities).filter((poi) => this.mapEntityType(poi) !== undefined);
  }

  /**
   * Map DLP wait time status to our status
   */
  private mapStatus(status: string | null): string {
    if (!status) return 'CLOSED';
    switch (status) {
      case 'DOWN': return 'DOWN';
      case 'REFURBISHMENT': return 'CLOSED'; // DLP treats refurb as closed
      case 'CLOSED': return 'CLOSED';
      default: return 'OPERATING'; // Includes 'OPERATING' and any other active status
    }
  }

  // ===== Data Builder Methods =====

  async getDestinations(): Promise<Entity[]> {
    return [{
      id: 'dlp',
      name: 'Disneyland Paris',
      entityType: 'DESTINATION',
      timezone: this.timezone,
      location: {latitude: 48.868720, longitude: 2.781826},
    } as Entity];
  }

  protected async buildEntityList(): Promise<Entity[]> {
    const poiData = await this.getPOIData();
    const allEntities = this.flattenPOI(poiData);
    const filteredEntities = this.filterPOIEntities(allEntities);

    const destinationId = 'dlp';

    // Build park entities from ThemePark type
    const parks = allEntities.filter((e) => e.category === 'ThemePark');

    // Inject P2 manually if missing (DLP API sometimes drops it)
    if (!parks.find((p) => p.id === 'P2')) {
      parks.push({
        id: 'P2',
        name: 'Walt Disney Studios Park',
        type: 'ThemePark',
        category: 'ThemePark',
        coordinates: [{lat: 48.868391, lng: 2.780802, type: 'Guest Entrance'}],
      } as DLPPOIEntity & {category: string});
    }

    const parkEntities = this.mapEntities(parks, {
      idField: 'id',
      nameField: 'name',
      entityType: 'PARK',
      parentIdField: () => destinationId,
      destinationId,
      timezone: this.timezone,
      locationFields: {
        lat: (item) => this.getCoordinates(item)?.lat,
        lng: (item) => this.getCoordinates(item)?.lng,
      },
    });

    // Clear show duration map (rebuilt each time)
    this.showDurationMap.clear();

    // Build attraction, show, and restaurant entities
    const entityEntries: Entity[] = [];
    for (const poi of filteredEntities) {
      const entityType = this.mapEntityType(poi);
      if (!entityType) continue;

      const coords = this.getCoordinates(poi);

      const entity: Entity = {
        id: poi.id,
        name: poi.name,
        entityType,
        parentId: poi.location?.id || 'P1',
        destinationId,
        timezone: this.timezone,
      } as Entity;

      if (coords) {
        entity.location = {latitude: coords.lat, longitude: coords.lng};
      }

      // Build tags
      const tags: any[] = [];

      // Height restriction
      if (poi.minimumHeight) {
        const heightCm = this.parseHeightCm(poi.minimumHeight);
        if (heightCm && heightCm > 0) {
          tags.push(TagBuilder.minimumHeight(heightCm, 'cm'));
        }
      }
      // Also check height array (older format)
      if (poi.height) {
        for (const h of poi.height) {
          if (h.id === 'anyHeight') continue;
          const heightCm = this.parseHeightCm(h.value);
          if (heightCm && heightCm > 0) {
            tags.push(TagBuilder.minimumHeight(heightCm, 'cm'));
            break; // Only one height tag
          }
        }
      }

      // Pregnancy
      if (poi.physicalConsiderations?.some((c) => c.id === 'expectantMothersMayNotRide')) {
        tags.push(TagBuilder.unsuitableForPregnantPeople());
      }

      entity.tags = tags.filter(Boolean);

      // Store show duration for live data
      if (entityType === 'SHOW' && poi.duration) {
        const durationMinutes = (poi.duration.minutes || 0) + ((poi.duration.hours || 0) * 60);
        if (durationMinutes > 0) {
          this.showDurationMap.set(poi.id, durationMinutes);
        }
      }

      entityEntries.push(entity);
    }

    return [
      ...await this.getDestinations(),
      ...parkEntities,
      ...entityEntries,
    ];
  }

  protected async buildLiveData(): Promise<LiveData[]> {
    const liveData: LiveData[] = [];
    /** Map keys are {@link dlpLiveDataEntityIdKey} (lowercased), matching entity id from `buildEntityList`. */
    const liveDataMap = new Map<string, LiveData>();

    const emittablePois = await this.getEmittablePOIEntities();
    const queueLiveDataPois = emittablePois.filter((poi) => dlpPoiEmitsQueueLiveData(poi));
    // One canonical `LiveData.id` per entity (GraphQL/POI casing). Wait/PA/schedule
    // feeds may use different casing; we key maps by lowercase to merge correctly.
    const canonicalEntityIdByKey = new Map<string, string>();
    for (const poi of queueLiveDataPois) {
      const key = dlpLiveDataEntityIdKey(poi.id);
      if (!canonicalEntityIdByKey.has(key)) {
        canonicalEntityIdByKey.set(key, poi.id);
      }
    }

    // Same issue as `LiveData` ids: show duration is keyed in `showDurationMap`
    // by `buildEntityList`’s `poi.id` — look up with a case-insensitive key
    // so schedule `sched.id` still finds duration if casing differs.
    const showDurationByKey = new Map<string, number>();
    for (const [entityId, minutes] of this.showDurationMap) {
      const key = dlpLiveDataEntityIdKey(entityId);
      if (!showDurationByKey.has(key)) showDurationByKey.set(key, minutes);
    }

    const getOrCreate = (rawId: string | null | undefined): LiveData | undefined => {
      if (rawId == null || rawId === '') return undefined;
      const key = dlpLiveDataEntityIdKey(rawId);
      const canonicalId = canonicalEntityIdByKey.get(key);
      if (canonicalId === undefined) return undefined;
      let entry = liveDataMap.get(key);
      if (!entry) {
        entry = {id: canonicalId, status: 'CLOSED'} as LiveData;
        liveDataMap.set(key, entry);
        liveData.push(entry);
      }
      return entry;
    };

    // === Wait Times ===
    const waitTimes = await this.getWaitTimes();

    for (const wt of waitTimes) {
      if (!wt.entityId || wt.type !== 'Attraction') continue;
      if (IGNORE_ENTITIES.has(wt.entityId)) continue;

      const ld = getOrCreate(wt.entityId);
      if (!ld) continue;
      ld.status = this.mapStatus(wt.status) as any;

      // Standby queue
      if (!ld.queue) ld.queue = {};
      ld.queue.STANDBY = {
        waitTime: ld.status === 'OPERATING' ? (parseDLPWait(wt.postedWaitMinutes) ?? null) : null,
      };

      // Single rider
      if (wt.singleRider?.isAvailable === true) {
        ld.queue.SINGLE_RIDER = {
          waitTime: ld.status === 'OPERATING'
            ? (parseDLPWait(wt.singleRider.singleRiderWaitMinutes) ?? null)
            : null,
        };
      }
    }

    // === Premier Access (paid return time) ===
    const premierAccess = await this.getPremierAccess();

    for (const pa of premierAccess) {
      if (!pa.attractionId) continue;

      const ld = getOrCreate(pa.attractionId);
      if (!ld) continue;
      if (!ld.queue) ld.queue = {};

      // DLP emits `2026-04-25T21:35:00.000+0200` (millis, no offset colon).
      // Wrap in Date so the framework re-emits the canonical
      // `2026-04-25T21:35:00+02:00` form rather than passing through verbatim.
      ld.queue.PAID_RETURN_TIME = this.buildPaidReturnTimeQueue(
        pa.available ? 'AVAILABLE' : 'FINISHED',
        parseDLPDate(pa.nextTimeSlotStartDateTime),
        parseDLPDate(pa.nextTimeSlotEndDateTime),
        'EUR',
        pa.price != null ? Math.round(pa.price * 100) : null,
      );
    }

    // === Virtual Queue (free return time) ===
    // Each queue's waves array is ordered chronologically by openAt; the
    // next wave that still has capacity is the one to surface. If all
    // waves have status FINISHED, the queue's done for the day.
    const vqueueData = await this.getVirtualQueueData();
    for (const q of vqueueData) {
      if (!q.queueContentId || q.enabled === false) continue;
      const waves = q.waves ?? [];
      if (waves.length === 0) continue;

      const activeWave =
        (q.nextWaveId && waves.find((w) => w.waveId === q.nextWaveId)) ||
        waves.find((w) => (w.status || '').toUpperCase() !== 'FINISHED');

      const allFinished = waves.every(
        (w) => (w.status || '').toUpperCase() === 'FINISHED',
      );

      const ld = getOrCreate(q.queueContentId);
      if (!ld) continue;
      if (!ld.queue) ld.queue = {};

      if (allFinished || !activeWave) {
        ld.queue.RETURN_TIME = this.buildReturnTimeQueue('FINISHED', null, null);
      } else {
        // Wave statuses observed: CLOSED (scheduled, not yet open), FINISHED,
        // and presumably OPEN/AVAILABLE when actively booking. Anything
        // non-FINISHED surfaces as AVAILABLE with the wave's window so the
        // wiki can render the upcoming slot.
        ld.queue.RETURN_TIME = this.buildReturnTimeQueue(
          'AVAILABLE',
          parseDLPDate(activeWave.openAt ?? null),
          parseDLPDate(activeWave.closedAt ?? null),
        );
      }
    }

    // === Show Times (from today's schedule) ===
    const today = formatInTimezone(new Date(), this.timezone, 'date');
    // formatInTimezone 'date' returns MM/DD/YYYY, convert to YYYY-MM-DD
    const [mm, dd, yyyy] = today.split('/');
    const todayStr = `${yyyy}-${mm}-${dd}`;

    try {
      const scheduleData = await this.getScheduleForDate(todayStr);

      for (const sched of scheduleData) {
        if (!sched.schedules) continue;

        const performances = sched.schedules.filter((s) => s.status === 'PERFORMANCE_TIME');
        if (performances.length === 0) continue;

        const showDuration = showDurationByKey.get(dlpLiveDataEntityIdKey(sched.id)) || 0;

        const showtimes = performances.map((p) => {
          const startTime = constructDateTime(todayStr, p.startTime, this.timezone);
          const endTimeStr = showDuration === 0 ? p.endTime : p.startTime;
          const endTimeIso = constructDateTime(todayStr, endTimeStr, this.timezone);
          let endDate = new Date(endTimeIso);
          if (showDuration > 0) {
            endDate = new Date(endDate.getTime() + showDuration * 60 * 1000);
          }
          const endTime = formatInTimezone(endDate, this.timezone, 'iso');

          return {
            startTime,
            endTime,
            type: 'Performance Time',
          };
        });

        const existing = liveDataMap.get(dlpLiveDataEntityIdKey(sched.id));
        if (existing) {
          existing.showtimes = showtimes;
          if (showtimes.length > 0) {
            existing.status = 'OPERATING' as any;
          }
        } else {
          const ld = getOrCreate(sched.id);
          if (!ld) continue;
          ld.status = 'OPERATING' as any;
          ld.showtimes = showtimes;
        }
      }
    } catch (e) {
      console.error(`[DLP] Error fetching today's schedule for show times: ${e}`);
    }

    // === Baseline STANDBY/SINGLE_RIDER for closed-overnight rides ===
    // The wait-times feed goes silent shortly after park close. Without a
    // baseline emission, attractions that only have premier-access data
    // (next-morning slots) would lose their STANDBY/SINGLE_RIDER fields
    // until the API wakes back up. Consumers expect these queues to stay
    // present so they can render `wait: null` rather than disappearing.
    //
    // Map-only "attractions" (no wait product) are excluded here so we do
    // not add a synthetic CLOSED/STANDBY for POIs the app never tracks as a queue.
    //
    // Single-rider eligibility isn't on POI, so remember IDs we've seen
    // with `singleRider.isAvailable === true` and re-emit SINGLE_RIDER
    // null for them while the feed is asleep. Keys are normalized to
    // lowercase; map-only IDs are skipped to avoid spurious cache entries.
    const srCacheKey = `${this.getCacheKeyPrefix()}:dlp:singleRiderCapable`;
    const previouslySeenSR = CacheLib.get(srCacheKey) as string[] | null;
    const seenSR = new Set<string>(
      Array.isArray(previouslySeenSR)
        ? previouslySeenSR.map((id) => String(id).toLowerCase())
        : [],
    );
    for (const wt of waitTimes) {
      if (wt.singleRider?.isAvailable === true && wt.entityId) {
        if (dlpPoiIdIsMapOnlyNonQueueAttractionId(wt.entityId)) continue;
        seenSR.add(wt.entityId.toLowerCase());
      }
    }
    CacheLib.set(srCacheKey, [...seenSR], 30 * 24 * 60 * 60); // 30 days

    const attractionIds = emittablePois
      .filter(
        (poi) =>
          this.mapEntityType(poi) === 'ATTRACTION' && dlpPoiEmitsQueueLiveData(poi),
      )
      .map((poi) => poi.id);
    for (const id of attractionIds) {
      const key = dlpLiveDataEntityIdKey(id);
      let ld = liveDataMap.get(key);
      if (!ld) {
        ld = {id, status: 'CLOSED'} as LiveData;
        liveDataMap.set(key, ld);
        liveData.push(ld);
      }
      if (!ld.queue) ld.queue = {};
      if (!ld.queue.STANDBY) ld.queue.STANDBY = {waitTime: null};
      if (!ld.queue.SINGLE_RIDER && seenSR.has(id.toLowerCase())) {
        ld.queue.SINGLE_RIDER = {waitTime: null};
      }
    }

    return liveData;
  }

  protected async buildSchedules(): Promise<EntitySchedule[]> {
    const now = new Date();
    const scheduleMap = new Map<string, any[]>();

    // Fetch 60 days of schedule data
    for (let i = 0; i < 60; i++) {
      const date = addDays(now, i);
      const dateStr = formatInTimezone(date, this.timezone, 'date');
      // Convert MM/DD/YYYY to YYYY-MM-DD
      const [mm, dd, yyyy] = dateStr.split('/');
      const dateString = `${yyyy}-${mm}-${dd}`;

      let dateData: DLPScheduleActivityEntry[];
      try {
        dateData = await this.getScheduleForDate(dateString);
      } catch {
        continue;
      }
      if (!dateData) continue;

      for (const entity of dateData) {
        if (!entity.schedules) continue;
        if (IGNORE_ENTITIES.has(entity.id)) continue;

        for (const hours of entity.schedules) {
          if (hours.status === 'REFURBISHMENT' || hours.status === 'CLOSED') continue;

          const openTime = constructDateTime(dateString, hours.startTime, this.timezone);
          let closeTime = constructDateTime(dateString, hours.endTime, this.timezone);

          // Handle midnight crossing: if close < open, add 1 day to close
          if (hours.endTime < hours.startTime) {
            const nextDay = addDays(new Date(`${dateString}T00:00:00`), 1);
            const nextDayStr = formatInTimezone(nextDay, this.timezone, 'date');
            const [nmm, ndd, nyyyy] = nextDayStr.split('/');
            const nextDayString = `${nyyyy}-${nmm}-${ndd}`;
            closeTime = constructDateTime(nextDayString, hours.endTime, this.timezone);
          }

          let type: string = 'OPERATING';
          let description: string | undefined;

          if (hours.status === 'EXTRA_MAGIC_HOURS') {
            type = 'EXTRA_HOURS';
            description = 'Extra Magic Hours';
          } else if (hours.status === 'PERFORMANCE_TIME') {
            type = 'INFO';
            description = 'Performance Time';
          }

          if (!scheduleMap.has(entity.id)) {
            scheduleMap.set(entity.id, []);
          }
          scheduleMap.get(entity.id)!.push({
            date: dateString,
            openingTime: openTime,
            closingTime: closeTime,
            type,
            description,
          });
        }
      }
    }

    // Convert map to EntitySchedule array
    const schedules: EntitySchedule[] = [];
    for (const [id, schedule] of scheduleMap) {
      schedules.push({id, schedule} as EntitySchedule);
    }

    return schedules;
  }
}

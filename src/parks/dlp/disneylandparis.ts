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
  TagData,
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
  'P2EA02', // Entry to World of Frozen (land-entry pass, not a ride)
]);

/** Entities that bypass visibility/hide rules */
const VISIBILITY_EXCEPTIONS = new Set([
  'P2EA00', // Frozen Ever After
  'P2DA00', // Tangled Spin
  'P1GS93', // Live Your Story – a Disney Princess Celebration (Castle Stage; Disney flags it "Hide from the Service")
  // Disney flags these "Hide from Web List + Mobile App", which it otherwise uses as a
  // retirement marker (every old-/-OLD record carries it). These two are live and still
  // report wait times, so they are the only members of that flag we surface.
  'P1DA10', // Disneyland Railroad Discoveryland Station
  'P1NA16', // Disneyland Railroad Fantasyland Station
]);

/**
 * DLP splits Mickey's PhilharMagic across two records: published
 * Entertainment record P1G103 carries the showtimes, while hidden Attraction
 * twin P1DA13 carries the standby wait and a schedule restating those
 * showtimes. Live and schedule rows for the twin fold onto the published id.
 */
const ID_ALIASES: Record<string, string> = {
  P1DA13: 'P1G103',
};

/** Entity types keyed by id, checked ahead of the category mapping. */
const ENTITY_TYPE_OVERRIDES: Record<string, Entity['entityType']> = {
  P1G103: 'ATTRACTION', // PhilharMagic is an attraction across Disney resorts
};

/**
 * Hide rules that exclude entities from the POI list.
 *
 * `Hide from the Mobile App` is deliberately not one of them. Every record
 * carrying it is an off-site or guest-information page, not a venue in
 * either park.
 */
const HIDE_RULES = new Set([
  'Hide from Web List + Mobile App',
  'Hide from the Service',
]);

/** Entertainment subtypes that map to SHOW entity type */
const SHOW_SUBTYPES = new Set([
  'Stage Show',
  'Fireworks',
  'Atmosphere',
  'Parade',
]);

/** Wall-clock time the schedule feed publishes, e.g. `21:30:00`.
 * `24:00` is a valid midnight close; out-of-range values would reach
 * constructDateTime and throw. */
const TIME_OF_DAY = /^(?:(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?|24:00(?::00)?)$/;

/** Upper bound for a rider height restriction; anything taller is bad data */
const MAX_HEIGHT_CM = 300;

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
  duration?: { hours?: number; minutes?: number };
  // Attraction-only, from the inline fragment in fetchPOI
  height?: Array<{ id: string }>;
  physicalConsiderations?: Array<{ id: string }>;
  interests?: Array<{ id: string }>;
  singleRider?: boolean;
};

/**
 * Ids of a POI facet list. GraphQL lists may hold nulls, and the whole field
 * is absent on every type but Attraction, so anything unusable is dropped
 * rather than allowed to fail the entity build.
 */
function facetIds(list: Array<{id?: string}> | undefined): Set<string> {
  if (!Array.isArray(list)) return new Set();
  return new Set(
    list.map((facet) => facet?.id).filter((id): id is string => typeof id === 'string'),
  );
}

/**
 * Parse a height facet id into centimetres: `81cm` → 81, `1_20m` → 120.
 * Returns undefined for `anyHeight`, for ids in any other shape, and for
 * values outside a plausible rider height.
 *
 * The facet's companion `value` string is localised — the same restriction
 * reads `1.20 m` in en-gb and `1,20 m` in fr-fr — so the id is the only
 * market-independent source.
 */
function parseHeightCm(facetId: string): number | undefined {
  const match = /^(\d+(?:_\d+)?)(cm|m)$/.exec(facetId);
  if (!match) return undefined;
  const value = Number(match[1].replace('_', '.'));
  if (!Number.isFinite(value)) return undefined;
  const cm = Math.round(match[2] === 'm' ? value * 100 : value);
  return cm > 0 && cm <= MAX_HEIGHT_CM ? cm : undefined;
}

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
            ... on Attraction {
              height {
                id
              }
              physicalConsiderations {
                id
              }
              interests {
                id
              }
              singleRider
            }
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
  @cache({ttlSeconds: 43200, cacheVersion: 3})
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
   * Build the tags for a POI entity. Every field read here belongs to the
   * Attraction type, so shows and restaurants come back with an empty list.
   */
  private buildTags(poi: DLPPOIEntity): TagData[] {
    const tags: TagData[] = [];

    const heightCm = [...facetIds(poi.height)]
      .map((id) => parseHeightCm(id))
      .find((cm) => cm !== undefined);
    if (heightCm !== undefined) {
      tags.push(TagBuilder.minimumHeight(heightCm, 'cm'));
    }

    if (facetIds(poi.physicalConsiderations).has('expectantMothersMayNotRide')) {
      tags.push(TagBuilder.unsuitableForPregnantPeople());
    }

    if (poi.singleRider === true) {
      tags.push(TagBuilder.singleRider());
    }

    const interests = facetIds(poi.interests);
    if (interests.has('disney-premier-access-one')) tags.push(TagBuilder.paidReturnTime());
    if (interests.has('guestMayGetSplashed')) tags.push(TagBuilder.mayGetWet());
    if (interests.has('PhotoPass')) tags.push(TagBuilder.onRidePhoto());

    return tags;
  }

  /**
   * Map DLP entity type to our entity type
   */
  private mapEntityType(entity: DLPPOIEntity & {category: string}): Entity['entityType'] | undefined {
    const override = ENTITY_TYPE_OVERRIDES[entity.id];
    if (override) return override;
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
   * Ids the entity list publishes, or null when POI is unavailable — a
   * GraphQL 200-with-errors body reaches getPOIData as an empty object with
   * no exception, and 12h of cache would pin it. Callers filtering on the
   * result must treat null as "do not filter", not "filter everything out".
   */
  private async getPublishedEntityIds(): Promise<Set<string> | null> {
    try {
      const pois = await this.getEmittablePOIEntities();
      if (pois.length === 0) return null;
      const ids = new Set<string>(pois.map((poi) => poi.id));
      // The parks and the destination are published but are not POI records.
      ids.add('P1');
      ids.add('P2');
      ids.add('dlp');
      return ids;
    } catch {
      return null;
    }
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

      if (poi.id === 'P1G103') {
        // 4D cinema — destination.ts otherwise defaults ATTRACTION to RIDE.
        (entity as Entity & {attractionType?: string}).attractionType = 'SHOW';
      }

      entity.tags = this.buildTags(poi);

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
    const liveDataMap = new Map<string, LiveData>();

    // Today (YYYY-MM-DD) in the park's timezone. Used by the show-time
    // path and by the walkthrough status derivation at the bottom of this
    // method.
    const [tMM, tDD, tYYYY] = formatInTimezone(new Date(), this.timezone, 'date').split('/');
    const todayStr = `${tYYYY}-${tMM}-${tDD}`;

    // Build the set of entity IDs we actually emit, so live data stays in
    // lockstep with buildEntityList. Without this, the wait-times feed
    // (and premier-access / virtual-queue / showtimes) leaks IDs for
    // characters, hidden POI entries, and codes Disney returns that aren't
    // in the public POI dataset at all.
    const emittablePois = await this.getEmittablePOIEntities();
    const validEntityIds = new Set<string>(emittablePois.map((poi) => poi.id));

    const getOrCreate = (id: string): LiveData | undefined => {
      if (!validEntityIds.has(id)) return undefined;
      let entry = liveDataMap.get(id);
      if (!entry) {
        entry = {id, status: 'CLOSED'} as LiveData;
        liveDataMap.set(id, entry);
        liveData.push(entry);
      }
      return entry;
    };

    // === Wait Times ===
    const waitTimes = await this.getWaitTimes();

    for (const wt of waitTimes) {
      if (!wt.entityId || wt.type !== 'Attraction') continue;
      if (IGNORE_ENTITIES.has(wt.entityId)) continue;

      const ld = getOrCreate(ID_ALIASES[wt.entityId] ?? wt.entityId);
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
    // `todayStr` (YYYY-MM-DD in park tz) is computed at the top of this method.
    // The payload is shared with the dining block below.
    let todaySchedules: DLPScheduleActivityEntry[] = [];
    try {
      todaySchedules = await this.getScheduleForDate(todayStr);
    } catch (e) {
      console.error(`[DLP] Error fetching today's schedule: ${e}`);
    }
    try {
      for (const sched of todaySchedules) {
        if (!sched.schedules) continue;

        const performances = sched.schedules.filter((s) => s.status === 'PERFORMANCE_TIME');
        if (performances.length === 0) continue;

        const showDuration = this.showDurationMap.get(sched.id) || 0;

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

        const existing = liveDataMap.get(sched.id);
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

    // === Baseline live-data for attractions ===
    // The wait-times feed goes silent shortly after park close. Without a
    // baseline emission, queue-bearing attractions that only have premier-
    // access data (next-morning slots) would lose their STANDBY/SINGLE_RIDER
    // fields until the API wakes back up. Consumers expect these queues to
    // stay present so they can render `wait: null` rather than disappearing.
    //
    // Walkthrough/non-queue attractions (Discovery Arcade, Liberty Arcade,
    // La Galerie de la Belle au Bois, Horse-Drawn Streetcars, Sleeping
    // Beauty Castle, World Premiere, …) are POI entries Disney never
    // publishes in the wait feed. They'd otherwise inherit a misleading
    // synthetic CLOSED + STANDBY:null all day. Instead we emit
    // OPERATING/CLOSED derived from today's POI schedule (or park-hours
    // fallback) and no queue. Detection is data-driven: persist a 30-day
    // cache of IDs that have ever appeared in the wait feed.

    // Wait-feed history: which attractions are queue-bearing? Walkthroughs
    // never appear here. 30-day TTL covers normal refurb cycles.
    const queueHistoryKey = `${this.getCacheKeyPrefix()}:dlp:queueBearingHistory`;
    const previousHistory = CacheLib.get(queueHistoryKey) as string[] | null;
    const queueBearingIds = new Set<string>(
      Array.isArray(previousHistory) ? previousHistory : [],
    );
    for (const wt of waitTimes) {
      if (wt.entityId) queueBearingIds.add(ID_ALIASES[wt.entityId] ?? wt.entityId);
    }
    CacheLib.set(queueHistoryKey, [...queueBearingIds], 30 * 24 * 60 * 60); // 30 days

    const attractionPois = emittablePois.filter(
      (poi) => this.mapEntityType(poi) === 'ATTRACTION',
    );

    // Today's park-open window — fallback for walkthroughs whose POI
    // entry doesn't carry its own schedule (Discovery Arcade etc.).
    // Derived from queue-bearing rides' POI schedules.
    const parkScheduleEntries = attractionPois
      .filter((p) => queueBearingIds.has(p.id))
      .flatMap((p) => p.schedules || [])
      .filter((s) => s.date === todayStr && s.status === 'OPERATING' && !s.closed);
    const parkOpenStr = parkScheduleEntries.length
      ? parkScheduleEntries.map((s) => s.startTime).sort()[0]
      : null;
    const parkCloseStr = parkScheduleEntries.length
      ? parkScheduleEntries.map((s) => s.endTime).sort().reverse()[0]
      : null;

    const nowMs = Date.now();
    const isWithinWindow = (open: string, close: string): boolean => {
      // The feed types these as plain strings, so a malformed one would reach
      // constructDateTime and throw out of the whole build.
      if (!TIME_OF_DAY.test(open) || !TIME_OF_DAY.test(close)) return false;
      const o = new Date(constructDateTime(todayStr, open.slice(0, 5), this.timezone)).getTime();
      const c = new Date(constructDateTime(todayStr, close.slice(0, 5), this.timezone)).getTime();
      return nowMs >= o && nowMs <= c;
    };

    const deriveWalkthroughStatus = (
      poi: DLPPOIEntity & {category: string},
    ): 'OPERATING' | 'CLOSED' => {
      const own = (poi.schedules || []).find((s) => s.date === todayStr);
      if (own?.closed === true) return 'CLOSED';
      if (own?.status === 'OPERATING' && own.startTime && own.endTime) {
        return isWithinWindow(own.startTime, own.endTime) ? 'OPERATING' : 'CLOSED';
      }
      if (parkOpenStr && parkCloseStr) {
        return isWithinWindow(parkOpenStr, parkCloseStr) ? 'OPERATING' : 'CLOSED';
      }
      return 'CLOSED';
    };

    for (const poi of attractionPois) {
      const id = poi.id;
      let ld = liveDataMap.get(id);

      if (queueBearingIds.has(id)) {
        // Queue-bearing ride — STANDBY:null baseline so consumers can
        // render `wait: null` while the feed is silent.
        if (!ld) {
          ld = {id, status: 'CLOSED'} as LiveData;
          liveDataMap.set(id, ld);
          liveData.push(ld);
        }
        if (!ld.queue) ld.queue = {};
        if (!ld.queue.STANDBY) ld.queue.STANDBY = {waitTime: null};
        if (!ld.queue.SINGLE_RIDER && poi.singleRider === true) {
          ld.queue.SINGLE_RIDER = {waitTime: null};
        }
      } else if (!ld) {
        // Walkthrough — status from schedule, no queue.
        const walkthrough = {id, status: deriveWalkthroughStatus(poi)} as LiveData;
        liveDataMap.set(id, walkthrough);
        liveData.push(walkthrough);
      }
      // If a walkthrough already has a row from upstream feeds (PA / VQ /
      // showtimes), leave it — those feeds are authoritative.
    }

    // === Dining (from today's schedule) ===
    // Sourced from the activity-schedule payload above rather than the POI
    // blob, whose `schedules` only ever carry the day it was fetched — after
    // midnight the 12h POI cache would have no row for the new date.
    // Without published hours a restaurant is skipped, not reported closed.
    // This feed is authoritative for a restaurant's status, so unlike the
    // walkthrough block above it overwrites what other feeds set.
    const todayRowsById = new Map<string, DLPScheduleEntry[]>();
    for (const sched of todaySchedules) {
      if (sched?.id && Array.isArray(sched.schedules)) todayRowsById.set(sched.id, sched.schedules);
    }
    for (const poi of emittablePois) {
      if (this.mapEntityType(poi) !== 'RESTAURANT') continue;

      const hours = (todayRowsById.get(poi.id) || []).find((s) => s.date === todayStr);
      if (!hours || !hours.startTime || !hours.endTime) continue;

      const ld = getOrCreate(poi.id);
      if (!ld) continue;

      // Unlike the wait feed's, this REFURBISHMENT is a real closure, and the
      // only signal for it — buildSchedules skips those days entirely.
      if (hours.status === 'REFURBISHMENT') {
        ld.status = 'REFURBISHMENT';
        continue;
      }
      if (!TIME_OF_DAY.test(hours.startTime) || !TIME_OF_DAY.test(hours.endTime)) {
        ld.status = 'CLOSED';
        continue;
      }

      const startTime = constructDateTime(todayStr, hours.startTime.slice(0, 5), this.timezone);
      let endTime = constructDateTime(todayStr, hours.endTime.slice(0, 5), this.timezone);
      // Midnight crossing, mirroring buildSchedules.
      if (hours.endTime.slice(0, 5) < hours.startTime.slice(0, 5)) {
        const nextDay = addDays(new Date(`${todayStr}T00:00:00`), 1);
        const [nmm, ndd, nyyyy] = formatInTimezone(nextDay, this.timezone, 'date').split('/');
        endTime = constructDateTime(`${nyyyy}-${nmm}-${ndd}`, hours.endTime.slice(0, 5), this.timezone);
      }

      // Only an explicit OPERATING opens the row; any new status token reads
      // CLOSED rather than borrowing the wait feed's OPERATING default.
      const open = hours.closed !== true
        && hours.status === 'OPERATING'
        && nowMs >= new Date(startTime).getTime()
        && nowMs < new Date(endTime).getTime();
      ld.status = open ? 'OPERATING' : 'CLOSED';
      ld.operatingHours = [{type: 'OPERATING', startTime, endTime}];
    }

    return liveData;
  }

  protected async buildSchedules(): Promise<EntitySchedule[]> {
    const now = new Date();
    const scheduleMap = new Map<string, any[]>();

    // The schedule feed reaches well past the POI set we publish — hotel and
    // Disney Village restaurants, character meets, records the visibility
    // filter drops. Hours for an entity we never emit can't be attached to
    // anything, so the published list is the authority on what to keep.
    // When POI is unavailable, schedules publish unfiltered rather than empty.
    const publishedIds = await this.getPublishedEntityIds();

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
        if (!Array.isArray(entity?.schedules)) continue;
        // Alias before filtering, not after. The hidden PhilharMagic twin's
        // rows fold onto a published id, so testing the raw id against the
        // published set would drop them before the alias could move them.
        const scheduleId = ID_ALIASES[entity.id] ?? entity.id;
        if (publishedIds && !publishedIds.has(scheduleId)) continue;

        for (const hours of entity.schedules) {
          if (hours?.status === 'REFURBISHMENT' || hours?.status === 'CLOSED') continue;

          // These arrive as plain GraphQL strings, and constructDateTime throws
          // on anything it can't parse — which costs every entity all 60 days,
          // not just this row.
          if (!TIME_OF_DAY.test(hours?.startTime) || !TIME_OF_DAY.test(hours?.endTime)) continue;

          const openTime = constructDateTime(dateString, hours.startTime, this.timezone);
          let closeTime = constructDateTime(dateString, hours.endTime, this.timezone);

          // Handle midnight crossing: if close < open, add 1 day to close.
          // Compared on HH:MM so a mixed HH:MM / HH:MM:SS pair can't
          // fabricate a rollover.
          if (hours.endTime.slice(0, 5) < hours.startTime.slice(0, 5)) {
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

          if (!scheduleMap.has(scheduleId)) {
            scheduleMap.set(scheduleId, []);
          }
          scheduleMap.get(scheduleId)!.push({
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

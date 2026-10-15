/**
 * Herschend Family Entertainment (HFE) Theme Parks
 *
 * Shared base class for parks using the HFE Corp API:
 * - Dollywood (Pigeon Forge, TN)
 * - Silver Dollar City (Branson, MO)
 * - Kennywood (West Mifflin, PA)
 * - Kentucky Kingdom & Hurricane Bay (Louisville, KY)
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

/**
 * Height requirement object shape returned by the HFE Corp activities endpoint.
 * The API returns this object for every ride (older code assumed a bare
 * number/string, which never matched, so height tags were silently dropped).
 */
type HFEHeightRequirement = {
  minHeight?: string | number | null;
  maxHeight?: string | number | null;
  companionInfo?: string | null;
  color?: string | null;
};

/** Activity from the HFE Corp activities endpoint */
export type HFEActivity = {
  id: string;
  title: string;
  activityCategories: string[];
  activityListId?: string;
  /**
   * The stage a show plays at: the id of another activity in the same payload
   * (a venue such as "Gazebo Stage", though nothing guarantees it is filed in
   * the venue list). Null or missing on some shows.
   */
  showVenueLocation?: string | null;
  duration?: string | null;
  latitudeForDirections?: string | number;
  longitudeForDirections?: string | number;
  type?: string[];
  heightRequirement?: string | number | HFEHeightRequirement | null;
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
// Same-stage show folding
// ============================================================================

/** One published show: the feed records it stands for, and the name it goes by. */
export type HFEShowGroup = {
  /** The record whose id and details the entity takes. */
  canonical: HFEActivity;
  /** Every record folded into the entity, the canonical one included, by id. */
  members: HFEActivity[];
  /** The title without a sponsor credit, with the stage added where the act plays more than one. */
  name: string;
};

/** Case, punctuation and script insensitive comparison key; '' if nothing is left. */
function textKey(value: unknown): string {
  return typeof value === 'string'
    ? value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
    : '';
}

/**
 * A trailing sponsor credit: "Santa's Cottage Presented by Acme". The credit
 * runs to the end of the title, may follow a dash, comma or colon, and needs
 * words before it, so a title that opens with the credit is left whole.
 * "Presented by" and "Powered by" are the two wordings the park feeds use.
 */
const SPONSOR_SUFFIX = /^(.*?\S)(?:\s+[–—-]\s+|\s*[,:]\s*|\s+)(?:presented|powered)\s+by\s+\S.*$/is;

/**
 * The title a show goes by: the feed title without a trailing sponsor credit.
 * A title with no credit comes back exactly as it came in, whitespace
 * included, so no published name moves for a reason other than the credit.
 */
export function stripSponsorSuffix(title: string): string {
  if (typeof title !== 'string') return title;
  const match = SPONSOR_SUFFIX.exec(title);
  return match ? match[1] : title;
}

/** A categorised record clears the ghost filter on its own, whatever the schedule says. */
const isCategorised = (a: HFEActivity): boolean => (a.activityCategories?.length ?? 0) > 0;

/**
 * Where a show plays, as a comparison key and the name to print; both '' when
 * the feed does not say. A venue the payload cannot resolve, one with no name,
 * and one that is the show itself (some records name themselves) all count as
 * "does not say": there is nothing to print, and keying on a dangling id would
 * split copies of one act that the park cannot tell apart.
 */
function stageOf(show: HFEActivity, byId: Map<string, HFEActivity>): {key: string; label: string} {
  const venue = show.showVenueLocation ? byId.get(show.showVenueLocation) : undefined;
  const label = typeof venue?.title === 'string' ? venue.title.trim() : '';
  const key = textKey(label);
  if (!key || key === textKey(show.title)) return {key: '', label: ''};
  return {key, label};
}

/**
 * Fold a park's emitted show records to one entity per act and stage.
 *
 * Silver Dollar City lists an act as a separate record for every stage and
 * every season it plays, all under the same title: "Arbour Season" is five
 * records, "Kinfolk Bluegrass Band" five more. Published as they stand they
 * are same-name entities side by side.
 *
 * - Records with the same title AND the same stage are the seasonal copies of
 *   one stage's act. They fold into one group, and `members` is the lot, so
 *   the caller can merge their showtimes.
 * - Records on different stages stay in different groups.
 * - The stage is added to the name ("Arbour Season (Gazebo Stage)") whenever
 *   the feed lists the same title on more than one named stage, ghost records
 *   included. So a single-stage act carries its stage in its name if the feed
 *   also lists the title on another stage, and the name does not move with the
 *   season: the other stage's copy is only published while the schedule lists
 *   it, but its record is in the feed all year. A stage the feed does not name
 *   (missing, unresolvable, or the show itself) counts as no stage: it is never
 *   printed and never makes another stage a second one. A group with no named
 *   stage keeps the plain title, as does the only named stage of a title whose
 *   other records are unplaced.
 *
 * `shows` is what the park would publish anyway (already through the ghost
 * filter), and a ghost record does not join a group. `activities` is the whole
 * payload: where a stage's name is looked up, and where the other records of
 * the same title (from the same list as `shows`) are counted.
 *
 * The canonical record, whose id the entity takes, is the first of:
 *
 *   1. the lowest id in `options.preferredIds`: ids already in use that must
 *      not move, which also covers a new copy turning up with a lower id;
 *   2. the lowest categorised id. A categorised record is always published,
 *      but an uncategorised one only while the schedule lists it, so it comes
 *      and goes with the season. An id taken from one of those would move
 *      every time it left;
 *   3. the lowest id.
 *
 * Where it still moves: when the record the id came from leaves the feed, and
 * when every copy is uncategorised and the lowest leaves the schedule. Input
 * order does not matter.
 */
export function foldShowsByStage(
  shows: HFEActivity[],
  activities: HFEActivity[],
  options: {preferredIds?: ReadonlySet<string>} = {},
): HFEShowGroup[] {
  const preferred = options.preferredIds ?? new Set<string>();
  // The payload as the fold sees it. `shows` are part of it even if a caller
  // leaves one out of `activities`.
  const feed = new Map(activities.map(a => [a.id, a]));
  for (const s of shows) feed.set(s.id, s);
  const position = new Map(shows.map((s, i) => [s.id, i]));
  const byIdAsc = (a: HFEActivity, b: HFEActivity) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  // A title with nothing comparable in it is its own act, never folded.
  // The sponsor credit is not part of the act: a record that carries one and a
  // plain copy of the same act on the same stage are one entity.
  const titleKeyOf = (s: HFEActivity) => textKey(stripSponsorSuffix(s.title)) || `\0${s.id}`;

  const buckets = new Map<string, {titleKey: string; members: HFEActivity[]}>();
  for (const s of shows) {
    const titleKey = titleKeyOf(s);
    const bucketKey = `${titleKey}\0${stageOf(s, feed).key}`;
    const bucket = buckets.get(bucketKey);
    if (bucket) bucket.members.push(s);
    else buckets.set(bucketKey, {titleKey, members: [s]});
  }

  // Named stages per title over the whole feed, published or not, so the count
  // does not move with the schedule.
  const showLists = new Set(shows.map(s => s.activityListId));
  const namedStagesPerTitle = new Map<string, Set<string>>();
  for (const record of feed.values()) {
    if (!showLists.has(record.activityListId)) continue;
    const stage = stageOf(record, feed).key;
    if (!stage) continue;
    const titleKey = titleKeyOf(record);
    const stages = namedStagesPerTitle.get(titleKey) ?? new Set<string>();
    stages.add(stage);
    namedStagesPerTitle.set(titleKey, stages);
  }

  const groups: HFEShowGroup[] = [];
  for (const {titleKey, members} of buckets.values()) {
    members.sort(byIdAsc);
    const canonical =
      members.find(m => preferred.has(m.id)) ??
      members.find(isCategorised) ??
      members[0];
    const {label} = stageOf(canonical, feed);
    const named = label !== '' && (namedStagesPerTitle.get(titleKey)?.size ?? 0) > 1;
    const title = stripSponsorSuffix(canonical.title);
    groups.push({
      canonical,
      members,
      name: named ? `${title.trim()} (${label})` : title,
    });
  }

  return groups.sort((a, b) => position.get(a.canonical.id)! - position.get(b.canonical.id)!);
}

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

  /**
   * Extra activity category strings that also count as attractions (set by
   * subclass). Some parks tag a handful of rides only under a sub-category
   * (e.g. Kentucky Kingdom's water-park items sit in 'Water Park' but not
   * 'All Attractions'); listing those categories here recovers them without
   * pulling in non-ride POIs. Empty by default = no change.
   */
  protected extraAttractionCategories: string[] = [];

  /**
   * When true, only SHOW entities with a scheduled performance in the fetched
   * window are emitted. The default heuristic keeps any categorised show, which
   * a park can defeat by tagging one-off performers (e.g. concert bookings)
   * with a real category. Setting this drops those ghosts at the cost of hiding
   * genuinely unscheduled off-season shows until they reappear on the calendar.
   */
  protected showsRequireSchedule: boolean = false;

  /**
   * When true, shows are published one entity per act and stage (see
   * foldShowsByStage). Off by default: the fold renames and removes entities, so
   * a park opts in once that has been decided for it.
   */
  protected foldStageShows: boolean = false;

  /** Show ids that stay the entity id when copies fold (see foldShowsByStage). */
  protected preferredShowIds: ReadonlySet<string> = new Set();

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

  /**
   * Whether an activity should be modelled as an attraction entity.
   * Shared by buildEntityList and buildLiveData so both agree on the set.
   */
  protected isAttractionActivity(a: HFEActivity): boolean {
    const cats = a.activityCategories ?? [];
    if (cats.includes(this.attractionCategory)) return true;
    if (this.extraAttractionCategories.some(c => cats.includes(c))) return true;
    if (this.attractionsListId && a.activityListId === this.attractionsListId && a.rideWaitTimeRideId != null) return true;
    return false;
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
      activities.filter(a => this.isAttractionActivity(a)),
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

          // Parse height requirement. The API returns an object
          // ({minHeight, maxHeight, ...}); older number/string handling is kept
          // as a fallback in case the shape varies.
          const heightReq = activity.heightRequirement;
          const toInches = (v: string | number | null | undefined): number | undefined => {
            if (v == null) return undefined;
            const match = String(v).match(/\d+/);
            if (!match) return undefined;
            const n = parseInt(match[0], 10);
            return n > 0 ? n : undefined;
          };
          if (typeof heightReq === 'number' || typeof heightReq === 'string') {
            const min = toInches(heightReq);
            if (min !== undefined) tags.push(TagBuilder.minimumHeight(min, 'in'));
          } else if (heightReq && typeof heightReq === 'object') {
            const min = toInches(heightReq.minHeight);
            const max = toInches(heightReq.maxHeight);
            if (min !== undefined) tags.push(TagBuilder.minimumHeight(min, 'in'));
            if (max !== undefined) tags.push(TagBuilder.maximumHeight(max, 'in'));
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
      let scheduledIds = new Set<string>();
      try {
        scheduledIds = this.scheduledActivityIds(await this.getSchedule());
      } catch {
        // Schedule API totally unavailable — proceed with category-only filter
      }

      const groups = this.groupShows(this.selectShows(activities, scheduledIds), activities);

      shows.push(...this.mapEntities(groups, {
        idField: (g: HFEShowGroup) => g.canonical.id,
        nameField: (g: HFEShowGroup) => g.name,
        entityType: 'SHOW',
        parentIdField: () => this.parkSlug,
        destinationId: this.destinationSlug,
        timezone: this.timezone,
        locationFields: {
          lat: (g: HFEShowGroup) => this.parseCoord(g.canonical.latitudeForDirections),
          lng: (g: HFEShowGroup) => this.parseCoord(g.canonical.longitudeForDirections),
        },
      }));
    }

    return [parkEntity, ...attractions, ...restaurants, ...shows];
  }

  /** Ids the daily schedule lists an activity for. */
  private scheduledActivityIds(days: HFEScheduleDay[]): Set<string> {
    const ids = new Set<string>();
    for (const day of days) {
      for (const a of day.activities ?? []) {
        if (a.cmsKey) ids.add(a.cmsKey);
      }
    }
    return ids;
  }

  /**
   * The show records worth publishing. Shared by buildEntityList and
   * buildSchedules so both agree on the set, and so on which copies fold.
   */
  private selectShows(activities: HFEActivity[], scheduledIds: Set<string>): HFEActivity[] {
    return activities.filter(
      a => a.activityListId === this.showCategoryListId &&
        (this.showsRequireSchedule
          ? scheduledIds.has(a.id)
          : ((a.activityCategories?.length ?? 0) > 0 || scheduledIds.has(a.id))),
    );
  }

  /** One group per published show: a single record each, unless the park folds. */
  private groupShows(shows: HFEActivity[], activities: HFEActivity[]): HFEShowGroup[] {
    if (!this.foldStageShows) {
      return shows.map(s => ({canonical: s, members: [s], name: stripSponsorSuffix(s.title)}));
    }
    return foldShowsByStage(shows, activities, {preferredIds: this.preferredShowIds});
  }

  // ============================================================================
  // Live Data
  // ============================================================================

  protected async buildLiveData(): Promise<LiveData[]> {
    let activities: HFEActivity[];
    try {
      activities = await this.getActivities();
    } catch {
      // Activities cache cold + a transient CRM outage would otherwise throw and
      // wipe all live data even when the wait-time feed is healthy. Fail safe.
      return [];
    }
    const attractionActivities = activities.filter(a => this.isAttractionActivity(a));

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

      const verdict = mapHfeRideStatus(
        wt.operationStatus, wt.waitTimeDisplay, wt.waitTime, parkIsOpen,
      );
      const ld: LiveData = {id: entityId, status: verdict.status} as LiveData;
      if (verdict.waitTime !== undefined) {
        ld.queue = {STANDBY: {waitTime: verdict.waitTime}};
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

    const scheduleEntries: EntitySchedule['schedule'] = [];

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

      // Which entity each record publishes under. A folded-away record has no
      // entity of its own, so its showtimes go to the canonical one and it gets
      // no schedule row, which would otherwise be an orphan.
      const publishedAs = new Map<string, string>();
      const recordsPerEntity = new Map<string, number>();
      const published = this.selectShows(activities, this.scheduledActivityIds(scheduleDays));
      for (const group of this.groupShows(published, activities)) {
        recordsPerEntity.set(group.canonical.id, group.members.length);
        for (const member of group.members) publishedAs.set(member.id, group.canonical.id);
      }

      type Slot = EntitySchedule['schedule'][number];
      const showSchedules = new Map<string, Slot[]>();
      // Showtimes of folded entities, kept apart until every record is read.
      const foldedSlots = new Map<string, Array<{slot: Slot; fromCanonical: boolean}>>();

      for (const day of scheduleDays) {
        if (!Array.isArray(day.activities)) continue;
        const dateStr = day.date.split('T')[0];

        for (const activity of day.activities) {
          if (!activity.cmsKey || !activity.events?.length) continue;

          const show = showById.get(activity.cmsKey);
          if (!show) continue;
          const entityId = publishedAs.get(show.id) ?? show.id;

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

            const slot: Slot = {
              date: dateStr,
              type: 'OPERATING',
              openingTime,
              closingTime,
            };
            if ((recordsPerEntity.get(entityId) ?? 1) > 1) {
              if (!foldedSlots.has(entityId)) foldedSlots.set(entityId, []);
              foldedSlots.get(entityId)!.push({slot, fromCanonical: show.id === entityId});
              continue;
            }
            if (!showSchedules.has(entityId)) {
              showSchedules.set(entityId, []);
            }
            showSchedules.get(entityId)!.push(slot);
          }
        }
      }

      // Seasonal copies of one stage's act can list the same start. That is one
      // performance, and the canonical record's reading of it (its own end or
      // duration) wins. Each entity's times are then in time order, because the
      // copies were read record by record, not clock by clock.
      for (const [id, candidates] of foldedSlots) {
        const byStart = new Map<string, Slot>();
        for (const {slot} of [...candidates].sort((a, b) => Number(b.fromCanonical) - Number(a.fromCanonical))) {
          if (!byStart.has(slot.openingTime)) byStart.set(slot.openingTime, slot);
        }
        showSchedules.set(
          id,
          [...byStart.values()].sort((a, b) => Date.parse(a.openingTime) - Date.parse(b.openingTime)),
        );
      }

      for (const [id, schedule] of showSchedules) {
        result.push({id, schedule} as EntitySchedule);
      }
    }

    return result;
  }

}

// ============================================================================
// Status mapping
// ============================================================================

/**
 * Map one wait-time row to a live status, and the standby wait to publish with
 * it (`undefined` meaning publish no queue at all).
 *
 * Exported and pure so the mapping can be asserted directly. It used to be an
 * if/else chain inside buildLiveData, which meant the only way to test it was
 * to stand up the whole park — so nobody did, and a test elsewhere in the repo
 * asserted a table claiming TEMPORARILY CLOSED maps to DOWN unconditionally.
 * It does not, and that is the whole point of `parkIsOpen` below.
 *
 * `parkIsOpen` gates the delay states for the same reason the Universal and
 * SeaWorld show gates exist: the feed keeps serving its last reading after the
 * park shuts, and "temporarily closed" read overnight means closed for the
 * night, not a ride that is briefly broken. DOWN claims something is wrong
 * with the attraction; outside operating hours nothing is wrong, it is shut.
 */
export function mapHfeRideStatus(
  operationStatus: string | undefined,
  waitTimeDisplay: string | undefined,
  waitTime: number | null | undefined,
  parkIsOpen: boolean,
): {status: 'OPERATING' | 'DOWN' | 'CLOSED'; waitTime?: number} {
  const statusUpper = (operationStatus || '').toUpperCase();
  const displayUpper = (waitTimeDisplay || '').toUpperCase();

  if (statusUpper === 'CLOSED' || statusUpper === 'CLOSED FOR THE DAY' || statusUpper === 'UNKNOWN') {
    return {status: 'CLOSED'};
  }
  if (statusUpper === 'TEMPORARILY CLOSED' || statusUpper === 'TEMPORARILY DELAYED') {
    return {status: parkIsOpen ? 'DOWN' : 'CLOSED'};
  }
  if (displayUpper.includes('UNDER')) {
    // "Under XX minutes" pattern.
    const waitMatch = displayUpper.match(/UNDER\s+(\d+)/);
    return waitMatch
      ? {status: 'OPERATING', waitTime: parseInt(waitMatch[1], 10)}
      : {status: 'OPERATING'};
  }
  if (statusUpper === 'OPEN' || (waitTime != null && waitTime >= 0)) {
    // A zero wait is a real reading here, unlike the Six Flags feed: it is
    // published alongside an explicit status rather than as a roster of zeros
    // served around the clock. Only a positive one is worth a queue entry.
    return (waitTime != null && waitTime > 0)
      ? {status: 'OPERATING', waitTime}
      : {status: 'OPERATING'};
  }
  return {status: 'CLOSED'};
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
    // The feed lists an act once per stage and season under one title; publish
    // one entity per act and stage instead of same-name copies.
    this.foldStageShows = true;
    // Ids already in use for acts the feed lists more than once on one stage
    // (two Arbour Season records on the Gazebo Stage, two Homestead Pickers
    // records at McHaffie's Homestead). A copy added later with a lower id must
    // not take over.
    this.preferredShowIds = new Set([
      'c7095f82-45d6-4174-bfc5-f4c1145ad88e',
      'afa2cd9f-3b39-46c8-ae3e-7a683f8da1eb',
    ]);
  }
}

/**
 * Kennywood - West Mifflin, Pennsylvania
 * Wait Time Dest ID: 701
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

/**
 * Kentucky Kingdom & Hurricane Bay - Louisville, Kentucky
 * Wait Time Dest ID: 4 (shared feed covering the theme park (KK) and the
 * Hurricane Bay (HB) water park, modelled as one park)
 *
 * The CRM exposes two identifiers for this resort: the app-baked "site" GUID
 * (cd9c6b3d…) only satisfies /activitiesbypark, while the "property" GUID
 * (932af507…) satisfies both /activitiesbypark and /dailyschedulebytime. We use
 * the property GUID as the parkId so a single value drives every endpoint, and
 * keep the site GUID as siteId purely for cache-key namespacing.
 */
@destinationController({category: ['Herschend', 'Kentucky Kingdom']})
export class KentuckyKingdom extends HFEBase {
  constructor(options?: DestinationConstructor) {
    super(options);
    this.addConfigPrefix('KENTUCKYKINGDOM');

    this.destinationSlug = 'kentuckykingdom';
    this.parkSlug = 'kentuckykingdompark';
    this.destinationName = 'Kentucky Kingdom';
    this.parkName = 'Kentucky Kingdom';
    this.parkLatitude = 38.1955;
    this.parkLongitude = -85.7457;
    this.attractionsListId = 'cdfe5fb4-5da7-4bfd-a139-30d6545273b9';
    this.showCategoryListId = '7b5c298a-b5a9-4fb9-922d-8900420bc049';
    // One Hurricane Bay water ride (Splash Zone) is tagged only 'Water Park',
    // not 'All Attractions'; recover it without pulling in non-ride POIs.
    this.extraAttractionCategories = ['Water Park'];
    // KK tags one-off concert bookings with real show categories, which defeats
    // the default ghost filter; require a scheduled performance instead.
    this.showsRequireSchedule = true;
  }
}

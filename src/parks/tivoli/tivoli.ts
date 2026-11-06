import {Destination, DestinationConstructor} from '../../destination.js';
import config from '../../config.js';
import {cache} from '../../cache.js';
import {http, HTTPObj} from '../../http.js';
import {inject} from '../../injector.js';
import {destinationController} from '../../destinationRegistry.js';
import {AttractionTypeEnum, ScheduleTypeEnum} from '@themeparks/typelib';
import type {Entity, EntitySchedule, LiveData} from '@themeparks/typelib';
import {formatDate, formatInTimezone, hostnameFromUrl} from '../../datetime.js';
import {TagBuilder} from '../../tags/index.js';

/**
 * Tivoli Gardens, Copenhagen.
 *
 * The app reads a headless content API (one list per content type) and a
 * separate opening-hours API keyed on the park's CRM asset ids. Neither needs
 * credentials.
 *
 * What this destination publishes: the park, its rides and restaurants, park
 * opening hours, and per-ride opening hours.
 *
 * What it does NOT publish: live data. The feed carries no wait times that we
 * have found, and a ride's `status` is not a live reading. It reads "Open" for
 * every ride in service this season, nightly-synced, whether or not the park
 * is open today (all 33 rides read "Open" on a day with no park hours for a
 * week). Publishing it as OPERATING would show a shut park as open. Live data
 * stays unimplemented until a real queue source is found.
 */

// ── Feed shapes (only the fields we read) ───────────────────────────────────

export interface TivoliContentItem {
  contentType: string;
  id: string;
  properties: {
    entityName?: string | null;
    crmId?: string | null;
    latitude?: number | null;
    longitude?: number | null;
    minHeight?: number | null;
    minHeightWithAdult?: number | null;
    minAge?: number | null;
    [key: string]: unknown;
  };
}

export interface TivoliContentFeed {
  total?: number;
  items: TivoliContentItem[];
}

export interface TivoliHoursRow {
  id: string;
  fromDatetime: string;
  toDatetime: string;
  assetID?: string;
  statecode?: string;
  /** Local midnight of the opening day, written as a UTC instant. */
  tivoliDay: string;
}

export interface TivoliAssetHours {
  id: string;
  name?: string;
  status?: string;
  hours: TivoliHoursRow[];
}

export interface TivoliBatchHours {
  items: TivoliAssetHours[];
}

type ScheduleEntry = EntitySchedule['schedule'][number];

// ── Pure builders (exported so the tests run the real code) ──────────────────

const validCoordinate = (lat: unknown, lng: unknown): lat is number =>
  typeof lat === 'number' && typeof lng === 'number' &&
  Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0);

/**
 * Height tags for a ride. The feed gives the height a rider needs alone
 * (`minHeight`) and, on some rides, a lower height that is enough with an
 * adult (`minHeightWithAdult`), e.g. 120 alone and 95 with an adult. Where the
 * two are equal (or only one is given) there is no unaccompanied distinction.
 */
export function tivoliHeightTags(item: TivoliContentItem): ReturnType<typeof TagBuilder.minimumHeight>[] {
  const alone = Number(item.properties.minHeight);
  const withAdult = Number(item.properties.minHeightWithAdult);
  const hasAlone = Number.isFinite(alone) && alone > 0;
  const hasWithAdult = Number.isFinite(withAdult) && withAdult > 0;

  if (hasAlone && hasWithAdult && withAdult < alone) {
    return [
      TagBuilder.minimumHeight(withAdult, 'cm'),
      TagBuilder.minimumHeightUnaccompanied(alone, 'cm'),
    ];
  }
  if (hasAlone) return [TagBuilder.minimumHeight(alone, 'cm')];
  if (hasWithAdult) return [TagBuilder.minimumHeight(withAdult, 'cm')];
  return [];
}

interface EntityContext {
  destinationId: string;
  parkId: string;
  timezone: string;
}

function baseEntity(item: TivoliContentItem, ctx: EntityContext): Entity | undefined {
  const name = typeof item.properties.entityName === 'string' ? item.properties.entityName.trim() : '';
  if (!item.id || !name) return undefined;

  const entity = {
    id: String(item.id),
    name,
    parentId: ctx.parkId,
    destinationId: ctx.destinationId,
    timezone: ctx.timezone,
  } as Entity;

  const {latitude, longitude} = item.properties;
  if (validCoordinate(latitude, longitude)) {
    entity.location = {latitude: latitude as number, longitude: longitude as number};
  }
  return entity;
}

/** Rides: the feed's own `rideEntity` classification is authoritative, all RIDE. */
export function tivoliRideEntities(feed: TivoliContentFeed, ctx: EntityContext): Entity[] {
  const out: Entity[] = [];
  for (const item of feed.items) {
    if (item.contentType !== 'rideEntity') continue;
    const entity = baseEntity(item, ctx);
    if (!entity) continue;
    entity.entityType = 'ATTRACTION';
    entity.attractionType = AttractionTypeEnum.RIDE;
    const tags = tivoliHeightTags(item);
    if (tags.length) entity.tags = tags;
    out.push(entity);
  }
  return out;
}

export function tivoliRestaurantEntities(feed: TivoliContentFeed, ctx: EntityContext): Entity[] {
  const out: Entity[] = [];
  for (const item of feed.items) {
    if (item.contentType !== 'foodEntity') continue;
    const entity = baseEntity(item, ctx);
    if (!entity) continue;
    entity.entityType = 'RESTAURANT';
    out.push(entity);
  }
  return out;
}

/**
 * One OPERATING entry for an hours row, or undefined when the row is unusable.
 *
 * `fromDatetime`/`toDatetime` are real UTC instants. `tivoliDay` is the local
 * midnight of the opening day written as a UTC instant (2026-11-12T23:00:00Z
 * is 13 November in Copenhagen), so the date is read in the park's timezone,
 * never sliced from the string.
 */
export function tivoliHoursEntry(row: TivoliHoursRow, timezone: string): ScheduleEntry | undefined {
  if (row.statecode !== undefined && row.statecode !== 'Active') return undefined;

  const day = new Date(row.tivoliDay);
  const open = new Date(row.fromDatetime);
  const close = new Date(row.toDatetime);
  if ([day, open, close].some(d => Number.isNaN(d.getTime()))) return undefined;
  if (close.getTime() <= open.getTime()) return undefined;

  return {
    date: formatDate(day, timezone),
    type: ScheduleTypeEnum.OPERATING,
    openingTime: formatInTimezone(open, timezone, 'iso'),
    closingTime: formatInTimezone(close, timezone, 'iso'),
  } as ScheduleEntry;
}

/** Entries for one asset's hours rows, ordered by day, ignoring repeated row ids. */
export function tivoliScheduleEntries(rows: TivoliHoursRow[], timezone: string): ScheduleEntry[] {
  const seen = new Set<string>();
  const entries: ScheduleEntry[] = [];
  for (const row of rows ?? []) {
    if (row.id) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
    }
    const entry = tivoliHoursEntry(row, timezone);
    if (entry) entries.push(entry);
  }
  return entries.sort((a, b) => String(a.openingTime).localeCompare(String(b.openingTime)));
}

/**
 * Per-ride schedules. The hours API keys on the CRM asset id, which the content
 * feed carries as `crmId`; the join is on that id only, since the two feeds
 * name the same ride differently ("Ice Skating Rink" against "Skøjtebanen").
 * A ride with no hours in the window gets no schedule at all.
 */
export function tivoliRideSchedules(
  rides: TivoliContentItem[],
  batch: TivoliBatchHours,
  timezone: string,
): EntitySchedule[] {
  const entityIdByCrm = new Map<string, string>();
  for (const ride of rides) {
    if (ride.properties.crmId) entityIdByCrm.set(String(ride.properties.crmId), String(ride.id));
  }

  const out: EntitySchedule[] = [];
  for (const asset of batch.items ?? []) {
    const id = entityIdByCrm.get(String(asset.id));
    if (!id) continue;
    const schedule = tivoliScheduleEntries(asset.hours, timezone);
    if (schedule.length) out.push({id, schedule} as EntitySchedule);
  }
  return out;
}

/** The park's own calendar day and the day `days` later, as the API's date strings. */
export function tivoliDateWindow(now: Date, timezone: string, days: number): {from: string; to: string} {
  return {
    from: formatDate(now, timezone),
    to: formatDate(new Date(now.getTime() + days * 86_400_000), timezone),
  };
}

// ── Destination ─────────────────────────────────────────────────────────────

const SCHEDULE_WINDOW_DAYS = 180;
// The content endpoints cap a page; the feed's `total` counts more rows than
// it returns unique items, so a first page is complete whenever `take` is
// above `total`.
const CONTENT_TAKE = 500;

@destinationController({category: 'Tivoli'})
export class Tivoli extends Destination {
  @config apiBase: string = '';
  @config timezone: string = 'Europe/Copenhagen';
  @config latitude: number = 55.6736;
  @config longitude: number = 12.5681;

  constructor(options?: DestinationConstructor) {
    super(options);
    this.addConfigPrefix('TIVOLI');
  }

  @inject({
    eventName: 'httpRequest',
    hostname: function (this: Tivoli) { return hostnameFromUrl(this.apiBase); },
  })
  async injectHeaders(req: HTTPObj): Promise<void> {
    req.headers = {
      ...req.headers,
      'accept-language': 'en-us',
      'user-agent': 'Dart/3.13 (dart:io)',
    };
  }

  // ── HTTP ───────────────────────────────────────────────────

  @http({cacheSeconds: 43200})
  async fetchContent(contentType: string): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.apiBase}/content/?contentType=${encodeURIComponent(contentType)}&take=${CONTENT_TAKE}&skip=0`,
      options: {json: true},
    } as any as HTTPObj;
  }

  @http({cacheSeconds: 43200, healthCheckArgs: ['{today}', '{date+180}']})
  async fetchParkHours(fromDate: string, toDate: string): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.apiBase}/opening-hours/?fromDate=${fromDate}&toDate=${toDate}`,
      options: {json: true},
    } as any as HTTPObj;
  }

  @http({cacheSeconds: 43200})
  async fetchRideHours(assetIds: string[], fromDate: string, toDate: string): Promise<HTTPObj> {
    return {
      method: 'POST',
      url: `${this.apiBase}/opening-hours/batch?fromDate=${fromDate}&toDate=${toDate}`,
      body: {assetIds},
      options: {json: true},
    } as any as HTTPObj;
  }

  // ── Cached helpers ─────────────────────────────────────────

  private async contentItems(contentType: string): Promise<TivoliContentItem[]> {
    const resp = await this.fetchContent(contentType);
    const feed = (await resp.json()) as TivoliContentFeed;
    if (!Array.isArray(feed?.items)) {
      throw new Error(`Tivoli ${contentType} feed has no items array`);
    }
    if (typeof feed.total === 'number' && feed.total > CONTENT_TAKE) {
      throw new Error(`Tivoli ${contentType} feed reports ${feed.total} rows, more than one page of ${CONTENT_TAKE}`);
    }
    return feed.items;
  }

  @cache({ttlSeconds: 43200})
  async getRides(): Promise<TivoliContentItem[]> {
    return this.contentItems('rideEntity');
  }

  @cache({ttlSeconds: 43200})
  async getRestaurants(): Promise<TivoliContentItem[]> {
    return this.contentItems('foodEntity');
  }

  // ── Entities ───────────────────────────────────────────────

  async getDestinations(): Promise<Entity[]> {
    return [{
      id: 'tivoli',
      name: 'Tivoli Gardens',
      entityType: 'DESTINATION',
      timezone: this.timezone,
      location: {latitude: this.latitude, longitude: this.longitude},
    } as Entity];
  }

  protected async buildEntityList(): Promise<Entity[]> {
    const [rides, restaurants] = await Promise.all([this.getRides(), this.getRestaurants()]);
    const ctx = {destinationId: 'tivoli', parkId: 'tivoligardens', timezone: this.timezone};

    const rideEntities = tivoliRideEntities({items: rides}, ctx);
    // An empty ride list is the feed failing, not the park having no rides. Say so
    // rather than publish a park with nothing in it.
    if (rideEntities.length === 0) {
      throw new Error('Tivoli ride feed produced no attractions');
    }

    const park: Entity = {
      id: ctx.parkId,
      name: 'Tivoli Gardens',
      entityType: 'PARK',
      parentId: ctx.destinationId,
      destinationId: ctx.destinationId,
      timezone: this.timezone,
      location: {latitude: this.latitude, longitude: this.longitude},
    } as Entity;

    return [park, ...rideEntities, ...tivoliRestaurantEntities({items: restaurants}, ctx)];
  }

  // ── Live data ──────────────────────────────────────────────

  /**
   * Deliberately empty. There is no live source: the feed's ride `status` is
   * "in service this season", not "operating now" (see the note at the top of
   * this file), and no wait times have been found. Opening hours are published
   * as schedules instead. The base class throws when this is not implemented,
   * so the empty result is stated here rather than left out.
   */
  protected async buildLiveData(): Promise<LiveData[]> {
    return [];
  }

  // ── Schedules ──────────────────────────────────────────────

  protected async buildSchedules(): Promise<EntitySchedule[]> {
    const {from, to} = tivoliDateWindow(new Date(), this.timezone, SCHEDULE_WINDOW_DAYS);

    const parkResp = await this.fetchParkHours(from, to);
    const parkHours = await parkResp.json();
    const parkSchedule = tivoliScheduleEntries(parkHours?.hours ?? [], this.timezone);

    const rides = await this.getRides();
    const crmIds = rides.map(r => r.properties.crmId).filter((id): id is string => Boolean(id));
    const rideResp = await this.fetchRideHours(crmIds, from, to);
    const rideSchedules = tivoliRideSchedules(rides, (await rideResp.json()) as TivoliBatchHours, this.timezone);

    return [{id: 'tivoligardens', schedule: parkSchedule} as EntitySchedule, ...rideSchedules];
  }
}

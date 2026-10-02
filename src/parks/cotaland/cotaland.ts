import {Destination, DestinationConstructor, attachRaw, type WithRaw} from '../../destination.js';
import config from '../../config.js';
import {cache} from '../../cache.js';
import {http, HTTPObj} from '../../http.js';
import {destinationController} from '../../destinationRegistry.js';
import {constructDateTime, formatDate, shiftDateString} from '../../datetime.js';
import {decodeHtmlEntities, stripHtmlTags} from '../../htmlUtils.js';
import {createStatusMap} from '../../statusMap.js';
import {AttractionTypeEnum, type Entity, type EntitySchedule, type LiveData, type ScheduleEntry} from '@themeparks/typelib';

const DESTINATION_ID = 'cotaland';
const PARK_ID = 'cotaland-park';

/** The park's main gate, as published on the app's own "Park Entrance" point. */
const PARK_LOCATION = {latitude: 30.136726, longitude: -97.6403336};

/** The app's published point-of-interest list, relative to apiBase. */
const POI_PATH = 'api/pointsOfInterest.json';

/** The Events Calendar REST route that backs the website's park-hours page, relative to webBase. */
const EVENTS_PATH = 'wp-json/tribe/events/v1/events';

/** The Events Calendar caps a page at 50 events. */
const EVENTS_PER_PAGE = 50;

/** Safety stop on pagination, far beyond anything the hours calendar publishes. */
const MAX_EVENT_PAGES = 20;

export interface CotalandCategory {
  id: number;
  name: string;
}

/** One entry of the app's point-of-interest list. */
export interface CotalandPoi {
  id: number;
  name: string;
  description_html?: string | null;
  /** Free text set by park operations. Only "Open" has been observed. */
  status?: string | null;
  /** Minutes. Null on every ride outside opening hours. */
  waitTime?: number | null;
  latitude?: number | string | null;
  longitude?: number | string | null;
  categories?: CotalandCategory[];
  isActive?: boolean;
}

export interface CotalandPoiFeed {
  /** When the park's publishing job last wrote the file, ISO 8601 UTC. */
  timestamp?: string;
  data?: CotalandPoi[];
}

/** One event from the website's hours calendar. Times are park-local wall-clock. */
export interface CotalandCalendarEvent {
  id: number;
  title: string;
  /** "YYYY-MM-DD HH:mm:ss", in `timezone`. */
  start_date: string;
  /** "YYYY-MM-DD HH:mm:ss", in `timezone`. */
  end_date: string;
  all_day?: boolean;
  timezone?: string;
}

export interface CotalandCalendarPage {
  events?: CotalandCalendarEvent[];
  total_pages?: number;
}

/**
 * Attractions-category points that are not attractions at all: a separate
 * paid venue next door (Speed City), a sculpture ("Perfect Hug") and a garden
 * (Rose Garden). The feed gives no signal that separates them from the rides.
 */
const NOT_AN_ATTRACTION = new Set(['6333', '6307', '6313']);

/** Attractions-category points that are play areas rather than rides. */
const PLAY_AREAS = new Set(['6324']); // Splash Pad

/**
 * Uncategorised points that are walk-through attractions. The feed files the
 * Flutterarium Butterfly Experience under no category at all.
 */
const UNCATEGORISED_WALKTHROUGHS = new Set(['6319']);

const ENTITY_TYPE_BY_CATEGORY: Record<string, 'ATTRACTION' | 'SHOW' | 'RESTAURANT'> = {
  attractions: 'ATTRACTION',
  entertainment: 'SHOW',
  food: 'RESTAURANT',
};

const mapStatus = createStatusMap({
  OPERATING: ['open'],
  CLOSED: ['closed', ''],
  DOWN: ['down', 'temporarily closed', 'delayed', 'weather delay'],
  REFURBISHMENT: ['refurbishment', 'maintenance'],
}, {parkName: 'COTALAND'});

function cleanText(value: string | null | undefined): string {
  return decodeHtmlEntities(stripHtmlTags(value ?? '')).replace(/\s+/g, ' ').trim();
}

function coordinate(value: number | string | null | undefined): number {
  if (value === '' || value == null) return NaN;
  return Number(value);
}

/**
 * Classify a point. Returns undefined for anything that is not published
 * (restrooms, shops, services, games, areas, and the exclusions above).
 */
export function cotalandEntityType(poi: CotalandPoi): {entityType: 'ATTRACTION' | 'SHOW' | 'RESTAURANT'; attractionType?: AttractionTypeEnum} | undefined {
  const id = String(poi.id);
  if (UNCATEGORISED_WALKTHROUGHS.has(id)) return {entityType: 'ATTRACTION', attractionType: AttractionTypeEnum.RIDE};
  if (NOT_AN_ATTRACTION.has(id)) return undefined;

  const entityType = (poi.categories ?? [])
    .map(category => ENTITY_TYPE_BY_CATEGORY[(category?.name ?? '').trim().toLowerCase()])
    .find(Boolean);
  if (!entityType) return undefined;
  if (entityType !== 'ATTRACTION') return {entityType};
  return {entityType, attractionType: PLAY_AREAS.has(id) ? AttractionTypeEnum.OTHER : AttractionTypeEnum.RIDE};
}

/**
 * Entities from the point feed. With `includeRaw`, each carries its point
 * under `pointsOfInterest`.
 */
export function cotalandEntities(pois: CotalandPoi[], timezone: string, includeRaw = false): Entity[] {
  return pois.flatMap(poi => {
    if (poi.isActive === false) return [];
    const type = cotalandEntityType(poi);
    if (!type) return [];

    const name = cleanText(poi.name);
    if (!name) return [];

    const description = cleanText(poi.description_html);
    const latitude = coordinate(poi.latitude);
    const longitude = coordinate(poi.longitude);
    const entity = {
      id: String(poi.id),
      name,
      entityType: type.entityType,
      ...(type.attractionType ? {attractionType: type.attractionType} : {}),
      parentId: PARK_ID,
      destinationId: DESTINATION_ID,
      timezone,
      ...(description ? {description} : {}),
      ...(Number.isFinite(latitude) && Number.isFinite(longitude) ? {location: {latitude, longitude}} : {}),
    } as Entity;
    if (includeRaw) attachRaw(entity, 'pointsOfInterest', poi);
    return [entity];
  });
}

/**
 * Turn the hours calendar into schedule entries.
 *
 * Every event on this calendar is a block of park hours, titled "Park Open",
 * "PARK OPEN", "Grand Opening" or "F1 Weekend Blackout (Must Have F1 Ticket)".
 * The last is still a full operating day, open to F1 ticket holders only, so it
 * is published as OPERATING with the restriction kept as the description.
 * Anything titled otherwise is skipped with a warning rather than guessed at.
 *
 * With `includeRaw`, each entry carries its event under `calendarPage`.
 */
export function cotalandScheduleEntries(events: CotalandCalendarEvent[], timezone: string, includeRaw = false): ScheduleEntry[] {
  const entries: ScheduleEntry[] = [];
  const parse = (value: string) => value?.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/);

  for (const event of events) {
    const title = cleanText(event.title);
    const isBlackout = /\bblackout\b/i.test(title);
    if (!isBlackout && !/\bopen(ing)?\b/i.test(title)) {
      console.warn(`[COTALAND] Unrecognised hours calendar entry "${title}" (${event.start_date}), skipped`);
      continue;
    }
    const start = parse(event.start_date);
    const end = parse(event.end_date);
    if (event.all_day || !start || !end) {
      console.warn(`[COTALAND] Hours calendar entry "${title}" has no usable times (${event.start_date} - ${event.end_date}), skipped`);
      continue;
    }

    const tz = event.timezone || timezone;
    const plain = /^park open$/i.test(title);
    const entry = {
      date: start[1],
      type: 'OPERATING',
      openingTime: constructDateTime(start[1], start[2], tz),
      closingTime: constructDateTime(end[1], end[2], tz),
      ...(plain ? {} : {description: title}),
    } as ScheduleEntry;
    if (includeRaw) attachRaw(entry, 'calendarPage', event);
    entries.push(entry);
  }

  entries.sort((a, b) => a.openingTime.localeCompare(b.openingTime));
  return entries;
}

/** The published block of hours `now` falls inside, if any. */
export function cotalandOpenEntry(schedule: ScheduleEntry[], now: Date): ScheduleEntry | undefined {
  const t = now.getTime();
  return schedule.find(entry => Date.parse(entry.openingTime) <= t && t < Date.parse(entry.closingTime));
}

/** True when `now` falls inside any published block of hours. */
export function cotalandParkIsOpen(schedule: ScheduleEntry[], now: Date): boolean {
  return cotalandOpenEntry(schedule, now) !== undefined;
}

/**
 * Build live data from the point feed.
 *
 * The feed is republished every few minutes, but its `status` is not a live
 * reading on its own: every ride reads "Open" overnight and on closed days.
 * So the three cases are:
 *
 *  - A non-"Open" status (closed, down, ...) is published as given.
 *  - A positive wait time is a live reading and wins over the calendar, so a
 *    ride queueing during unpublished hours still shows as operating.
 *  - "Open" with no positive wait is only believed while the calendar says the
 *    park is open. Outside those hours it is CLOSED. A zero counts as no
 *    reading here, because the feed serves zeros on non-ride points around the
 *    clock.
 *
 * `parkOpen` is null when the calendar could not be read. Rows that depend on
 * it are then left out rather than guessed.
 *
 * With `includeRaw`, each row carries its point under `pointsOfInterest`, and
 * a row the open calendar decided also carries `openHours`, the calendar
 * event in effect, under `calendarPage`. A row the calendar closed has no
 * event behind it: no block of hours covering now is not one row.
 */
export function cotalandLiveData(
  pois: CotalandPoi[],
  entityIds: Set<string>,
  parkOpen: boolean | null,
  includeRaw = false,
  openHours?: unknown,
): LiveData[] {
  const result: LiveData[] = [];
  const push = (ld: LiveData, poi: CotalandPoi, hours?: unknown) => {
    if (includeRaw) {
      attachRaw(ld, 'pointsOfInterest', poi);
      if (hours !== undefined) attachRaw(ld, 'calendarPage', hours);
    }
    result.push(ld);
  };
  for (const poi of pois) {
    const id = String(poi.id);
    if (!entityIds.has(id)) continue;

    const status = mapStatus((poi.status ?? '').trim());
    const wait = poi.waitTime == null ? NaN : Number(poi.waitTime);
    const hasWait = Number.isFinite(wait) && wait >= 0;

    if (status !== 'OPERATING') {
      push({id, status} as LiveData, poi);
      continue;
    }

    if (hasWait && wait > 0) {
      push({id, status: 'OPERATING', queue: {STANDBY: {waitTime: wait}}} as LiveData, poi);
      continue;
    }

    if (parkOpen === null) continue;
    if (!parkOpen) {
      push({id, status: 'CLOSED'} as LiveData, poi);
      continue;
    }

    const ld = {id, status: 'OPERATING'} as LiveData;
    if (hasWait) ld.queue = {STANDBY: {waitTime: wait}};
    push(ld, poi, openHours);
  }
  return result;
}

/** True when the feed's own publish timestamp is older than `maxAgeMinutes`. */
export function cotalandFeedIsStale(timestamp: string | undefined, now: Date, maxAgeMinutes: number): boolean {
  const published = Date.parse(timestamp ?? '');
  if (!Number.isFinite(published)) return true;
  return now.getTime() - published > maxAgeMinutes * 60_000;
}

@destinationController({category: 'COTALAND'})
export class Cotaland extends Destination {
  /** Origin of the app's published JSON feeds. */
  @config apiBase = '';
  /** Origin of the park website, which carries the hours calendar. */
  @config webBase = '';
  @config timezone = 'America/Chicago';
  /** How many days of hours to publish, counting today. */
  @config scheduleDays = 120;
  /** Live data older than this is withheld rather than published as current. */
  @config maxFeedAgeMinutes = 30;

  constructor(options?: DestinationConstructor) {
    super(options);
    this.addConfigPrefix('COTALAND');
  }

  @http({cacheSeconds: 60, retries: 1})
  async fetchPointsOfInterest(): Promise<HTTPObj> {
    return {method: 'GET', url: `${this.apiBase}/${POI_PATH}`, options: {json: true}} as HTTPObj;
  }

  @http({cacheSeconds: 43200, retries: 1, healthCheckArgs: ['{today}', '{date+30}', 1]})
  async fetchCalendarPage(startDate: string, endDate: string, page: number): Promise<HTTPObj> {
    const query = new URLSearchParams({
      start_date: startDate,
      end_date: endDate,
      per_page: String(EVENTS_PER_PAGE),
      page: String(page),
    });
    return {
      method: 'GET',
      url: `${this.webBase}/${EVENTS_PATH}?${query}`,
      options: {json: true},
      tags: ['website'],
    } as HTTPObj;
  }

  async getPointFeed(): Promise<CotalandPoiFeed> {
    return await (await this.fetchPointsOfInterest()).json() as CotalandPoiFeed;
  }

  @cache({ttlSeconds: 43200})
  async getPointsOfInterest(): Promise<CotalandPoi[]> {
    const feed = await this.getPointFeed();
    if (!Array.isArray(feed?.data) || !feed.data.length) {
      throw new Error('COTALAND: point-of-interest feed returned no points');
    }
    return feed.data;
  }

  @cache({ttlSeconds: 43200})
  async getScheduleEntries(): Promise<ScheduleEntry[]> {
    const today = formatDate(new Date(), this.timezone);
    const endDate = shiftDateString(today, this.scheduleDays - 1);

    const events: CotalandCalendarEvent[] = [];
    for (let page = 1; page <= MAX_EVENT_PAGES; page++) {
      const body = await (await this.fetchCalendarPage(today, endDate, page)).json() as CotalandCalendarPage;
      events.push(...(body?.events ?? []));
      if (page >= (body?.total_pages ?? 1)) break;
    }
    return cotalandScheduleEntries(events, this.timezone, this.includeRaw);
  }

  async getDestinations(): Promise<Entity[]> {
    return [{
      id: DESTINATION_ID,
      name: 'COTALAND',
      entityType: 'DESTINATION',
      timezone: this.timezone,
      location: PARK_LOCATION,
    } as Entity];
  }

  protected async buildEntityList(): Promise<Entity[]> {
    const pois = await this.getPointsOfInterest();
    const park = {
      id: PARK_ID,
      name: 'COTALAND',
      entityType: 'PARK',
      parentId: DESTINATION_ID,
      destinationId: DESTINATION_ID,
      timezone: this.timezone,
      location: PARK_LOCATION,
    } as Entity;
    return [park, ...cotalandEntities(pois, this.timezone, this.includeRaw)];
  }

  protected async buildLiveData(): Promise<LiveData[]> {
    const feed = await this.getPointFeed();
    const now = new Date();
    if (cotalandFeedIsStale(feed?.timestamp, now, this.maxFeedAgeMinutes)) {
      console.warn(`[COTALAND] Point feed last published ${feed?.timestamp ?? 'never'}, withholding live data`);
      return [];
    }

    const pois = feed.data ?? [];
    const entityIds = new Set(cotalandEntities(pois, this.timezone).map(entity => entity.id));

    let parkOpen: boolean | null = null;
    let openHours: unknown;
    try {
      const schedule = await this.getScheduleEntries();
      parkOpen = cotalandParkIsOpen(schedule, now);
      // The calendar event behind the block of hours in effect, if the cached
      // entries carry it.
      openHours = (cotalandOpenEntry(schedule, now) as WithRaw<ScheduleEntry> | undefined)?.raw?.calendarPage;
    } catch (err) {
      console.warn(`[COTALAND] Hours calendar unavailable, publishing live readings only: ${(err as Error).message}`);
    }

    return cotalandLiveData(pois, entityIds, parkOpen, this.includeRaw, openHours);
  }

  protected async buildSchedules(): Promise<EntitySchedule[]> {
    const schedule = await this.getScheduleEntries();
    return [{id: PARK_ID, schedule}];
  }
}

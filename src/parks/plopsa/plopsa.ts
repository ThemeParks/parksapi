/**
 * Plopsaland De Panne and Plopsaland Deutschland
 *
 * Both parks share the same new middleware API at
 * apim-stp-gwc-prd-infra.azure-api.net/app-middleware.  The only difference
 * between the two implementations is the `parkParam` passed to every endpoint
 * and, for Deutschland, an affine coordinate transform that converts pixel
 * coordinates on the park-map image to geographic lat/lng.
 *
 * Park-opening-hours endpoint returns HTTP 500 for De Panne.  Both parks
 * therefore use the plopsa.com calendar endpoint instead.
 * The calendar URL structure is:
 *   https://www.plopsa.com/en/{park-slug}/api/opening-hours-calendar
 * Note: De Panne's slug redirected — use the current slug directly.
 */

import {Destination, DestinationConstructor} from '../../destination.js';
import config from '../../config.js';
import {http, HTTPObj} from '../../http.js';
import {CacheLib} from '../../cache.js';
import {destinationController} from '../../destinationRegistry.js';
import type {Entity, LiveData, EntitySchedule, LiveTimeSlot} from '@themeparks/typelib';
import {formatDate, addDays, formatInTimezone, constructDateTime} from '../../datetime.js';
import dePanneLocations from './locations/plopsaland-de-panne.json' with {type: 'json'};

// ── API response types ──────────────────────────────────────────

interface PlopsaContainsItem {
  id: string;
  plopsa_id?: string;
  title?: string | null;
  type: 'attraction' | 'foods_and_drinks' | 'shop' | string;
  height_specs?: {
    min_height?: number;
    min_height_supervised?: number;
    max_height?: number;
  };
  express_pass?: boolean;
  schedule_info?: {
    temporarily_closed?: boolean;
    temporarily_closed_message?: string;
  };
}

interface PlopsaPOIItem {
  id: string;
  title: string;
  type: {
    label: string;
  };
  map_coordinates?: {x: number; y: number};
  contains?: PlopsaContainsItem[];
}

interface PlopsaPOIResponse {
  items: PlopsaPOIItem[];
}

interface PlopsaScheduleTimeslot {
  type: string;
  start_time: string;
  end_time: string | null;
}

interface PlopsaScheduleDay {
  date: string;
  timeslots: PlopsaScheduleTimeslot[];
  reserved?: boolean;
}

interface PlopsaEntertainmentItem {
  id: string;
  plopsa_id?: string;
  title: string;
  type: {
    label: string;
  };
  schedule_info?: {
    temporarily_closed?: boolean;
    schedule?: PlopsaScheduleDay[];
  };
  poi?: {
    id: string;
    title: string;
  };
}

interface PlopsaEntertainmentResponse {
  items: PlopsaEntertainmentItem[];
}

type PlopsaWaitTimesResponse = Record<string, number>;

interface PlopsaTodayHours {
  date: string;
  timeslots?: Array<{type: string; start_time: string; end_time: string}>;
}

/** YYYY-MM-DD for today in the given timezone. */
function formatTodayInTimezone(tz: string): string {
  const raw = formatInTimezone(new Date(), tz, 'date');  // MM/DD/YYYY
  const [mm, dd, yyyy] = raw.split('/');
  return `${yyyy}-${mm}-${dd}`;
}

export type PlopsaAttractionStatus = 'OPERATING' | 'DOWN' | 'CLOSED';

/**
 * Decide the live status of a Plopsa ride right now.
 *
 * Inputs are intentionally flat booleans + a primitive — pure function so
 * the matrix is easy to unit-test (see `__tests__/plopsa.test.ts`).
 *
 * A *positive* wait-times reading is treated as ground truth: it means the
 * ride is taking guests right now, so it wins over a stale POI
 * `temporarily_closed` hint. Without that priority, a stale 12h-cached POI
 * snapshot on one collector instance disagreeing with another instance's
 * cached snapshot causes lockstep OPERATING ↔ DOWN flapping for the
 * affected rides.
 *
 * `hasWait` must only be true for a genuine positive reading — the
 * waiting-times feed returns `0` for every ride (including ones POI marks
 * `temporarily_closed`) whenever it has no live signal, so `0` is not
 * evidence the ride is open and must not override the POI hint.
 */
export function plopsaDecideStatus(
  parkOpenNow: boolean,
  tempClosed: boolean,
  hasWait: boolean,
): PlopsaAttractionStatus {
  if (!parkOpenNow) return 'CLOSED';
  if (hasWait || !tempClosed) return 'OPERATING';
  return 'DOWN';
}

/** Is the park currently within an "open" timeslot from today's hours? */
function isParkOpenNow(hours: PlopsaTodayHours | null, tz: string): boolean {
  if (!hours?.timeslots?.length) return false;
  // Pull HH:MM out of the ISO string the framework's helper produces.
  const iso = formatInTimezone(new Date(), tz, 'iso');  // YYYY-MM-DDTHH:MM:SS±HH:MM
  const nowHM = iso.substring(11, 16);
  for (const slot of hours.timeslots) {
    if (slot.type !== 'open') continue;
    if (slot.start_time <= nowHM && nowHM < slot.end_time) return true;
  }
  return false;
}

/**
 * Build the live showtimes for a single entertainment item on a given date.
 *
 * The entertainments feed lists per-day `open` timeslots as HH:MM start times
 * with no end (point-in-time performances). Start times are normalised to
 * ISO+offset for the park timezone; end times are only emitted when the feed
 * provides one, otherwise null. Slots for other dates or non-`open` types are
 * ignored.
 */
export function plopsaBuildShowtimes(
  schedule: PlopsaScheduleDay[] | undefined,
  date: string,
  timezone: string,
): LiveTimeSlot[] {
  const day = (schedule ?? []).find((d) => d.date === date);
  const showtimes: LiveTimeSlot[] = [];

  for (const slot of day?.timeslots ?? []) {
    if (slot.type !== 'open' || !slot.start_time) continue;
    showtimes.push({
      type: 'Showtime',
      startTime: constructDateTime(date, slot.start_time, timezone),
      endTime: slot.end_time ? constructDateTime(date, slot.end_time, timezone) : null,
    });
  }

  return showtimes;
}

/**
 * Decide a show's live status from today's performances: OPERATING while a
 * performance is still upcoming or ongoing, then CLOSED once the day's last
 * one has ended. The feed omits end times, so each slot's end falls back to
 * its start. The full day's schedule stays published in `showtimes`.
 */
export function plopsaShowStatus(showtimes: LiveTimeSlot[], nowMs: number): 'OPERATING' | 'CLOSED' {
  const hasUpcoming = showtimes.some((slot) => {
    const end = slot.endTime ?? slot.startTime;
    return end != null && Date.parse(end) > nowMs;
  });
  return hasUpcoming ? 'OPERATING' : 'CLOSED';
}

interface CalendarDaySlot {
  type: string;
  /** Full ISO datetime string, e.g. '2026-04-01T10:00:00+02:00' */
  start_time: string;
  end_time: string | null;
}

interface CalendarDay {
  sold_out?: boolean;
  slots?: CalendarDaySlot[];
}

interface PlopsaCalendarResponse {
  schedule: Record<
    string,  // month key e.g. "2026-04"
    Record<string, CalendarDay>  // day key e.g. "2026-04-01" -> day data
  >;
}

// ── Base class ─────────────────────────────────────────────────

@config
class PlopsaBase extends Destination {
  /**
   * Base URL for the Plopsa middleware API.
   * May be configured via PLOPSA_BASEURL or PLOPSALAND*_BASEURL env vars.
   * Accepts both '.../app-middleware' and '.../app-middleware/api' formats.
   */
  @config baseURL: string = '';

  /**
   * Returns baseURL with any trailing '/api' stripped, so the /api/ segment
   * in HTTP method paths is never doubled regardless of env var format.
   */
  get apiBase(): string {
    const url = this.baseURL;
    return url.endsWith('/api') ? url.slice(0, -4) : url;
  }

  /** Language to use for all single-language API calls (wait times, hours, calendar) */
  apiLanguage: string = 'en';

  /**
   * Languages to query when building the entity list, in preference order.
   * The middleware's translated POI/entertainment feeds are maintained
   * independently per language and can drift out of sync — a newly added
   * attraction sometimes lands in the native-language feed weeks before the
   * English translation catches up (e.g. Draconis at Plopsaland De Panne,
   * present in `nl` but absent from `en` for a while). We fetch every
   * language in this list and merge: the first language that has a given
   * attraction/show wins for its name, later languages only fill in
   * entities missing from earlier ones. Defaults to just `apiLanguage`;
   * subclasses add their native language as a second source.
   */
  languages: string[] = ['en'];

  /** park= query parameter for the middleware API */
  parkParam: string = '';

  /** Destination-level entity ID (e.g. 'plopsaland-de-panne') */
  destinationId: string = '';

  /** Park-level entity ID (e.g. 'plopsaland') */
  parkId: string = '';

  /** Park display name */
  parkName: string = '';

  /** IANA timezone */
  timezone: string = 'Europe/Brussels';

  /** Park coordinates */
  parkLat: number = 0;
  parkLng: number = 0;

  /** Full URL for the plopsa.com opening-hours calendar endpoint */
  @config calendarUrl: string = '';

  constructor(options?: DestinationConstructor) {
    super(options);
    this.addConfigPrefix('PLOPSA');
  }

  getCacheKeyPrefix(): string {
    return `plopsa:${this.parkParam}`;
  }

  // ── HTTP methods ──────────────────────────────────────────────

  /**
   * The POI feed is mostly cold metadata (titles, images, height specs), but it
   * is also the *only* carrier of `schedule_info.temporarily_closed` — live
   * state that flips several times a day. Plopsaland's two splash rides open a
   * few hours after the park does and are flagged closed until they do; rides
   * also break down mid-afternoon.
   *
   * So this cannot be cached like metadata. It used to sit at 12h, which let a
   * snapshot taken while a ride was open report OPERATING for the rest of the
   * day after it closed — `plopsaDecideStatus` reads `!tempClosed` as "open",
   * so a stale FALSE surfaces as "Open, 0 min". (The reverse, a stale TRUE
   * after a ride opens, is already rescued by the `hasWait` priority.)
   *
   * 5 minutes tracks the flag closely enough while still collapsing the
   * per-poll fetches of a collector running on a shorter interval. The feed is
   * ~220 KB per language, and `languages` holds one or two entries per park.
   *
   * The shorter TTL puts this fetch on the live path — it now runs on almost
   * every poll instead of twice a day, and `buildLiveData` awaits it without a
   * fallback, so a single transient failure would cost the park's entire live
   * data for that poll. `retries: 3` gives a ~7s exponential-backoff window
   * (1+2+4, ±10% jitter — see `calculateBackoffDelay` in src/http.ts), same
   * reasoning as the note on `fetchTodayHours`.
   */
  @http({cacheSeconds: 60 * 5, retries: 3})
  async fetchPOI(language: string = this.apiLanguage): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.apiBase}/api/points-of-interest`,
      queryParams: {language, park: this.parkParam},
      options: {json: true},
    } as any as HTTPObj;
  }

  @http({cacheSeconds: 60})
  async fetchWaitTimes(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.apiBase}/api/attractions/waiting-times`,
      queryParams: {language: this.apiLanguage, park: this.parkParam},
      options: {json: true},
    } as any as HTTPObj;
  }

  @http({cacheSeconds: 60 * 60 * 6})
  async fetchEntertainments(language: string = this.apiLanguage): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.apiBase}/api/entertainments`,
      queryParams: {language, park: this.parkParam},
      options: {json: true},
    } as any as HTTPObj;
  }

  @http({cacheSeconds: 60 * 60 * 12})
  async fetchCalendar(startDate: string, endDate: string): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: this.calendarUrl,
      queryParams: {start: startDate, end: endDate},
      options: {json: true},
    } as any as HTTPObj;
  }

  /**
   * Today's park hours. The API endpoint without `openOn` returns 500;
   * always pin a date.
   *
   * `retries: 5` gives a ~31s exponential-backoff window
   * (1+2+4+8+16, ±10% jitter — see `calculateBackoffDelay` in
   * src/http.ts). Without retries (and especially when running multiple
   * collector instances), a single transient failure here causes
   * `parkOpenNow` to evaluate false in `buildLiveData`, which marks
   * every ride as CLOSED for that poll — exactly the kind of lockstep
   * flapping that previously surfaced in wiki history.
   */
  @http({cacheSeconds: 60 * 30, retries: 5})
  async fetchTodayHours(date: string): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.apiBase}/api/park-opening-hours`,
      queryParams: {language: this.apiLanguage, park: this.parkParam, openOn: date},
      options: {json: true},
    } as any as HTTPObj;
  }

  // ── Helpers ───────────────────────────────────────────────────

  /** Extract a stable entity ID for an item: prefer plopsa_id, fall back to id. */
  protected entityId(item: {id: string; plopsa_id?: string}): string {
    return String(item.plopsa_id || item.id);
  }

  /** Fetch the POI feed for every language in `this.languages`, in order. */
  protected async fetchPOIAllLanguages(): Promise<PlopsaPOIResponse[]> {
    const responses = await Promise.all(this.languages.map((lang) => this.fetchPOI(lang)));
    return Promise.all(responses.map((resp) => resp.json() as Promise<PlopsaPOIResponse>));
  }

  /** Fetch the entertainments feed for every language in `this.languages`, in order. */
  protected async fetchEntertainmentsAllLanguages(): Promise<PlopsaEntertainmentResponse[]> {
    const responses = await Promise.all(this.languages.map((lang) => this.fetchEntertainments(lang)));
    return Promise.all(responses.map((resp) => resp.json() as Promise<PlopsaEntertainmentResponse>));
  }

  /**
   * Convert map pixel coordinates to lat/lng.
   * Default implementation returns undefined (no transform for De Panne).
   * Overridden in PlopsalandDeutschland.
   */
  protected mapCoordinates(
    _coords: {x: number; y: number} | undefined,
  ): {latitude: number; longitude: number} | undefined {
    return undefined;
  }

  /**
   * Optional snapshot of per-POI coordinates, keyed by POI title. The
   * middleware feed only exposes map-image pixel coordinates (`map_coordinates`),
   * not lat/lng, and De Panne has no pixel→geo transform (see `mapCoordinates`).
   * De Panne therefore loads a static JSON snapshot of hand-verified ride and
   * restaurant coordinates (see `locations/plopsaland-de-panne.json`), assigned
   * in the subclass constructor. POIs added by Plopsa later land without
   * coordinates until the snapshot is refreshed.
   */
  protected poiLocations?: Record<string, {latitude: number; longitude: number}>;

  /** Lazily-built lookup for poiLocations, keyed by normalized title. */
  private normalizedPoiLocations?: Map<string, {latitude: number; longitude: number}>;

  /**
   * Normalize POI titles for matching. The feed and the snapshot can differ in
   * apostrophe style (’ U+2019 vs ') and case; fold both to one form.
   */
  private normalizePoiTitle(title: string): string {
    return title.replace(/[‘’]/g, "'").toLowerCase();
  }

  /** Look up a hand-verified coordinate for a POI by its title, if any. */
  protected lookupPoiLocation(
    title: string | null | undefined,
  ): {latitude: number; longitude: number} | undefined {
    if (!this.poiLocations || !title) return undefined;
    if (!this.normalizedPoiLocations) {
      this.normalizedPoiLocations = new Map(
        Object.entries(this.poiLocations).map(
          ([k, v]) => [this.normalizePoiTitle(k), v] as const,
        ),
      );
    }
    return this.normalizedPoiLocations.get(this.normalizePoiTitle(title));
  }

  // ── Destination ───────────────────────────────────────────────

  async getDestinations(): Promise<Entity[]> {
    return [{
      id: this.destinationId,
      name: this.parkName,
      entityType: 'DESTINATION',
      timezone: this.timezone,
      location: {latitude: this.parkLat, longitude: this.parkLng},
    } as Entity];
  }

  // ── Entity building ───────────────────────────────────────────

  protected async buildEntityList(): Promise<Entity[]> {
    const [poiByLanguage, entByLanguage] = await Promise.all([
      this.fetchPOIAllLanguages(),
      this.fetchEntertainmentsAllLanguages(),
    ]);

    const entities: Entity[] = [];

    // Park entity (destination is returned by getDestinations())
    const parkEntity: Entity = {
      id: this.parkId,
      name: this.parkName,
      entityType: 'PARK',
      parentId: this.destinationId,
      destinationId: this.destinationId,
      timezone: this.timezone,
    } as Entity;
    if (this.parkLat && this.parkLng) {
      (parkEntity as any).location = {latitude: this.parkLat, longitude: this.parkLng};
    }
    entities.push(parkEntity);

    // Attractions and restaurants from POI. Iterate languages in preference
    // order and skip any id already seen — the first (preferred) language
    // that carries a given attraction/restaurant wins its name/coords, and
    // later languages only contribute entities missing from earlier ones
    // (see `languages` doc comment for why translated feeds can drift).
    const seenPoiIds = new Set<string>();
    for (const poiData of poiByLanguage) {
      for (const poi of poiData?.items ?? []) {
        // Fallback pixel→geo coords for the whole POI (Deutschland only).
        const poiCoords = this.mapCoordinates(poi.map_coordinates);

        for (const item of poi.contains ?? []) {
          const title = typeof item.title === 'string' ? item.title : '';
          if (!title) continue;
          if (item.type !== 'attraction' && item.type !== 'foods_and_drinks') continue;

          const id = this.entityId(item);
          if (seenPoiIds.has(id)) continue;
          seenPoiIds.add(id);

          const entity: Entity = {
            id,
            name: title,
            entityType: item.type === 'attraction' ? 'ATTRACTION' : 'RESTAURANT',
            parentId: this.parkId,
            destinationId: this.destinationId,
            timezone: this.timezone,
          } as Entity;
          // Prefer the hand-verified per-title snapshot, then the pixel transform.
          const coords = this.lookupPoiLocation(title) ?? poiCoords;
          if (coords) {
            (entity as any).location = coords;
          }
          entities.push(entity);
        }
      }
    }

    // Shows / Meet-and-greets from entertainments list — same first-language-wins merge.
    const seenShowIds = new Set<string>();
    for (const entData of entByLanguage) {
      for (const item of entData?.items ?? []) {
        const label = item.type?.label ?? '';
        if (label !== 'Show' && label !== 'Meet&Greet') continue;

        const id = this.entityId({id: item.id, plopsa_id: item.plopsa_id});
        if (seenShowIds.has(id)) continue;
        seenShowIds.add(id);

        const entity: Entity = {
          id,
          name: item.title,
          entityType: 'SHOW',
          parentId: this.parkId,
          destinationId: this.destinationId,
          timezone: this.timezone,
        } as Entity;

        // Use park location as fallback for shows
        if (this.parkLat && this.parkLng) {
          (entity as any).location = {latitude: this.parkLat, longitude: this.parkLng};
        }

        entities.push(entity);
      }
    }

    return entities;
  }

  // ── Live data ─────────────────────────────────────────────────

  protected async buildLiveData(): Promise<LiveData[]> {
    const today = formatTodayInTimezone(this.timezone);

    const [waitResp, poiByLanguage, hoursResp, entByLanguage] = await Promise.all([
      this.fetchWaitTimes(),
      this.fetchPOIAllLanguages(),
      this.fetchTodayHours(today).catch(() => null),
      this.fetchEntertainmentsAllLanguages().catch(() => [] as PlopsaEntertainmentResponse[]),
    ]);

    const waitTimes = (await waitResp.json()) as PlopsaWaitTimesResponse;

    const hoursData = hoursResp ? (await hoursResp.json()) as PlopsaTodayHours : null;

    // Per-attraction temporarily-closed flag from POI, merged across
    // languages (first language wins, same preference order as
    // buildEntityList) so a ride missing from the primary-language feed
    // still gets its closed flag from whichever language does carry it.
    const closedById = new Map<string, boolean>();
    for (const poiData of poiByLanguage) {
      for (const poi of poiData?.items ?? []) {
        for (const item of poi.contains ?? []) {
          if (item.type !== 'attraction') continue;
          const id = this.entityId(item);
          if (closedById.has(id)) continue;
          closedById.set(id, !!item.schedule_info?.temporarily_closed);
        }
      }
    }

    // Whether the park is operating right now. The wait-times feed keeps
    // returning per-ride numbers (mostly 0/1 noise) outside park hours, so
    // we explicitly mark everything CLOSED in that window — the alternative
    // is "Closed. Wait time: 1 minute" inconsistency in the wiki.
    //
    // `parkOpenNow` MUST NOT flicker on transient failures of
    // `fetchTodayHours`: a single false reading flips every ride to CLOSED
    // for that poll, which manifests as park-wide lockstep flapping in the
    // wiki history.
    //
    // We only trust the upstream response if it carries a non-empty
    // `timeslots` array — anything else (network failure, truthy-but-empty
    // body like `{}`, or `{timeslots: []}`) is treated as "no fresh
    // signal" and we fall back to the last-known-TRUE in cache. Parks
    // rarely shut mid-day, so once we've seen "open" today we trust it
    // for the rest of the hour; otherwise we re-attempt every poll.
    //
    // Caching is one-way: we persist TRUE for an hour but never FALSE. A
    // previous code revision cached both, which let one quirky upstream
    // response lock a sibling collector into CLOSED for an hour and
    // produce lockstep flapping when paired with a sibling that had cached
    // TRUE. The cache key carries a `:v2` suffix so any cached FALSE from
    // that revision is unreachable on first deploy.
    const openCacheKey = `${this.getCacheKeyPrefix()}:parkOpenNow:v2:${today}`;
    const hasValidHours =
      Array.isArray(hoursData?.timeslots) && hoursData.timeslots.length > 0;
    let parkOpenNow: boolean;
    if (hasValidHours) {
      parkOpenNow = isParkOpenNow(hoursData, this.timezone);
      if (parkOpenNow) {
        CacheLib.set(openCacheKey, true, 60 * 60); // 1h, only cache TRUE
      }
    } else {
      const cached = CacheLib.get(openCacheKey);
      parkOpenNow = cached === true; // only fall back to a known-TRUE
    }

    const lastUpdated = new Date().toISOString();

    // Attraction live data, keyed off the wait-times feed.
    const rideLiveData = Object.entries(waitTimes ?? {}).map(([attractionId, waitTime]) => {
      const id = String(attractionId);
      const tempClosed = closedById.get(id) === true;
      // A raw `0` is the feed's default/no-signal value — it shows up for
      // every ride, even ones POI marks temporarily_closed — so only a
      // strictly positive reading counts as live evidence the ride is open.
      const rawWait = typeof waitTime === 'number' ? waitTime : null;
      const hasWait = rawWait !== null && rawWait > 0;
      const status = plopsaDecideStatus(parkOpenNow, tempClosed, hasWait);

      if (status !== 'OPERATING') {
        return {id, status, lastUpdated} as unknown as LiveData;
      }
      return {
        id,
        status: 'OPERATING',
        queue: {
          STANDBY: {waitTime: rawWait},
        },
        lastUpdated,
      } as unknown as LiveData;
    });

    // Show / meet-and-greet live data. The entertainments fetch is gated by its
    // own catch above: this method is not wrapped in a try/catch by the base
    // class, so an unguarded rejection here would reject the whole poll and take
    // the ride live data down with it. A failing entertainments feed therefore
    // drops only the shows. Today's performances are attached as showtimes and
    // the show is CLOSED once the last one has passed.
    const nowMs = Date.now();
    const showLiveData: LiveData[] = [];
    const seenLiveShowIds = new Set<string>();
    for (const entData of entByLanguage) {
      for (const item of entData?.items ?? []) {
        const label = item.type?.label ?? '';
        if (label !== 'Show' && label !== 'Meet&Greet') continue;

        const id = this.entityId({id: item.id, plopsa_id: item.plopsa_id});
        if (seenLiveShowIds.has(id)) continue;
        seenLiveShowIds.add(id);

        const showtimes = plopsaBuildShowtimes(item.schedule_info?.schedule, today, this.timezone);
        const ld = {
          id,
          status: plopsaShowStatus(showtimes, nowMs),
          lastUpdated,
        } as unknown as LiveData;
        if (showtimes.length > 0) {
          (ld as {showtimes?: LiveTimeSlot[]}).showtimes = showtimes;
        }
        showLiveData.push(ld);
      }
    }

    return [...rideLiveData, ...showLiveData];
  }

  // ── Schedules ─────────────────────────────────────────────────

  protected async buildSchedules(): Promise<EntitySchedule[]> {
    const schedules: EntitySchedule[] = [];

    // The park calendar and the show schedules come from separate feeds, so
    // they are built independently: a failure fetching one must not discard
    // the other. The park entry is only emitted when the calendar yields days.
    const parkSchedule = await this.buildParkSchedule();
    if (parkSchedule.length > 0) {
      schedules.push({id: this.parkId, schedule: parkSchedule} as EntitySchedule);
    }

    schedules.push(...await this.buildShowSchedules());

    return schedules;
  }

  /** Park operating hours for the next ~90 days from the calendar endpoint. */
  private async buildParkSchedule(): Promise<EntitySchedule['schedule']> {
    const now = new Date();
    const startDate = formatDate(now, this.timezone);
    const endDate = formatDate(addDays(now, 90), this.timezone);

    let calendarData: PlopsaCalendarResponse;
    try {
      const resp = await this.fetchCalendar(startDate, endDate);
      calendarData = (await resp.json()) as PlopsaCalendarResponse;
    } catch {
      return [];
    }

    if (!calendarData?.schedule) return [];

    const schedule: EntitySchedule['schedule'] = [];

    // Calendar: {schedule: {month: {date: {slots: [{start_time: ISO, end_time: ISO}]}}}}
    for (const monthData of Object.values(calendarData.schedule)) {
      if (!monthData || typeof monthData !== 'object') continue;
      for (const [dateKey, dayData] of Object.entries(monthData)) {
        if (dayData.sold_out) continue;
        if (!dayData.slots?.length) continue;

        for (const slot of dayData.slots) {
          if (slot.type !== 'open') continue;
          if (!slot.start_time || !slot.end_time) continue;

          schedule.push({
            date: dateKey,
            type: 'OPERATING',
            // Slots already have full ISO timestamps with correct offsets
            openingTime: slot.start_time,
            closingTime: slot.end_time,
          } as any);
        }
      }
    }

    return schedule;
  }

  /**
   * Per-show operating schedules from the entertainments feed, merged
   * across languages (first-wins, same as buildEntityList) so a show
   * whose schedule only appears in a secondary-language feed isn't dropped.
   */
  private async buildShowSchedules(): Promise<EntitySchedule[]> {
    let entByLanguage: PlopsaEntertainmentResponse[];
    try {
      entByLanguage = await this.fetchEntertainmentsAllLanguages();
    } catch {
      return [];
    }

    const showSchedules: EntitySchedule[] = [];
    const seenShowScheduleIds = new Set<string>();

    for (const entData of entByLanguage) {
      for (const item of entData?.items ?? []) {
        const label = item.type?.label ?? '';
        if (label !== 'Show' && label !== 'Meet&Greet') continue;

        const showId = this.entityId({id: item.id, plopsa_id: item.plopsa_id});
        if (seenShowScheduleIds.has(showId)) continue;

        const showSchedule: EntitySchedule['schedule'] = [];

        for (const day of item.schedule_info?.schedule ?? []) {
          for (const slot of day.timeslots ?? []) {
            if (slot.type !== 'open' || !slot.start_time) continue;
            // Show timeslots use HH:MM strings, not full ISO, so the park offset
            // has to be applied — the same call the live path makes in
            // plopsaBuildShowtimes. Concatenating the strings instead left the
            // time with NO offset, which anything parsing it as an instant
            // resolves in its own timezone rather than the park's.
            const openingTime = constructDateTime(day.date, slot.start_time, this.timezone);
            showSchedule.push({
              date: day.date,
              type: 'OPERATING',
              openingTime,
              closingTime: slot.end_time
                ? constructDateTime(day.date, slot.end_time, this.timezone)
                : openingTime,
            } as any);
          }
        }

        if (showSchedule.length > 0) {
          seenShowScheduleIds.add(showId);
          showSchedules.push({id: showId, schedule: showSchedule} as EntitySchedule);
        }
      }
    }

    return showSchedules;
  }
}

// ── Plopsaland De Panne ────────────────────────────────────────

@destinationController({category: 'Plopsa'})
export class Plopsaland extends PlopsaBase {
  constructor(options?: DestinationConstructor) {
    super(options);
    this.addConfigPrefix('PLOPSALAND');

    this.parkParam = 'plopsaland-de-panne';
    this.destinationId = 'plopsaland-de-panne';
    this.parkId = 'plopsaland';
    this.parkName = 'Plopsaland De Panne';
    this.timezone = 'Europe/Brussels';
    this.parkLat = 51.0808363;
    this.parkLng = 2.5957221;
    // English is preferred for names; Dutch is the park's native feed and
    // sometimes carries attractions/shows before the English translation
    // catches up (see `languages` doc comment).
    this.languages = ['en', 'nl'];
    // Hand-verified per-POI coordinates: the middleware feed has no ride-level
    // lat/lng and De Panne has no pixel→geo transform. See locations/README.
    this.poiLocations = dePanneLocations as Record<string, {latitude: number; longitude: number}>;
    // calendarUrl: the /en/plopsaland-de-panne/ slug redirects to /en/plopsaland-belgium/
    // so use the redirect target. Set via PLOPSALAND_CALENDARURL env var.
  }
}

// ── Plopsaland Deutschland ─────────────────────────────────────

/**
 * Least-squares affine transform coefficients for converting Plopsaland
 * Deutschland map image pixel coordinates (x, y) to geographic coordinates.
 *
 * Computed once at module load time from the known control points below.
 */
interface AffineCoefficients {
  a: number; b: number; c: number; // lon = a*x + b*y + c
  d: number; e: number; f: number; // lat = d*x + e*y + f
}

function computeDeutschlandTransform(): AffineCoefficients {
  const controlPoints = [
    // Sky Scream
    {pixel: {x: 1301, y: 457}, geo: {lat: 49.319340577718215, lon: 8.29254336959917}},
    // lighthouse tower
    {pixel: {x: 1237, y: 315}, geo: {lat: 49.31888886637556, lon: 8.29163056371229}},
    // dinosplash
    {pixel: {x: 954, y: 1019}, geo: {lat: 49.3187872288459, lon: 8.297126723709829}},
    // splash battle
    {pixel: {x: 1105, y: 810}, geo: {lat: 49.31921368348008, lon: 8.295472339476438}},
    // beach rescue
    {pixel: {x: 1103, y: 298}, geo: {lat: 49.31859964484687, lon: 8.29199916066343}},
    // smurfs adventure
    {pixel: {x: 1131, y: 991}, geo: {lat: 49.319341, lon: 8.296514}},
    // red baron
    {pixel: {x: 1108, y: 479}, geo: {lat: 49.31838591416893, lon: 8.293468523154518}},
    // the frogs
    {pixel: {x: 602, y: 1544}, geo: {lat: 49.318147, lon: 8.300963}},
    // geforce
    {pixel: {x: 678, y: 1022}, geo: {lat: 49.317542883557145, lon: 8.29789694573585}},
  ];

  type Matrix = number[][];

  const transpose = (m: Matrix): Matrix =>
    m[0].map((_, col) => m.map(row => row[col]));

  const multiply = (a: Matrix, b: Matrix): Matrix => {
    const result: Matrix = Array.from({length: a.length}, () =>
      new Array(b[0].length).fill(0),
    );
    for (let r = 0; r < a.length; r++) {
      for (let c = 0; c < b[0].length; c++) {
        for (let k = 0; k < a[0].length; k++) {
          result[r][c] += a[r][k] * b[k][c];
        }
      }
    }
    return result;
  };

  const invert3x3 = (m: Matrix): Matrix | null => {
    const det =
      m[0][0] * (m[1][1] * m[2][2] - m[2][1] * m[1][2]) -
      m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
      m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    if (det === 0) return null;
    const d = 1 / det;
    return [
      [
        (m[1][1] * m[2][2] - m[2][1] * m[1][2]) * d,
        (m[0][2] * m[2][1] - m[0][1] * m[2][2]) * d,
        (m[0][1] * m[1][2] - m[0][2] * m[1][1]) * d,
      ],
      [
        (m[1][2] * m[2][0] - m[1][0] * m[2][2]) * d,
        (m[0][0] * m[2][2] - m[0][2] * m[2][0]) * d,
        (m[1][0] * m[0][2] - m[0][0] * m[1][2]) * d,
      ],
      [
        (m[1][0] * m[2][1] - m[2][0] * m[1][1]) * d,
        (m[2][0] * m[0][1] - m[0][0] * m[2][1]) * d,
        (m[0][0] * m[1][1] - m[1][0] * m[0][1]) * d,
      ],
    ];
  };

  const A: Matrix = controlPoints.map(p => [p.pixel.x, p.pixel.y, 1]);
  const bLon: Matrix = controlPoints.map(p => [p.geo.lon]);
  const bLat: Matrix = controlPoints.map(p => [p.geo.lat]);

  const AT = transpose(A);
  const ATA = multiply(AT, A);
  const ATAinv = invert3x3(ATA);
  if (!ATAinv) {
    // Fallback — should never happen with these control points
    return {a: 0, b: 0, c: 8.3, d: 0, e: 0, f: 49.318};
  }

  const xLon = multiply(ATAinv, multiply(AT, bLon));
  const xLat = multiply(ATAinv, multiply(AT, bLat));

  return {
    a: xLon[0][0], b: xLon[1][0], c: xLon[2][0],
    d: xLat[0][0], e: xLat[1][0], f: xLat[2][0],
  };
}

// Compute once at module load
const deutschlandTransform: AffineCoefficients = computeDeutschlandTransform();

@destinationController({category: 'Plopsa'})
export class PlopsalandDeutschland extends PlopsaBase {
  constructor(options?: DestinationConstructor) {
    super(options);
    this.addConfigPrefix('PLOPSALANDDEUTSCHLAND');

    this.parkParam = 'plopsaland-deutschland';
    this.destinationId = 'plopsalanddeutschland';
    this.parkId = 'plopsalanddeutschlandpark';
    this.parkName = 'Plopsaland Deutschland';
    this.timezone = 'Europe/Berlin';
    this.parkLat = 49.317914992075146;
    this.parkLng = 8.300217955490842;
    // English is preferred for names; German is the park's native feed and
    // sometimes carries attractions/shows before the English translation
    // catches up (see `languages` doc comment).
    this.languages = ['en', 'de'];
    // calendarUrl set via PLOPSALANDDEUTSCHLAND_CALENDARURL env var
  }

  /**
   * Convert park-map pixel coordinates (x, y) to geographic lat/lng using the
   * pre-computed least-squares affine transform for Plopsaland Deutschland.
   */
  protected override mapCoordinates(
    coords: {x: number; y: number} | undefined,
  ): {latitude: number; longitude: number} | undefined {
    if (!coords?.x || !coords?.y) return undefined;
    const {a, b, c, d, e, f} = deutschlandTransform;
    return {
      longitude: a * coords.x + b * coords.y + c,
      latitude:  d * coords.x + e * coords.y + f,
    };
  }
}

import {Destination, DestinationConstructor} from '../../destination.js';
import config from '../../config.js';
import {cache, CacheLib} from '../../cache.js';
import {http, HTTPObj} from '../../http.js';
import {inject} from '../../injector.js';
import {destinationController} from '../../destinationRegistry.js';
import {hostnameFromUrl, constructDateTime, formatDate, formatInTimezone, addDays} from '../../datetime.js';
import {TagBuilder} from '../../tags/index.js';
import {VQueueBuilder} from '../../virtualQueue/index.js';
import type {Entity, LiveData, EntitySchedule} from '@themeparks/typelib';

/**
 * Genting SkyWorlds Theme Park, Resorts World Genting, Malaysia.
 *
 * All API endpoints (configured via `apiBase`) require a static `X-Auth-Api`
 * header — no user login is needed for the public attractions / wait-time /
 * opening-hour data.
 *
 * Virtual-queue endpoints additionally need a 7-day bearer issued by an
 * OTP-only login flow. Because the OTP cycle cannot run inside this process,
 * the bearer is supplied by an external token service: when `tokenUrl` is
 * configured, this destination performs `GET ${tokenUrl}` (with optional
 * `Authorization: ${tokenAuth}` header) and expects a JSON document of shape
 *   { accessToken: string, exp: number /* epoch ms *​/, ... }
 * The token is cached in-process for a few hours before being re-fetched —
 * the token service is responsible for keeping `accessToken` rolling well
 * ahead of its expiry.
 */

interface GentingLatLng {
  0: number;
  1: number;
  length: 2;
}

interface GentingPOI {
  id: string;
  categoryId: 'RIDE' | 'SHOW' | 'DINING' | 'EVENT' | 'SERVICE' | 'GIFT' | 'PHOTO' | 'GAME';
  title: string;
  zone?: string;
  latLng?: [number, number] | GentingLatLng | null;
  operationStatus?: {title?: string; operating?: number};
  isRide?: boolean;
  height?: {min?: number; max?: number};
  mayGetWet?: boolean;
  showTimes?: Array<{start?: string; end?: string}>;
}

interface GentingAllResponse {
  result: {
    openingHour?: {startTime?: string; endTime?: string};
    rides?: GentingPOI[];
    shows?: GentingPOI[];
    dining?: GentingPOI[];
    events?: GentingPOI[];
    services?: GentingPOI[];
    gifts?: GentingPOI[];
    photos?: GentingPOI[];
    games?: GentingPOI[];
  };
}

interface GentingWaitTime {
  attractionId: string;
  waitTime: number;
  status: 'UP' | 'DOWN' | 'COMINGSOON' | string;
  vqReservation?: boolean;
  fullVqReservation?: boolean;
  isShowType?: boolean;
}

interface GentingWaitTimeResponse {
  result: {
    operationHour?: {
      startTime?: string;
      endTime?: string;
      itineraryStartTime?: string;
      itineraryEndTime?: string;
    };
    rideWaitTimes?: GentingWaitTime[];
  };
}

interface GentingDesireItineraryEntry {
  id: string;
  title?: string;
  fullVqReservation?: boolean;
}

interface GentingDesireItineraryResponse {
  result: GentingDesireItineraryEntry[];
}

interface GentingTokenDoc {
  accessToken: string;
  /** Epoch ms. */
  exp: number;
}

const DEST_ID = 'gentingskyworldsresort';
const PARK_ID = 'gentingskyworlds';

/**
 * Park-closure calendar for 2026, transcribed from the official PDF:
 *   https://www.gentingskyworlds.com/content/dam/approved/genting-skyworlds/web/gsw-calendar/gsw-themepark-20251231.pdf
 *
 * Rule: closed every Tuesday EXCEPT Tuesdays that fall on a Malaysian
 * national public holiday or within a Malaysian school-holiday block.
 * The PDF encodes both overrides visually; this set is the final closed
 * day list. Refresh annually when the next year's calendar PDF drops.
 */
const CLOSED_DATES_2026: ReadonlySet<string> = new Set([
  '2026-01-13', '2026-01-20', '2026-01-27',
  '2026-02-03', '2026-02-10', '2026-02-24',
  '2026-03-03', '2026-03-10', '2026-03-17', '2026-03-31',
  '2026-04-07', '2026-04-14', '2026-04-21', '2026-04-28',
  '2026-05-05', '2026-05-12', '2026-05-19',
  '2026-06-09', '2026-06-16', '2026-06-23', '2026-06-30',
  '2026-07-07', '2026-07-14', '2026-07-21', '2026-07-28',
  '2026-08-04', '2026-08-11', '2026-08-18',
  '2026-09-08', '2026-09-15', '2026-09-22', '2026-09-29',
  '2026-10-06', '2026-10-13', '2026-10-20', '2026-10-27',
  '2026-11-03', '2026-11-10', '2026-11-17', '2026-11-24',
  '2026-12-01',
]);

@destinationController({category: 'Genting'})
export class GentingSkyworlds extends Destination {
  @config apiBase: string = '';
  @config apiKey: string = '';
  @config timezone: string = 'Asia/Kuala_Lumpur';

  /**
   * HTTPS URL of an external token service that returns the current Genting
   * VQ bearer as JSON `{ accessToken, exp }`. Leave empty to disable VQ state
   * emission (everything else still ships). The service is responsible for
   * the 7-day OTP reauth cycle; this destination just consumes the token.
   */
  @config tokenUrl: string = '';

  /** Optional `Authorization` header value sent on the token-URL GET. */
  @config tokenAuth: string = '';

  constructor(options?: DestinationConstructor) {
    super(options);
    this.addConfigPrefix('GENTINGSKYWORLDS');
  }

  // ── HTTP injection ───────────────────────────────────────────

  @inject({
    eventName: 'httpRequest',
    hostname: function () { return hostnameFromUrl(this.apiBase); },
  })
  async injectHeaders(req: HTTPObj): Promise<void> {
    req.headers = {
      ...req.headers,
      'X-Auth-Api': this.apiKey,
      'accept': 'application/json',
    };
    const token = await this.getAccessToken();
    if (token) {
      req.headers = {...req.headers, 'Authorization': `Bearer ${token}`};
    }
  }

  // ── Token (refetched periodically from external service) ─────

  /**
   * Fetch the current VQ bearer from the configured token service.
   * Successful results cache for 3 hours via CacheLib.wrap — the token
   * service is expected to keep `accessToken` rolling well ahead of its
   * 7-day expiry. Failures are NOT cached (CacheLib.wrap rethrows on
   * inner-fn throw and skips the set step), so a transient token-service
   * blip only suppresses VQ for one HTTP round-trip, not 3 hours.
   * Returns '' when no `tokenUrl` is configured or when the call fails —
   * the injector tolerates the empty string and ships everything else.
   */
  async getAccessToken(): Promise<string> {
    if (!this.tokenUrl) return '';
    const cacheKey = `${this.constructor.name}:accessToken:${this.tokenUrl}`;
    try {
      return await CacheLib.wrap(cacheKey, async () => {
        const headers: Record<string, string> = {'Accept': 'application/json'};
        if (this.tokenAuth) headers['Authorization'] = this.tokenAuth;
        const resp = await fetch(this.tokenUrl, {headers});
        if (!resp.ok) throw new Error(`token service HTTP ${resp.status}`);
        const doc = await resp.json() as GentingTokenDoc;
        if (!doc?.accessToken) throw new Error('token service returned no accessToken');
        return doc.accessToken;
      }, 60 * 60 * 3);
    } catch (err: any) {
      console.warn(`[GentingSkyworlds] token fetch failed: ${err?.message ?? err}`);
      return '';
    }
  }

  // ── HTTP / cache ─────────────────────────────────────────────

  @http({cacheSeconds: 60 * 60 * 6})
  async fetchAll(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.apiBase}/v1/attraction/all`,
      options: {json: true},
    } as any as HTTPObj;
  }

  @http({cacheSeconds: 60})
  async fetchWaitTimes(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.apiBase}/v1/attraction/wait-time`,
      options: {json: true},
    } as any as HTTPObj;
  }

  @cache({ttlSeconds: 60 * 60 * 6})
  async getAll(): Promise<GentingAllResponse['result']> {
    const resp = await this.fetchAll();
    const data = await resp.json() as GentingAllResponse;
    return data?.result ?? {} as any;
  }

  @cache({ttlSeconds: 60})
  async getWaitTimes(): Promise<GentingWaitTimeResponse['result']> {
    const resp = await this.fetchWaitTimes();
    const data = await resp.json() as GentingWaitTimeResponse;
    return data?.result ?? {} as any;
  }

  /**
   * VQ availability per ride. Requires a valid user bearer token. Returns
   * an empty array (and silently skips VQ data) when no token is configured
   * or the token has expired.
   */
  @http({cacheSeconds: 60})
  async fetchDesireItinerary(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.apiBase}/v2/me/desire-itinerary`,
      options: {json: true},
    } as any as HTTPObj;
  }

  @cache({ttlSeconds: 60})
  async getDesireItinerary(): Promise<GentingDesireItineraryEntry[]> {
    if (!(await this.getAccessToken())) return [];
    try {
      const resp = await this.fetchDesireItinerary();
      const data = await resp.json() as GentingDesireItineraryResponse;
      return data?.result ?? [];
    } catch (err: any) {
      // Token rejected / device unbound / network error → ship without VQ.
      console.warn(`[GentingSkyworlds] VQ fetch failed: ${err?.message ?? err}`);
      return [];
    }
  }

  // ── Helpers ──────────────────────────────────────────────────

  private toLocation(poi: GentingPOI): {latitude: number; longitude: number} | undefined {
    const ll = poi.latLng as [number, number] | undefined | null;
    if (!ll || ll.length !== 2) return undefined;
    const [lat, lng] = ll;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return undefined;
    return {latitude: lat, longitude: lng};
  }

  private buildPOIEntity(poi: GentingPOI, entityType: Entity['entityType']): Entity {
    const entity: Entity = {
      id: String(poi.id),
      name: poi.title,
      entityType,
      parentId: PARK_ID,
      destinationId: DEST_ID,
      timezone: this.timezone,
    } as Entity;

    const location = this.toLocation(poi);
    if (location) entity.location = location;

    if (entityType === 'ATTRACTION') {
      const tags: any[] = [];
      const minHeightCm = poi.height?.min;
      if (typeof minHeightCm === 'number' && minHeightCm > 0 && minHeightCm < 300) {
        tags.push(TagBuilder.minimumHeight(minHeightCm, 'cm'));
      }
      if (poi.mayGetWet === true) {
        tags.push(TagBuilder.mayGetWet());
      }
      if (tags.length) (entity as any).tags = tags;
    }

    return entity;
  }

  // ── Destination / Park ───────────────────────────────────────

  async getDestinations(): Promise<Entity[]> {
    return [{
      id: DEST_ID,
      name: 'Genting SkyWorlds',
      entityType: 'DESTINATION',
      timezone: this.timezone,
      location: {latitude: 3.4222, longitude: 101.7950},
    } as Entity];
  }

  protected async buildEntityList(): Promise<Entity[]> {
    const data = await this.getAll();

    const park: Entity = {
      id: PARK_ID,
      name: 'Genting SkyWorlds Theme Park',
      entityType: 'PARK',
      parentId: DEST_ID,
      destinationId: DEST_ID,
      timezone: this.timezone,
      location: {latitude: 3.4222, longitude: 101.7950},
    } as Entity;

    const rides = (data.rides ?? []).map((p) => this.buildPOIEntity(p, 'ATTRACTION'));
    const shows = (data.shows ?? []).map((p) => this.buildPOIEntity(p, 'SHOW'));
    const dining = (data.dining ?? []).map((p) => this.buildPOIEntity(p, 'RESTAURANT'));

    return [park, ...rides, ...shows, ...dining];
  }

  // ── Live Data ────────────────────────────────────────────────

  protected async buildLiveData(): Promise<LiveData[]> {
    const [data, wait, desire] = await Promise.all([
      this.getAll(),
      this.getWaitTimes(),
      this.getDesireItinerary(),
    ]);

    // status maps
    const waitByRide = new Map<string, GentingWaitTime>();
    for (const w of wait.rideWaitTimes ?? []) waitByRide.set(String(w.attractionId), w);
    const vqByRide = new Map<string, GentingDesireItineraryEntry>();
    for (const v of desire) vqByRide.set(String(v.id), v);

    // The upstream API freezes the last wait-time snapshot when the park
    // closes — so polling at 2am gets yesterday's 6pm state back. Gate every
    // live-data emission on the operationHour window: when `now` falls outside
    // the window, force CLOSED and suppress queue + VQ data. When we don't
    // have operationHour, fall through to upstream-as-truth.
    const parkOpenNow = this.isParkCurrentlyOpen(wait.operationHour);

    const out: LiveData[] = [];

    for (const ride of data.rides ?? []) {
      const w = waitByRide.get(String(ride.id));
      const ld: LiveData = {
        id: String(ride.id),
        status: 'CLOSED',
      } as LiveData;

      if (parkOpenNow === false) {
        // Outside hours — closed, no queue. Don't trust the frozen snapshot.
        out.push(ld);
        continue;
      }

      const queue: Record<string, any> = {};

      if (w) {
        if (w.status === 'UP') {
          ld.status = 'OPERATING';
          if (Number.isFinite(w.waitTime) && w.waitTime >= 0 && w.waitTime < 600) {
            queue.STANDBY = {waitTime: w.waitTime};
          }
        } else if (w.status === 'DOWN') {
          ld.status = 'DOWN';
        } else {
          // COMINGSOON or unknown
          ld.status = 'CLOSED';
        }
      }

      // Virtual queue state. Genting's free VQ ("desire-itinerary") tracks
      // a simple "is the day's slot pool full?" flag — no return times or
      // boarding groups. We map this to RETURN_TIME state alone, leaving
      // the return window null because the API does not expose one.
      // Only emit VQ for rides flagged vqReservation=true and only when the
      // ride is currently OPERATING (a DOWN ride showing AVAILABLE VQ would
      // mislead guests).
      const vq = vqByRide.get(String(ride.id));
      if (vq && ride.id != null && (w?.vqReservation ?? false) && ld.status === 'OPERATING') {
        queue.RETURN_TIME = vq.fullVqReservation
          ? VQueueBuilder.returnTime().finished().withWindow(null, null).build()
          : VQueueBuilder.returnTime().available().withWindow(null, null).build();
      }

      if (Object.keys(queue).length) (ld as any).queue = queue;
      out.push(ld);
    }

    // Shows — emit OPERATING / CLOSED based on operationStatus; showtimes not
    // currently populated by the API (showTimes is always []). When the park
    // is closed, the upstream show status is also frozen, so force CLOSED.
    for (const show of data.shows ?? []) {
      const open = parkOpenNow !== false && show.operationStatus?.title === 'OPEN';
      out.push({
        id: String(show.id),
        status: open ? 'OPERATING' : 'CLOSED',
      } as LiveData);
    }

    return out;
  }

  /**
   * Decide whether the park is currently within its operating hours.
   * Returns `true`/`false` when we have an upstream operationHour window
   * to compare against, or `null` when we don't — callers should treat
   * `null` as "no data, fall through to upstream-as-truth" rather than
   * blanket-closing the park.
   */
  private isParkCurrentlyOpen(
    operationHour: GentingWaitTimeResponse['result']['operationHour'],
  ): boolean | null {
    if (!operationHour?.startTime || !operationHour?.endTime) return null;
    const start = new Date(operationHour.startTime).getTime();
    const end = new Date(operationHour.endTime).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    const now = Date.now();
    return now >= start && now < end;
  }

  // ── Schedules ────────────────────────────────────────────────

  /**
   * The upstream API only exposes today's hours, so we synthesise a forward
   * schedule from the park's published default (daily 10am-6pm, closed
   * Tuesdays) and overlay today's live operationHour on top in case the
   * park varies it. Tuesday closures may be overridden by Malaysian public
   * holidays and school holidays per the official park-hours page; without
   * a holiday feed we leave Tuesdays closed and accept the false negatives.
   * Source: https://www.gentingskyworlds.com/en/travel-information/park-hours.html
   */
  protected async buildSchedules(): Promise<EntitySchedule[]> {
    const wait = await this.getWaitTimes();
    const today = new Date();
    const horizon = addDays(today, 90);

    const schedule: Array<{date: string; type: string; openingTime: string; closingTime: string}> = [];

    for (let d = new Date(today); d <= horizon; d = addDays(d, 1)) {
      const dateStr = formatDate(d, this.timezone);
      const isClosed = dateStr.startsWith('2026-')
        ? CLOSED_DATES_2026.has(dateStr)
        : new Date(`${dateStr}T12:00:00+08:00`).getUTCDay() === 2;
      if (isClosed) continue;

      schedule.push({
        date: dateStr,
        type: 'OPERATING',
        openingTime: constructDateTime(dateStr, '10:00', this.timezone),
        closingTime: constructDateTime(dateStr, '18:00', this.timezone),
      });
    }

    // Overlay live operationHour for today (whatever the API currently says wins).
    // Parse upstream timestamps strictly: if either fails to produce a finite
    // Date, skip the overlay rather than emit an entry with a malformed date.
    // Project times into Malaysia-local via formatInTimezone + constructDateTime
    // so the emitted ISO strings match the format of the synthesised entries
    // around them (and the operating-day key matches the local calendar day,
    // not the timestamp's own day).
    const live = wait.operationHour;
    if (live?.startTime && live?.endTime) {
      const startDate = new Date(live.startTime);
      const endDate = new Date(live.endTime);
      if (Number.isFinite(startDate.getTime()) && Number.isFinite(endDate.getTime())) {
        const startLocalDate = formatDate(startDate, this.timezone);
        const endLocalDate = formatDate(endDate, this.timezone);
        const localHHmm = (d: Date) =>
          formatInTimezone(d, this.timezone, 'iso').slice(11, 16);
        const entry = {
          date: startLocalDate,
          type: 'OPERATING',
          openingTime: constructDateTime(startLocalDate, localHHmm(startDate), this.timezone),
          closingTime: constructDateTime(endLocalDate, localHHmm(endDate), this.timezone),
        };
        const idx = schedule.findIndex(s => s.date === startLocalDate);
        if (idx >= 0) schedule[idx] = entry;
        else schedule.unshift(entry);
      }
    }

    return [{id: PARK_ID, schedule} as EntitySchedule];
  }
}

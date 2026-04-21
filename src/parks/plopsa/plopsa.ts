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
import {destinationController} from '../../destinationRegistry.js';
import type {Entity, LiveData, EntitySchedule} from '@themeparks/typelib';
import {formatDate, addDays, formatInTimezone} from '../../datetime.js';

// ── API response types ──────────────────────────────────────────

interface PlopsaContainsItem {
  id: string;
  plopsa_id?: string;
  title: string;
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

interface PlopsaEntertainmentItem {
  id: string;
  plopsa_id?: string;
  title: string;
  type: {
    label: string;
  };
  schedule_info?: {
    temporarily_closed?: boolean;
    schedule?: Array<{
      date: string;
      timeslots: Array<{
        type: string;
        start_time: string;
        end_time: string | null;
      }>;
    }>;
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

  /** Language to use for all API calls */
  apiLanguage: string = 'en';

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

  @http({cacheSeconds: 60 * 60 * 12})
  async fetchPOI(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.apiBase}/api/points-of-interest`,
      queryParams: {language: this.apiLanguage, park: this.parkParam},
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
  async fetchEntertainments(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.apiBase}/api/entertainments`,
      queryParams: {language: this.apiLanguage, park: this.parkParam},
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
   */
  @http({cacheSeconds: 60 * 30})
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
    const [poiResp, entResp] = await Promise.all([
      this.fetchPOI(),
      this.fetchEntertainments(),
    ]);

    const poiData = (await poiResp.json()) as PlopsaPOIResponse;
    const entData = (await entResp.json()) as PlopsaEntertainmentResponse;

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

    // Attractions and restaurants from POI
    for (const poi of poiData?.items ?? []) {
      const coords = this.mapCoordinates(poi.map_coordinates);

      for (const item of poi.contains ?? []) {
        if (item.type === 'attraction') {
          const entity: Entity = {
            id: this.entityId(item),
            name: item.title,
            entityType: 'ATTRACTION',
            parentId: this.parkId,
            destinationId: this.destinationId,
            timezone: this.timezone,
          } as Entity;
          if (coords) {
            (entity as any).location = coords;
          }
          entities.push(entity);
        } else if (item.type === 'foods_and_drinks') {
          const entity: Entity = {
            id: this.entityId(item),
            name: item.title,
            entityType: 'RESTAURANT',
            parentId: this.parkId,
            destinationId: this.destinationId,
            timezone: this.timezone,
          } as Entity;
          if (coords) {
            (entity as any).location = coords;
          }
          entities.push(entity);
        }
      }
    }

    // Shows / Meet-and-greets from entertainments list
    for (const item of entData?.items ?? []) {
      const label = item.type?.label ?? '';
      if (label !== 'Show' && label !== 'Meet&Greet') continue;

      const entity: Entity = {
        id: this.entityId({id: item.id, plopsa_id: item.plopsa_id}),
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

    return entities;
  }

  // ── Live data ─────────────────────────────────────────────────

  protected async buildLiveData(): Promise<LiveData[]> {
    const today = formatTodayInTimezone(this.timezone);

    const [waitResp, poiResp, hoursResp] = await Promise.all([
      this.fetchWaitTimes(),
      this.fetchPOI(),
      this.fetchTodayHours(today).catch(() => null),
    ]);

    const waitTimes = (await waitResp.json()) as PlopsaWaitTimesResponse;
    if (!waitTimes) return [];

    const poiData = (await poiResp.json()) as PlopsaPOIResponse;
    const hoursData = hoursResp ? (await hoursResp.json()) as PlopsaTodayHours : null;

    // Per-attraction temporarily-closed flag from POI.
    const closedById = new Map<string, boolean>();
    for (const poi of poiData?.items ?? []) {
      for (const item of poi.contains ?? []) {
        if (item.type !== 'attraction') continue;
        const id = this.entityId(item);
        const flag = !!item.schedule_info?.temporarily_closed;
        closedById.set(id, flag);
      }
    }

    // Whether the park is operating right now. The wait-times feed keeps
    // returning per-ride numbers (mostly 0/1 noise) outside park hours, so
    // we explicitly mark everything CLOSED in that window — the alternative
    // is "Closed. Wait time: 1 minute" inconsistency in the wiki.
    const parkOpenNow = isParkOpenNow(hoursData, this.timezone);

    const lastUpdated = new Date().toISOString();
    return Object.entries(waitTimes).map(([attractionId, waitTime]) => {
      const id = String(attractionId);
      const operating = parkOpenNow && closedById.get(id) !== true;

      if (!operating) {
        return {id, status: 'CLOSED', lastUpdated} as unknown as LiveData;
      }
      return {
        id,
        status: 'OPERATING',
        queue: {
          STANDBY: {waitTime: typeof waitTime === 'number' ? waitTime : null},
        },
        lastUpdated,
      } as unknown as LiveData;
    });
  }

  // ── Schedules ─────────────────────────────────────────────────

  protected async buildSchedules(): Promise<EntitySchedule[]> {
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

    // Also build show schedules from entertainments
    const entResp = await this.fetchEntertainments();
    const entData = (await entResp.json()) as PlopsaEntertainmentResponse;
    const showSchedules: EntitySchedule[] = [];

    for (const item of entData?.items ?? []) {
      const label = item.type?.label ?? '';
      if (label !== 'Show' && label !== 'Meet&Greet') continue;

      const showId = this.entityId({id: item.id, plopsa_id: item.plopsa_id});
      const showSchedule: EntitySchedule['schedule'] = [];

      for (const day of item.schedule_info?.schedule ?? []) {
        for (const slot of day.timeslots ?? []) {
          if (slot.type !== 'open') continue;
          showSchedule.push({
            date: day.date,
            type: 'OPERATING',
            // Show timeslots use HH:MM strings, not full ISO — build with constructDateTime
            openingTime: `${day.date}T${slot.start_time}:00`,
            closingTime: slot.end_time
              ? `${day.date}T${slot.end_time}:00`
              : `${day.date}T${slot.start_time}:00`,
          } as any);
        }
      }

      if (showSchedule.length > 0) {
        showSchedules.push({id: showId, schedule: showSchedule} as EntitySchedule);
      }
    }

    return [
      {id: this.parkId, schedule} as EntitySchedule,
      ...showSchedules,
    ];
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

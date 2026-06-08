import {Destination, DestinationConstructor} from '../../destination.js';
import {cache} from '../../cache.js';
import {http, HTTPObj} from '../../http.js';
import {inject} from '../../injector.js';
import config from '../../config.js';
import {destinationController} from '../../destinationRegistry.js';
import type {Entity, LiveData, EntitySchedule, ScheduleEntry, TagData} from '@themeparks/typelib';
import {constructDateTime, formatDate, hostnameFromUrl} from '../../datetime.js';
import {createStatusMap} from '../../statusMap.js';
import {TagBuilder} from '../../tags/index.js';

const DESTINATION_ID = 'niglolandresort';
const PARK_ID = 'nigloland';
/** Indéterminé rides only count as live when upstream updatedAt is recent. */
const FRESHNESS_WINDOW_MS = 30 * 60 * 1000;
/** Months of forward calendar to pull. Mirrors what the mobile app fetches. */
const SCHEDULE_MONTHS_AHEAD = 4;
/** Safety stop for /calendar_dates pagination. App responses fit in <=3 pages. */
const CALENDAR_PAGE_LIMIT = 10;

const mapStatus = createStatusMap({
  OPERATING: ['Ouvert', 'Indéterminé'],
  CLOSED: ['Fermé'],
  REFURBISHMENT: ['En maintenance'],
}, {parkName: 'Nigloland', defaultStatus: 'CLOSED'});

interface NiglolandSizeReference {
  minSize?: number | null;
  minSoloSize?: number | null;
  accompagniedSize?: number | null;
  maxSize?: number | null;
}

interface NiglolandRide {
  id?: number;
  idNiglo?: number;
  title?: string;
  area?: {title?: string};
  statusName?: string;
  waitingTime?: number | null;
  openingHour?: string;
  closureHour?: string;
  updatedAt?: string;
  sizeReference?: NiglolandSizeReference | null;
  disabledAccessibility?: boolean;
  isRecoToPregnantWomen?: boolean;
}

interface NiglolandFoodService {
  idNiglo?: number;
  title?: string;
  typeName?: string;
}

interface NiglolandShow {
  idNiglo?: number;
  title?: string;
  statusName?: string;
  showTimes?: string[];
  isEnabled?: boolean;
}

interface NiglolandShop {
  idNiglo?: number;
  title?: string;
}

interface PointsOfInterestResponse {
  rides: NiglolandRide[];
  foodServices: NiglolandFoodService[];
  shows: NiglolandShow[];
  shops: NiglolandShop[];
}

interface NiglolandCalendarType {
  hoursPark?: string;
  hoursCashDesk?: string;
  hoursRides?: string;
}

interface NiglolandCalendarDate {
  id?: number;
  date?: string;
  calendarType?: NiglolandCalendarType;
}

/**
 * Nigloland, Dolancourt, France
 *
 * Public aggregated endpoint at /pointsOfInterest returns rides (with live
 * wait times), food services, and shows. CrowdSec WAF blocks default clients —
 * browser-like User-Agent injection is required.
 */
@destinationController({category: 'Nigloland'})
export class Nigloland extends Destination {
  @config apiBase: string = '';
  @config userAgent: string = '';
  @config timezone: string = 'Europe/Paris';

  constructor(options?: DestinationConstructor) {
    super(options);
    this.addConfigPrefix('NIGLOLAND');
  }

  // ── Header injection ─────────────────────────────────────────

  @inject({
    eventName: 'httpRequest',
    hostname: function (this: Nigloland) {
      return hostnameFromUrl(this.apiBase);
    },
  })
  async injectAppHeaders(req: HTTPObj): Promise<void> {
    if (!this.userAgent) {
      throw new Error(
        'Nigloland requires NIGLOLAND_USERAGENT to be set (browser-like UA for CrowdSec WAF)',
      );
    }
    req.headers = {
      ...req.headers,
      'user-agent': this.userAgent,
      'accept': 'application/json',
      'accept-language': 'fr-FR,fr;q=0.9',
    };
  }

  // ── HTTP + cache ───────────────────────────────────────────────

  @http({cacheSeconds: 60})
  async fetchPointsOfInterest(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.apiBase}pointsOfInterest`,
      options: {json: true},
    } as HTTPObj;
  }

  @cache({ttlSeconds: 60})
  async getPointsOfInterest(): Promise<PointsOfInterestResponse> {
    const resp = await this.fetchPointsOfInterest();
    const data = await resp.json();
    return {
      rides: Array.isArray(data?.rides) ? data.rides : [],
      foodServices: Array.isArray(data?.foodServices) ? data.foodServices : [],
      shows: Array.isArray(data?.shows) ? data.shows : [],
      shops: Array.isArray(data?.shops) ? data.shops : [],
    };
  }

  @http({cacheSeconds: 60 * 60 * 6})
  async fetchCalendarDates(dateAfter: string, dateBefore: string, page: number): Promise<HTTPObj> {
    const params = new URLSearchParams({
      page: String(page),
      'date[before]': dateBefore,
      'date[after]': dateAfter,
    });
    return {
      method: 'GET',
      url: `${this.apiBase}calendar_dates?${params.toString()}`,
      options: {json: true},
    } as HTTPObj;
  }

  /**
   * Fetch the next N months of operating calendar (mirrors the app's behaviour).
   * Each month is paginated until the upstream returns an empty page; results are
   * merged into a single date-keyed map so duplicate entries collapse cleanly.
   */
  @cache({ttlSeconds: 60 * 60 * 6})
  async getCalendarDates(): Promise<NiglolandCalendarDate[]> {
    const now = new Date();
    const entries = new Map<string, NiglolandCalendarDate>();

    for (let monthOffset = 0; monthOffset < SCHEDULE_MONTHS_AHEAD; monthOffset++) {
      const monthStart = new Date(Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth() + monthOffset,
        1,
      ));
      const monthEnd = new Date(Date.UTC(
        monthStart.getUTCFullYear(),
        monthStart.getUTCMonth() + 1,
        0,
      ));
      const dateAfter = formatDate(monthStart, 'UTC');
      const dateBefore = formatDate(monthEnd, 'UTC');

      for (let page = 1; page <= CALENDAR_PAGE_LIMIT; page++) {
        const resp = await this.fetchCalendarDates(dateAfter, dateBefore, page);
        const data = await resp.json();
        if (!Array.isArray(data) || data.length === 0) break;
        for (const entry of data) {
          const date = typeof entry?.date === 'string'
            ? entry.date.slice(0, 10)
            : null;
          if (date) entries.set(date, entry);
        }
      }
    }

    return Array.from(entries.values());
  }

  // ── Helpers ────────────────────────────────────────────────────

  private entityId(idNiglo: number | undefined | null): string | null {
    if (idNiglo == null || !Number.isFinite(Number(idNiglo))) return null;
    return String(idNiglo);
  }

  /**
   * Calendar hours strings come in a few shapes:
   *   "10h30 à 17h30"                                    → {open: '10:30', close: '17:30'}
   *   "Fermé"                                            → 'closed'
   *   "10h00 jusqu'au feu d'artifice"                    → {open: '10:00', close: '23:00'}  (fallback close)
   *   "10h00 et fermeture progressive dès 17h30 ..."    → {open: '10:00', close: '17:30'}
   * Time tokens are matched generically (Xh, XhYY, X:YY) and the first/last are
   * treated as open/close. Single-token strings get a 23:00 fallback because
   * upstream uses this format only for late-night fireworks days where the park
   * stays open well past advertised closing.
   */
  private parseCalendarHours(
    hoursStr: string | undefined | null,
  ): {open: string; close: string} | 'closed' | null {
    if (!hoursStr) return null;
    const s = hoursStr.trim();
    if (!s) return null;
    if (/^Ferm[éeE]/i.test(s)) return 'closed';

    const tokens = Array.from(s.matchAll(/(\d{1,2})\s*[h:]\s*(\d{0,2})/g))
      .map((m) => `${m[1].padStart(2, '0')}:${(m[2] || '00').padEnd(2, '0')}`);
    if (tokens.length === 0) return null;
    if (tokens.length === 1) return {open: tokens[0], close: '23:00'};
    return {open: tokens[0], close: tokens[tokens.length - 1]};
  }

  private isRideDataFresh(ride: NiglolandRide): boolean {
    if (!ride.updatedAt) return false;
    const ts = Date.parse(ride.updatedAt);
    if (!Number.isFinite(ts)) return false;
    return Date.now() - ts < FRESHNESS_WINDOW_MS;
  }

  /**
   * Indéterminé never flips to Fermé after close — gate on updatedAt freshness
   * so extended weather/crowd sessions stay OPERATING while retired catalog rides
   * (years-old updatedAt) do not emit stale waits.
   */
  private rideLiveStatus(ride: NiglolandRide): string {
    const name = ride.statusName;
    if (name === 'Fermé') return 'CLOSED';
    if (name === 'En maintenance') return 'REFURBISHMENT';
    if (name === 'Indéterminé') return this.isRideDataFresh(ride) ? 'OPERATING' : 'CLOSED';
    if (name === 'Ouvert') return 'OPERATING';
    return 'CLOSED';
  }

  private buildRideTags(ride: NiglolandRide): TagData[] {
    const tags: TagData[] = [];
    const size = ride.sizeReference;

    if (size) {
      if (Number.isFinite(Number(size.minSoloSize))) {
        tags.push(TagBuilder.minimumHeight(Number(size.minSoloSize), 'cm'));
      } else if (Number.isFinite(Number(size.minSize))) {
        tags.push(TagBuilder.minimumHeight(Number(size.minSize), 'cm'));
      }
      if (Number.isFinite(Number(size.accompagniedSize))) {
        tags.push(TagBuilder.minimumHeightUnaccompanied(Number(size.accompagniedSize), 'cm'));
      }
      if (Number.isFinite(Number(size.maxSize))) {
        tags.push(TagBuilder.maximumHeight(Number(size.maxSize), 'cm'));
      }
    }

    if (ride.isRecoToPregnantWomen) {
      tags.push(TagBuilder.unsuitableForPregnantPeople());
    }

    return tags;
  }

  // ── Entity building ────────────────────────────────────────────

  async getDestinations(): Promise<Entity[]> {
    return [{
      id: DESTINATION_ID,
      name: 'Nigloland',
      entityType: 'DESTINATION',
      timezone: this.timezone,
      location: {latitude: 48.4761, longitude: 4.7064},
    } as Entity];
  }

  protected async buildEntityList(): Promise<Entity[]> {
    const {rides, foodServices, shows} = await this.getPointsOfInterest();

    const parkEntity: Entity = {
      id: PARK_ID,
      name: 'Nigloland',
      entityType: 'PARK',
      parentId: DESTINATION_ID,
      destinationId: DESTINATION_ID,
      timezone: this.timezone,
      location: {latitude: 48.4761, longitude: 4.7064},
    } as Entity;

    const rideEntities = rides
      .map(ride => {
        const id = this.entityId(ride.idNiglo);
        if (!id || !ride.title) return null;
        const entity: Entity = {
          id,
          name: ride.title,
          entityType: 'ATTRACTION',
          parentId: PARK_ID,
          destinationId: DESTINATION_ID,
          timezone: this.timezone,
        } as Entity;
        const tags = this.buildRideTags(ride);
        if (tags.length) entity.tags = tags;
        return entity;
      })
      .filter((e): e is Entity => e !== null);

    const showEntities = shows
      .filter(show => show.isEnabled !== false)
      .map(show => {
        const id = this.entityId(show.idNiglo);
        if (!id || !show.title) return null;
        return {
          id,
          name: show.title,
          entityType: 'SHOW',
          parentId: PARK_ID,
          destinationId: DESTINATION_ID,
          timezone: this.timezone,
        } as Entity;
      })
      .filter((e): e is Entity => e !== null);

    const restaurantEntities = foodServices
      .map(food => {
        const id = this.entityId(food.idNiglo);
        if (!id || !food.title) return null;
        return {
          id,
          name: food.title,
          entityType: 'RESTAURANT',
          parentId: PARK_ID,
          destinationId: DESTINATION_ID,
          timezone: this.timezone,
        } as Entity;
      })
      .filter((e): e is Entity => e !== null);

    return [parkEntity, ...rideEntities, ...showEntities, ...restaurantEntities];
  }

  // ── Live data ──────────────────────────────────────────────────

  protected async buildLiveData(): Promise<LiveData[]> {
    const {rides, shows} = await this.getPointsOfInterest();
    const liveData: LiveData[] = [];

    for (const ride of rides) {
      const id = this.entityId(ride.idNiglo);
      if (!id) continue;

      const status = this.rideLiveStatus(ride);
      const ld: LiveData = {id, status} as LiveData;

      // Fermé and stale Indéterminé rides may still carry frozen waitingTime values.
      if (status === 'OPERATING') {
        const waitTime = Number(ride.waitingTime);
        if (Number.isFinite(waitTime)) {
          ld.queue = {STANDBY: {waitTime}};
        }
      }

      liveData.push(ld);
    }

    for (const show of shows) {
      if (show.isEnabled === false) continue;
      const id = this.entityId(show.idNiglo);
      if (!id) continue;

      const times = Array.isArray(show.showTimes) ? show.showTimes : [];
      const ld: LiveData = {
        id,
        status: mapStatus(show.statusName ?? ''),
      } as LiveData;

      if (times.length > 0) {
        ld.showtimes = times.map((startTime) => ({
          type: 'PERFORMANCE_TIME',
          startTime,
          endTime: null,
        }));
      }

      liveData.push(ld);
    }

    return liveData;
  }

  // ── Schedules ──────────────────────────────────────────────────

  protected async buildSchedules(): Promise<EntitySchedule[]> {
    const [{rides}, calendar] = await Promise.all([
      this.getPointsOfInterest(),
      this.getCalendarDates(),
    ]);

    // hoursPark drives the destination/park schedule; hoursRides may differ on
    // fireworks/special days (rides wind down before the late-night programme).
    const parkSchedule: ScheduleEntry[] = [];
    const rideSchedule: ScheduleEntry[] = [];

    for (const entry of calendar) {
      const date = typeof entry.date === 'string' ? entry.date.slice(0, 10) : null;
      if (!date) continue;
      const park = this.parseCalendarHours(entry.calendarType?.hoursPark);
      const ride = this.parseCalendarHours(entry.calendarType?.hoursRides);
      if (park && park !== 'closed') {
        parkSchedule.push({
          date,
          type: 'OPERATING',
          openingTime: constructDateTime(date, park.open, this.timezone),
          closingTime: constructDateTime(date, park.close, this.timezone),
        });
      }
      if (ride && ride !== 'closed') {
        rideSchedule.push({
          date,
          type: 'OPERATING',
          openingTime: constructDateTime(date, ride.open, this.timezone),
          closingTime: constructDateTime(date, ride.close, this.timezone),
        });
      }
    }

    parkSchedule.sort((a, b) => a.date.localeCompare(b.date));
    rideSchedule.sort((a, b) => a.date.localeCompare(b.date));

    const schedules: EntitySchedule[] = [
      {id: PARK_ID, schedule: parkSchedule} as EntitySchedule,
    ];

    for (const r of rides) {
      const id = this.entityId(r.idNiglo);
      if (!id || !r.title) continue;
      schedules.push({id, schedule: rideSchedule} as EntitySchedule);
    }

    return schedules;
  }
}

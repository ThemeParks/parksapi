import {Destination, DestinationConstructor} from '../../destination.js';
import {cache} from '../../cache.js';
import {http, HTTPObj} from '../../http.js';
import {inject} from '../../injector.js';
import config from '../../config.js';
import {destinationController} from '../../destinationRegistry.js';
import type {Entity, LiveData, EntitySchedule, ScheduleEntry, TagData} from '@themeparks/typelib';
import {constructDateTime, formatDate, formatInTimezone, hostnameFromUrl} from '../../datetime.js';
import {TagBuilder} from '../../tags/index.js';

const DESTINATION_ID = 'niglolandresort';
const PARK_ID = 'nigloland';
/** Live waitTime values older than this are considered stale and dropped. */
const WAITTIME_FRESHNESS_MS = 30 * 60 * 1000;
/**
 * Indéterminé rides with `updatedAt` older than this are treated as retired
 * catalogue entries and forced to CLOSED. The window is wide because
 * Nigloland operates on a weekends-only schedule for chunks of the year, so
 * an active ride can legitimately sit untouched for several days between
 * operating days. Observed retired entries sit at 2024 timestamps — 14+
 * months stale, well past the threshold.
 */
const RIDE_RETIREMENT_MS = 30 * 24 * 60 * 60 * 1000;
/** Months of forward calendar to pull. Mirrors what the mobile app fetches. */
const SCHEDULE_MONTHS_AHEAD = 4;
/** Safety stop for /calendar_dates pagination. App responses fit in <=3 pages. */
const CALENDAR_PAGE_LIMIT = 10;

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

  private rideAgeMs(ride: NiglolandRide): number {
    if (!ride.updatedAt) return Infinity;
    const ts = Date.parse(ride.updatedAt);
    if (!Number.isFinite(ts)) return Infinity;
    return Date.now() - ts;
  }

  private hasFreshWaitTime(ride: NiglolandRide): boolean {
    return this.rideAgeMs(ride) < WAITTIME_FRESHNESS_MS;
  }

  private isRideRetired(ride: NiglolandRide): boolean {
    return this.rideAgeMs(ride) > RIDE_RETIREMENT_MS;
  }

  /**
   * True iff the park calendar says today is operating AND the current
   * Paris-time clock is within today's open/close window for the given
   * hours field. Used as the primary OPERATING signal — `Indéterminé` is
   * the upstream's idle state and never flips after hours, so `statusName`
   * alone always over-emits.
   *
   * `hoursPark` and `hoursRides` can differ on fireworks/special days: the
   * park can stay open for a late programme while rides progressively wind
   * down. Callers pass the field that matches what they're gating —
   * `hoursPark` for shows (which run during the late programme), `hoursRides`
   * for attractions. Missing/unparseable `hoursRides` falls back to
   * `hoursPark` so normal days (where the two are identical) behave the
   * same regardless of which field the upstream populates.
   */
  private isOpenNow(
    calendar: NiglolandCalendarDate[],
    hoursField: 'hoursPark' | 'hoursRides',
    now: Date,
  ): boolean {
    // Caller passes `now` so the parkOpenNow / ridesOpenNow pair in
    // buildLiveData() can't straddle a Paris-time midnight rollover.
    const todayParis = formatDate(now, this.timezone);
    const entry = calendar.find(
      (e) => typeof e.date === 'string' && e.date.slice(0, 10) === todayParis,
    );
    if (!entry) return false;
    const primary = this.parseCalendarHours(entry.calendarType?.[hoursField]);
    const fallback =
      hoursField === 'hoursRides'
        ? this.parseCalendarHours(entry.calendarType?.hoursPark)
        : null;
    const hours = primary ?? fallback;
    if (!hours || hours === 'closed') return false;
    // formatInTimezone iso = "YYYY-MM-DDTHH:mm:ss+ZZ:ZZ"; slice 11..16 = "HH:mm"
    const nowHHMM = formatInTimezone(now, this.timezone, 'iso').slice(11, 16);
    return nowHHMM >= hours.open && nowHHMM <= hours.close;
  }

  /**
   * Indéterminé inside the calendar's open window → OPERATING. Outside the
   * window we still grant OPERATING when upstream is actively polling the
   * ride (fresh waitTime), so weather/crowd extensions past the advertised
   * close don't get prematurely closed. Retired catalogue entries are
   * filtered out separately via `isRideRetired`.
   */
  private rideLiveStatus(ride: NiglolandRide, parkOpenNow: boolean): string {
    const name = ride.statusName;
    if (name === 'Fermé') return 'CLOSED';
    if (name === 'En maintenance') return 'REFURBISHMENT';
    if (name === 'Ouvert') return 'OPERATING';
    if (name === 'Indéterminé') {
      if (this.isRideRetired(ride)) return 'CLOSED';
      return parkOpenNow || this.hasFreshWaitTime(ride) ? 'OPERATING' : 'CLOSED';
    }
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
    const [{rides, shows}, calendar] = await Promise.all([
      this.getPointsOfInterest(),
      this.getCalendarDates(),
    ]);
    // Rides and shows have different end-of-day windows on fireworks/special
    // days — rides wind down before the late programme. Gate them separately
    // against a single `now` snapshot so the two checks can't disagree on
    // which day it is.
    const now = new Date();
    const parkOpenNow = this.isOpenNow(calendar, 'hoursPark', now);
    const ridesOpenNow = this.isOpenNow(calendar, 'hoursRides', now);
    const liveData: LiveData[] = [];

    for (const ride of rides) {
      const id = this.entityId(ride.idNiglo);
      if (!id) continue;

      const status = this.rideLiveStatus(ride, ridesOpenNow);
      const ld: LiveData = {id, status} as LiveData;

      // waitTime emission is independently gated on freshness — never push a
      // value the upstream hasn't touched in the last WAITTIME_FRESHNESS_MS,
      // even if we believe the ride is OPERATING per the calendar. Guard on
      // `!= null` first so a null upstream value doesn't get coerced to a
      // bogus 0-minute standby via `Number(null)`.
      if (
        status === 'OPERATING' &&
        this.hasFreshWaitTime(ride) &&
        ride.waitingTime != null
      ) {
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
      // Drive show status directly from the calendar+showtimes gate, not
      // `statusName`. The upstream uses `Indéterminé` as its idle state for
      // shows regardless of whether they're running, and we have not observed
      // any other value carry useful information here. CLOSED entries drop
      // the showtimes array so the wiki doesn't echo cancelled performances.
      const status: 'OPERATING' | 'CLOSED' =
        parkOpenNow && times.length > 0 ? 'OPERATING' : 'CLOSED';
      const ld: LiveData = {id, status} as LiveData;

      if (status === 'OPERATING') {
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

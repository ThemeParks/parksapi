import {Destination, DestinationConstructor} from '../../destination.js';
import {cache} from '../../cache.js';
import {http, HTTPObj} from '../../http.js';
import {inject} from '../../injector.js';
import config from '../../config.js';
import {destinationController} from '../../destinationRegistry.js';
import {Entity, LiveData, EntitySchedule} from '@themeparks/typelib';
import {constructDateTime, formatDate, hostnameFromUrl, addDays} from '../../datetime.js';
import {TagBuilder} from '../../tags/index.js';

// ─── API types ────────────────────────────────────────────────────────────────

type QiddiyaLocation = {latitude: number; longitude: number};
type QiddiyaLand = {code: string; label: string};

type QiddiyaDayHours = {open: string; close: string};
type QiddiyaWeekHours = Partial<Record<
  'Monday' | 'Tuesday' | 'Wednesday' | 'Thursday' | 'Friday' | 'Saturday' | 'Sunday',
  QiddiyaDayHours
>>;

type QiddiyaActivity = {
  id: string;
  name: string;
  title: string;
  category: 'RIDES' | 'DINING' | 'SHOPPING' | 'FACILITIES' | 'ENTERTAINMENT';
  categoryTitle: string;
  description?: string;
  location?: QiddiyaLocation;
  locationId?: string;
  land?: QiddiyaLand;
  hoursOfOperation?: QiddiyaWeekHours[];
  goFastPass?: boolean;
  minHeight?: number;
  maxHeight?: number;
  waitTime?: number | null;
  rideAttributes?: {
    features?: Array<{code: string; label: string}>;
  };
};

type QiddiyaActivitiesResponse = {data: QiddiyaActivity[]};

type QiddiyaDashboardResponse = {
  data: {
    parkInfo?: {
      isOpen?: boolean;
      openingHours?: string;
    };
  };
};

// ─── Constants ────────────────────────────────────────────────────────────────

const DESTINATION_ID = 'sixflagsqiddiyacity';
const PARK_ID = 'sixflagsqiddiyacity.park';
// Park entrance coordinates (approximate centroid of the published ride locations)
const PARK_LATITUDE = 24.5876;
const PARK_LONGITUDE = 46.3327;

// JS Date.getDay() returns 0 (Sun) ... 6 (Sat); the API uses long weekday names.
const DAY_NAMES = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
] as const;

// Number of days of schedule data to project from the weekly pattern.
const SCHEDULE_DAYS = 30;

// ─── Implementation ───────────────────────────────────────────────────────────

@destinationController({category: 'Six Flags'})
export class SixFlagsQiddiyaCity extends Destination {
  @config
  apiBase: string = '';

  @config
  appVersion: string = '2.6';

  timezone: string = 'Asia/Riyadh';

  constructor(options?: DestinationConstructor) {
    super(options);
    this.addConfigPrefix('SIXFLAGSQIDDIYACITY');
  }

  // ─── Header injection ────────────────────────────────────────────────────

  /** Inject mobile-app identification headers on all API requests. */
  @inject({
    eventName: 'httpRequest',
    hostname: function(this: SixFlagsQiddiyaCity) {
      return hostnameFromUrl(this.apiBase);
    },
  })
  async injectHeaders(req: HTTPObj): Promise<void> {
    req.headers = {
      ...req.headers,
      'user-agent': '(iPhone; iOS 26.3.1)',
      'accept-language': 'en',
      'is_public_request': 'true',
      'x-client-type': 'mobile',
      'x-client-v': this.appVersion,
    };
  }

  // ─── HTTP fetch methods ──────────────────────────────────────────────────

  /** Fetch all activities (rides, dining, entertainment, shopping, facilities). */
  @http({cacheSeconds: 60} as any)
  async fetchActivities(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.apiBase}/sixflags/info-guide/api/v3/activities?page=1&limit=250&sort=name&sortDirection=asc&map=true`,
      options: {json: true},
    } as any as HTTPObj;
  }

  /** Fetch park-level dashboard (isOpen, opening hours). */
  @http({cacheSeconds: 60} as any)
  async fetchDashboard(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.apiBase}/sixflags/info-guide/api/v1/dashboard`,
      options: {json: true},
    } as any as HTTPObj;
  }

  // ─── Cached data accessors ──────────────────────────────────────────────

  @cache({ttlSeconds: 60})
  async getActivities(): Promise<QiddiyaActivity[]> {
    const resp = await this.fetchActivities();
    const data: QiddiyaActivitiesResponse = await resp.json();
    return data?.data || [];
  }

  @cache({ttlSeconds: 60})
  async getDashboard(): Promise<QiddiyaDashboardResponse['data']> {
    const resp = await this.fetchDashboard();
    const data: QiddiyaDashboardResponse = await resp.json();
    return data?.data || {};
  }

  // ─── Destination + entities ─────────────────────────────────────────────

  async getDestinations(): Promise<Entity[]> {
    return [{
      id: DESTINATION_ID,
      name: 'Six Flags Qiddiya City',
      entityType: 'DESTINATION',
      timezone: this.timezone,
      location: {latitude: PARK_LATITUDE, longitude: PARK_LONGITUDE},
    } as Entity];
  }

  protected async buildEntityList(): Promise<Entity[]> {
    const activities = await this.getActivities();

    const parkEntity: Entity = {
      id: PARK_ID,
      name: 'Six Flags Qiddiya City',
      entityType: 'PARK',
      parentId: DESTINATION_ID,
      destinationId: DESTINATION_ID,
      timezone: this.timezone,
      location: {latitude: PARK_LATITUDE, longitude: PARK_LONGITUDE},
    } as Entity;

    const rides = this.mapActivities(
      activities.filter((a) => a.category === 'RIDES'),
      'ATTRACTION',
    );
    const restaurants = this.mapActivities(
      activities.filter((a) => a.category === 'DINING'),
      'RESTAURANT',
    );
    const shows = this.mapActivities(
      activities.filter((a) => a.category === 'ENTERTAINMENT'),
      'SHOW',
    );

    return [parkEntity, ...rides, ...restaurants, ...shows];
  }

  /** Shared mapEntities config for the three categories we expose. */
  private mapActivities(items: QiddiyaActivity[], entityType: Entity['entityType']): Entity[] {
    return this.mapEntities(items, {
      idField: 'id',
      nameField: (item) => (item.title || item.name || '').trim(),
      entityType,
      parentIdField: () => PARK_ID,
      destinationId: DESTINATION_ID,
      timezone: this.timezone,
      locationFields: {
        // The ENTERTAINMENT row publishes 0,0; treat that as missing.
        lat: (item) => (item.location && item.location.latitude !== 0 ? item.location.latitude : undefined),
        lng: (item) => (item.location && item.location.longitude !== 0 ? item.location.longitude : undefined),
      },
      transform: (entity, item) => {
        const tags: any[] = [];
        if (item.location && item.location.latitude !== 0 && item.location.longitude !== 0) {
          tags.push(TagBuilder.location(item.location.latitude, item.location.longitude, 'Location'));
        }
        if (item.minHeight != null && item.minHeight > 0) {
          tags.push(TagBuilder.minimumHeight(item.minHeight, 'cm'));
        }
        if (item.maxHeight != null && item.maxHeight > 0) {
          tags.push(TagBuilder.maximumHeight(item.maxHeight, 'cm'));
        }
        if (item.goFastPass) {
          tags.push(TagBuilder.paidReturnTime());
        }
        if (tags.length > 0) entity.tags = tags;
        return entity;
      },
    });
  }

  // ─── Live data ───────────────────────────────────────────────────────────

  protected async buildLiveData(): Promise<LiveData[]> {
    const [activities, dashboard] = await Promise.all([
      this.getActivities(),
      this.getDashboard(),
    ]);

    // The dashboard's `isOpen` flag is authoritative when present (it's a real
    // boolean from the park's own status). Only fall back to per-ride hours if
    // the dashboard hasn't surfaced an explicit value.
    const dashboardIsOpen = dashboard?.parkInfo?.isOpen;
    const dashboardKnows = typeof dashboardIsOpen === 'boolean';

    return activities
      .filter((a) => a.category === 'RIDES')
      .map((ride) => {
        const isOperatingNow = dashboardKnows
          ? dashboardIsOpen
          : this.isRideWithinOperatingHours(ride);
        const status: LiveData['status'] = isOperatingNow ? 'OPERATING' : 'CLOSED';

        const ld: LiveData = {id: ride.id, status} as LiveData;
        if (status === 'OPERATING' && ride.waitTime != null) {
          ld.queue = {STANDBY: {waitTime: ride.waitTime}};
        }
        return ld;
      });
  }

  /**
   * Check whether the current time in the park's timezone falls within today's
   * operating window for a given ride.
   */
  private isRideWithinOperatingHours(ride: QiddiyaActivity): boolean {
    const week = ride.hoursOfOperation?.[0];
    if (!week) return false;

    // Get current day name + HH:mm in the park's timezone
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: this.timezone,
      weekday: 'long',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date());

    const dayName = parts.find((p) => p.type === 'weekday')?.value as keyof QiddiyaWeekHours | undefined;
    let hour = parts.find((p) => p.type === 'hour')?.value ?? '00';
    const minute = parts.find((p) => p.type === 'minute')?.value ?? '00';
    if (hour === '24') hour = '00';

    const todayHours = dayName ? week[dayName] : undefined;
    if (!todayHours) return false;

    const nowHHmm = `${hour}:${minute}`;
    return nowHHmm >= todayHours.open && nowHHmm < todayHours.close;
  }

  // ─── Schedules ───────────────────────────────────────────────────────────

  protected async buildSchedules(): Promise<EntitySchedule[]> {
    const activities = await this.getActivities();

    // Use the first ride with hours as the canonical park schedule. All rides
    // share the same weekly pattern (verified during implementation), and the
    // park's overall opening hours follow that pattern too.
    const rideWithHours = activities.find(
      (a) => a.category === 'RIDES' && a.hoursOfOperation?.[0],
    );
    const week = rideWithHours?.hoursOfOperation?.[0];
    if (!week) return [{id: PARK_ID, schedule: []} as EntitySchedule];

    // Project the weekly pattern onto the next N days.
    const schedule: any[] = [];
    const today = new Date();
    for (let i = 0; i < SCHEDULE_DAYS; i++) {
      const date = addDays(today, i);
      const dateStr = formatDate(date, this.timezone);

      // Day-of-week in the park's timezone (not the server's local day).
      const dayIdx = this.getDayOfWeekInTimezone(date);
      const dayName = DAY_NAMES[dayIdx];
      const hours = week[dayName];
      if (!hours) continue;

      schedule.push({
        date: dateStr,
        type: 'OPERATING',
        openingTime: constructDateTime(dateStr, hours.open, this.timezone),
        closingTime: constructDateTime(dateStr, hours.close, this.timezone),
      });
    }

    return [{id: PARK_ID, schedule} as EntitySchedule];
  }

  /** Get day-of-week (0 = Sunday) for a Date as observed in the park's timezone. */
  private getDayOfWeekInTimezone(date: Date): number {
    const weekday = new Intl.DateTimeFormat('en-US', {
      timeZone: this.timezone,
      weekday: 'long',
    }).format(date);
    const idx = DAY_NAMES.indexOf(weekday as any);
    return idx >= 0 ? idx : date.getUTCDay();
  }
}

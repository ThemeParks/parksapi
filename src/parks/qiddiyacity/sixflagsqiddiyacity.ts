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

// The Qiddiya API returns some `title` values in Arabic (roughly 40% of
// entries, despite `accept-language: en`). The `name` field is always a
// consistent English slug, so fall back to it when the title contains any
// Arabic-script characters.
const ARABIC_SCRIPT_RE = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

function pickEnglishName(item: QiddiyaActivity): string {
  const title = (item.title || '').trim();
  if (title && !ARABIC_SCRIPT_RE.test(title)) return title;
  return slugToTitleCase(item.name || '');
}

function slugToTitleCase(slug: string): string {
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// JS Date.getDay() returns 0 (Sun) ... 6 (Sat).
const DAY_NAMES = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
] as const;

// Lookup for parsing day-name strings from the website CMS.
const DAY_NAME_TO_INDEX: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
  thursday: 4, friday: 5, saturday: 6,
};

// Number of days of schedule data to project from the weekly pattern.
const SCHEDULE_DAYS = 30;

// ─── Implementation ───────────────────────────────────────────────────────────

@destinationController({category: 'Six Flags'})
export class SixFlagsQiddiyaCity extends Destination {
  @config
  apiBase: string = '';

  @config
  webBase: string = '';

  @config
  appVersion: string = '2.6';

  timezone: string = 'Asia/Riyadh';

  constructor(options?: DestinationConstructor) {
    super(options);
    this.addConfigPrefix('SIXFLAGSQIDDIYACITY');
  }

  // ─── Header injection ────────────────────────────────────────────────────

  /** Inject mobile-app identification headers on API requests (not website). */
  @inject({
    eventName: 'httpRequest',
    hostname: function(this: SixFlagsQiddiyaCity) {
      return hostnameFromUrl(this.apiBase);
    },
    tags: {$nin: ['website']},
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

  /** Fetch the public website homepage — contains schedule data in a svelte component. */
  @http({cacheSeconds: 43200} as any) // 12h — CMS content changes rarely
  async fetchWebsite(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.webBase}/en`,
      headers: {
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'accept': 'text/html',
        'accept-language': 'en-US,en;q=0.9',
      },
      options: {json: false},
      tags: ['website'],
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

  /**
   * Scrape weekly schedule from the website's megaMenu svelte component.
   * Returns a map of day index (0=Sun..6=Sat) → {open, close} in HH:mm,
   * or absent for closed days.
   */
  @cache({ttlSeconds: 43200}) // 12h
  async getWebsiteSchedule(): Promise<Record<number, {open: string; close: string}>> {
    try {
      const resp = await this.fetchWebsite();
      const html = await resp.text();

      // Extract the megaMenu component's data-json-content
      const match = html.match(/data-component="megaMenu"[^>]*data-json-content="([^"]+)"/);
      if (!match) return {};

      // Decode HTML entities in the attribute value
      const decoded = match[1]
        .replace(/&quot;/g, '"').replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&#34;/g, '"').replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'");

      const data = JSON.parse(decoded);
      const lws = data?.locationWeatherSchedule;
      if (!lws) return {};

      const schedule: Record<number, {open: string; close: string}> = {};

      // Parse closed days from proTips (e.g., "Mondays & Tuesdays")
      const closedDays = new Set<number>();
      const closedText = lws.currentWeatherProTips
        ?.find((t: any) => t.relatedWeather === 'all')?.proTipText || '';
      for (const [dayName, dayIdx] of Object.entries(DAY_NAME_TO_INDEX)) {
        if (closedText.toLowerCase().includes(dayName.toLowerCase())) {
          closedDays.add(dayIdx as number);
        }
      }

      // Parse schedule strings like "Wed to Fri & Sun 3 PM - 11 PM"
      if (lws.weekdaysSchedule) {
        this.parseScheduleString(lws.weekdaysSchedule, schedule, closedDays);
      }
      if (lws.weekendsSchedule) {
        this.parseScheduleString(lws.weekendsSchedule, schedule, closedDays);
      }

      return schedule;
    } catch (err) {
      console.warn('SixFlagsQiddiyaCity: failed to scrape website schedule:', err);
      return {};
    }
  }

  /**
   * Parse a human-readable schedule string like "Wed to Fri & Sun 3 PM - 11 PM"
   * or "Saturdays from 12 PM - 12 AM" into day-index → {open, close} entries.
   */
  private parseScheduleString(
    str: string,
    out: Record<number, {open: string; close: string}>,
    closedDays: Set<number>,
  ): void {
    // Extract the time portion: "N PM - N PM" or "N AM - N AM"
    const timeMatch = str.match(/(\d{1,2})\s*(AM|PM)\s*-\s*(\d{1,2})\s*(AM|PM)/i);
    if (!timeMatch) return;

    const openHour = this.to24h(parseInt(timeMatch[1]), timeMatch[2].toUpperCase());
    const closeHour = this.to24h(parseInt(timeMatch[3]), timeMatch[4].toUpperCase());
    const open = `${String(openHour).padStart(2, '0')}:00`;
    const close = `${String(closeHour).padStart(2, '0')}:00`;

    // Extract day names/ranges from the text before the time
    const dayPart = str.substring(0, timeMatch.index).toLowerCase();

    // Resolve day indices from the text
    const days = this.parseDaySpec(dayPart);
    for (const dayIdx of days) {
      if (!closedDays.has(dayIdx)) {
        out[dayIdx] = {open, close};
      }
    }
  }

  /** Parse day spec like "wed to fri & sun" or "saturdays" into day indices. */
  private parseDaySpec(text: string): number[] {
    const days: number[] = [];
    // Split on "&" / "," to handle "Wed to Fri & Sun"
    const parts = text.split(/[&,]/).map(s => s.trim().replace(/from\s*$/i, '').trim());

    for (const part of parts) {
      // Range: "wed to fri"
      const rangeMatch = part.match(/(\w+)\s+to\s+(\w+)/i);
      if (rangeMatch) {
        const start = this.dayNameToIndex(rangeMatch[1]);
        const end = this.dayNameToIndex(rangeMatch[2]);
        if (start >= 0 && end >= 0) {
          // Walk from start to end (wrapping around week)
          let d = start;
          while (true) {
            days.push(d);
            if (d === end) break;
            d = (d + 1) % 7;
          }
        }
        continue;
      }

      // Single day: "saturdays" / "sunday" / "sat"
      const idx = this.dayNameToIndex(part);
      if (idx >= 0) days.push(idx);
    }

    return days;
  }

  private dayNameToIndex(name: string): number {
    const clean = name.replace(/s$/i, '').trim().toLowerCase(); // "saturdays" → "saturday"
    for (const [key, idx] of Object.entries(DAY_NAME_TO_INDEX)) {
      if (key.startsWith(clean) || clean.startsWith(key.substring(0, 3))) {
        return idx as number;
      }
    }
    return -1;
  }

  private to24h(hour: number, period: string): number {
    if (period === 'AM') return hour === 12 ? 0 : hour;
    return hour === 12 ? 12 : hour + 12;
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
      nameField: (item) => pickEnglishName(item),
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

    // Determine park status from multiple signals:
    // 1. Dashboard isOpen flag (authoritative when present, but often absent)
    // 2. Whether any ride has waitTime > 0 (strongest real-world signal)
    // 3. Default to CLOSED if no signal
    const dashboardIsOpen = dashboard?.parkInfo?.isOpen;
    const rides = activities.filter((a) => a.category === 'RIDES');
    const anyRideHasWait = rides.some((r) => r.waitTime != null && r.waitTime > 0);
    const parkOpen = dashboardIsOpen === true || (dashboardIsOpen === undefined && anyRideHasWait);

    return rides.map((ride) => {
      // Per-ride status: if park is open and ride has a wait time, it's operating.
      // Rides at waitTime === 0 while others have waits are likely temporarily closed.
      const isRideOperating = parkOpen && ride.waitTime != null && ride.waitTime >= 0;
      const status: LiveData['status'] = isRideOperating ? 'OPERATING' : 'CLOSED';

      const ld: LiveData = {id: ride.id, status} as LiveData;
      if (status === 'OPERATING' && ride.waitTime != null && ride.waitTime > 0) {
        ld.queue = {STANDBY: {waitTime: ride.waitTime}};
      }
      return ld;
    });
  }

  // ─── Schedules ───────────────────────────────────────────────────────────

  protected async buildSchedules(): Promise<EntitySchedule[]> {
    const weeklyHours = await this.getWebsiteSchedule();

    if (Object.keys(weeklyHours).length === 0) {
      return [{id: PARK_ID, schedule: []} as EntitySchedule];
    }

    // Project the weekly pattern onto the next N days.
    const schedule: any[] = [];
    const today = new Date();
    for (let i = 0; i < SCHEDULE_DAYS; i++) {
      const date = addDays(today, i);
      const dateStr = formatDate(date, this.timezone);

      // Day-of-week in the park's timezone (not the server's local day).
      const dayIdx = this.getDayOfWeekInTimezone(date);
      const hours = weeklyHours[dayIdx];
      if (!hours) continue; // Closed day

      // Handle midnight closing (e.g. "12 AM" = next day)
      const closingDate = hours.close === '00:00' ? formatDate(addDays(date, 1), this.timezone) : dateStr;

      schedule.push({
        date: dateStr,
        type: 'OPERATING',
        openingTime: constructDateTime(dateStr, hours.open, this.timezone),
        closingTime: constructDateTime(closingDate, hours.close, this.timezone),
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

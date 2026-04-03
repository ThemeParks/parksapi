/**
 * Chimelong Tourist Resorts, China
 *
 * Two destinations:
 *   chimelongguangzhou — Guangzhou Chimelong Tourist Resort (4 parks: GZ51-GZ54)
 *   chimelongzhuhai   — Chimelong International Ocean Tourist Resort / Zhuhai (2 parks: ZH56, ZH60)
 *
 * Live data (also entity source): POST to ${baseURL}/v2/miniProgram/scenicFacilities/findWaitTimeList
 * with a pre-stringified text/plain body.
 *
 * Schedule data: scraped from Chinese-language HTML calendar pages.
 */

import {Destination, DestinationConstructor} from '../../destination.js';
import config from '../../config.js';
import {cache} from '../../cache.js';
import {http, HTTPObj} from '../../http.js';
import {inject} from '../../injector.js';
import {destinationController} from '../../destinationRegistry.js';
import type {Entity, LiveData, EntitySchedule} from '@themeparks/typelib';
import {AttractionTypeEnum} from '@themeparks/typelib';
import {constructDateTime, formatDate, addDays, hostnameFromUrl} from '../../datetime.js';

// ── Constants ──────────────────────────────────────────────────

const TIMEZONE = 'Asia/Shanghai';

interface ParkConfig {
  parkId: string;
  name: string;
  calendarURL: string;
  destinationId: string;
  lat: number;
  lng: number;
}

interface DestinationConfig {
  id: string;
  name: string;
  lat: number;
  lng: number;
  parks: ParkConfig[];
}

const DESTINATIONS: DestinationConfig[] = [
  {
    id: 'chimelongguangzhou',
    name: 'Guangzhou Chimelong Tourist Resort',
    lat: 23.005,
    lng: 113.327,
    parks: [
      {
        parkId: 'GZ51',
        name: 'Chimelong Paradise',
        calendarURL: 'https://www.chimelong.com/gz/chimelongparadise/',
        destinationId: 'chimelongguangzhou',
        lat: 23.005,
        lng: 113.327,
      },
      {
        parkId: 'GZ52',
        name: 'Chimelong Safari Park',
        calendarURL: 'https://www.chimelong.com/gz/safaripark/',
        destinationId: 'chimelongguangzhou',
        lat: 23.009,
        lng: 113.309,
      },
      {
        parkId: 'GZ53',
        name: 'Chimelong Water Park',
        calendarURL: 'https://www.chimelong.com/gz/waterpark/',
        destinationId: 'chimelongguangzhou',
        lat: 23.004,
        lng: 113.318,
      },
      {
        parkId: 'GZ54',
        name: 'Chimelong Birds Park',
        calendarURL: 'https://www.chimelong.com/gz/birdspark/',
        destinationId: 'chimelongguangzhou',
        lat: 23.025,
        lng: 113.277,
      },
    ],
  },
  {
    id: 'chimelongzhuhai',
    name: 'Chimelong International Ocean Tourist Resort',
    lat: 22.101,
    lng: 113.533,
    parks: [
      {
        parkId: 'ZH56',
        name: 'Chimelong Ocean Kingdom',
        calendarURL: 'https://www.chimelong.com/zh/oceankingdom/',
        destinationId: 'chimelongzhuhai',
        lat: 22.101,
        lng: 113.534,
      },
      {
        parkId: 'ZH60',
        name: 'Chimelong Spaceship',
        calendarURL: 'https://www.chimelong.com/zh/zh-park-science/',
        destinationId: 'chimelongzhuhai',
        lat: 22.097,
        lng: 113.535,
      },
    ],
  },
];

// Flatten parks for easy iteration
const ALL_PARKS: ParkConfig[] = DESTINATIONS.flatMap(d => d.parks);

// Map parkId -> destinationId
const PARK_TO_DESTINATION: Record<string, string> = {};
for (const park of ALL_PARKS) {
  PARK_TO_DESTINATION[park.parkId] = park.destinationId;
}

// ── Interfaces ─────────────────────────────────────────────────

interface WaitTimeEntry {
  code: string;
  name: string;
  waitingTime: string | null;
  [key: string]: unknown;
}

interface WaitTimeResponse {
  data: WaitTimeEntry[];
}

// ── Implementation ─────────────────────────────────────────────

@destinationController({category: 'Chimelong'})
export class Chimelong extends Destination {
  @config baseURL: string = '';
  @config timezone: string = TIMEZONE;

  constructor(options?: DestinationConstructor) {
    super(options);
    this.addConfigPrefix('CHIMELONG');
  }

  getCacheKeyPrefix(): string {
    return 'chimelong';
  }

  // ── HTTP injection ───────────────────────────────────────────

  /**
   * Inject required headers for API requests.
   * Note: text/plain body must be pre-stringified before being passed to @http;
   * options.json must be false to avoid double-serialisation.
   */
  @inject({
    eventName: 'httpRequest',
    hostname: function(this: Chimelong) { return hostnameFromUrl(this.baseURL); },
  })
  async injectApiHeaders(req: HTTPObj): Promise<void> {
    req.headers = {
      ...req.headers,
      'channelcode': 'ONLINE',
      'devicetype': 'APP_ANDROID',
      'content-type': 'text/plain; charset=ISO-8859-1',
    };
  }

  // ── HTTP Methods ─────────────────────────────────────────────

  @http({cacheSeconds: 60})
  async fetchWaitTimes(parkId: string): Promise<HTTPObj> {
    return {
      method: 'POST',
      url: `${this.baseURL}/v2/miniProgram/scenicFacilities/findWaitTimeList`,
      // Body must be pre-stringified; options.json: false prevents double-serialisation
      body: JSON.stringify({code: parkId}),
      options: {json: false},
    } as any as HTTPObj;
  }

  @http({cacheSeconds: 3600})
  async fetchCalendarPage(calendarURL: string): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: calendarURL,
      options: {json: false},
    } as any as HTTPObj;
  }

  // ── Cached Data ──────────────────────────────────────────────

  @cache({ttlSeconds: 60})
  async getWaitTimesForPark(parkId: string): Promise<Array<WaitTimeEntry & {parkId: string}>> {
    const resp = await this.fetchWaitTimes(parkId);
    const body: WaitTimeResponse = await resp.json();
    if (!body?.data) return [];
    return body.data.map(entry => ({...entry, parkId}));
  }

  @cache({ttlSeconds: 60})
  async getAllWaitTimes(): Promise<Array<WaitTimeEntry & {parkId: string}>> {
    const results = await Promise.all(
      ALL_PARKS.map(park => this.getWaitTimesForPark(park.parkId)),
    );
    return results.flat();
  }

  // ── Entity Building ──────────────────────────────────────────

  async getDestinations(): Promise<Entity[]> {
    return DESTINATIONS.map(d => ({
      id: d.id,
      name: d.name,
      entityType: 'DESTINATION',
      timezone: TIMEZONE,
      location: {latitude: d.lat, longitude: d.lng},
    } as Entity));
  }

  protected async buildEntityList(): Promise<Entity[]> {
    const entities: Entity[] = [];

    // Park entities
    for (const dest of DESTINATIONS) {
      for (const park of dest.parks) {
        entities.push({
          id: `park_${park.parkId}`,
          name: park.name,
          entityType: 'PARK',
          parentId: dest.id,
          destinationId: dest.id,
          timezone: TIMEZONE,
          location: {latitude: park.lat, longitude: park.lng},
        } as Entity);
      }
    }

    // Attraction entities — sourced from the live data API
    const waitTimes = await this.getAllWaitTimes();
    for (const entry of waitTimes) {
      if (!entry.code || !entry.name) continue;
      const destinationId = PARK_TO_DESTINATION[entry.parkId];
      entities.push({
        id: `attraction_${entry.code}`,
        name: entry.name,
        entityType: 'ATTRACTION',
        attractionType: AttractionTypeEnum.RIDE,
        parentId: `park_${entry.parkId}`,
        destinationId,
        timezone: TIMEZONE,
      } as Entity);
    }

    return entities;
  }

  // ── Live Data ────────────────────────────────────────────────

  protected async buildLiveData(): Promise<LiveData[]> {
    const waitTimes = await this.getAllWaitTimes();
    const liveData: LiveData[] = [];

    for (const entry of waitTimes) {
      if (!entry.code) continue;

      const raw = parseInt(String(entry.waitingTime ?? ''), 10);
      const waitTime = isNaN(raw) ? null : raw;

      const ld: LiveData = {
        id: `attraction_${entry.code}`,
        status: waitTime !== null ? 'OPERATING' : 'CLOSED',
      } as LiveData;

      if (waitTime !== null) {
        ld.queue = {
          STANDBY: {waitTime},
        };
      }

      liveData.push(ld);
    }

    return liveData;
  }

  // ── Schedules ────────────────────────────────────────────────

  protected async buildSchedules(): Promise<EntitySchedule[]> {
    const schedules: EntitySchedule[] = [];

    for (const park of ALL_PARKS) {
      const schedule = await this.getScheduleForPark(park);
      if (schedule.length > 0) {
        schedules.push({
          id: `park_${park.parkId}`,
          schedule,
        } as EntitySchedule);
      }
    }

    return schedules;
  }

  @cache({ttlSeconds: 3600})
  async getScheduleForPark(park: ParkConfig): Promise<Array<{date: string; type: string; openingTime: string; closingTime: string}>> {
    const resp = await this.fetchCalendarPage(park.calendarURL);
    const html: string = await resp.text();
    if (!html) return [];

    return this.parseScheduleHtml(html);
  }

  /**
   * Parse Chinese-language HTML calendar pages for operating hours.
   *
   * Supported patterns:
   *   1. Date range + single slot:     10月1日-10月3日：10:00-19:00
   *   2. Date range + day-of-week:     10月8日-10月31日：周一至周五：10:00-18:00
   *   3. Fallback (today only):        园区营业时间 ... HH:mm-HH:mm
   */
  private parseScheduleHtml(html: string): Array<{date: string; type: string; openingTime: string; closingTime: string}> {
    const now = new Date();
    const year = parseInt(formatDate(now, TIMEZONE).split('-')[0], 10);

    const results: Array<{date: string; type: string; openingTime: string; closingTime: string}> = [];
    const seen = new Set<string>();

    const normalizeTime = (t: string): string => {
      let s = t;
      if (!s.includes(':')) s += ':00';
      if (s.length === 4) s = '0' + s;
      return s;
    };

    const parseDateRange = (s: string): {startMonth: number; startDay: number; endMonth: number; endDay: number} | null => {
      // Matches e.g. "10月1日-10月3日"
      const m = s.match(/^(\d{1,2})月(\d{1,2})日-(\d{1,2})月(\d{1,2})日$/);
      if (!m) return null;
      return {
        startMonth: parseInt(m[1], 10),
        startDay: parseInt(m[2], 10),
        endMonth: parseInt(m[3], 10),
        endDay: parseInt(m[4], 10),
      };
    };

    const addDatesInRange = (
      startMonth: number, startDay: number,
      endMonth: number, endDay: number,
      open: string, close: string,
      allowedDays?: number[],
    ) => {
      let startDate = new Date(`${year}-${String(startMonth).padStart(2, '0')}-${String(startDay).padStart(2, '0')}T00:00:00`);
      let endDate = new Date(`${year}-${String(endMonth).padStart(2, '0')}-${String(endDay).padStart(2, '0')}T00:00:00`);

      // Handle year boundary: if end is before start, advance end by one year
      if (endDate < startDate) {
        endDate = addDays(endDate, 365);
      }

      let cur = startDate;
      while (cur <= endDate) {
        const dateStr = formatDate(cur, TIMEZONE);
        const dow = cur.getDay(); // 0=Sun, 1=Mon, ...6=Sat
        if (!allowedDays || allowedDays.includes(dow)) {
          if (!seen.has(dateStr)) {
            seen.add(dateStr);
            results.push({
              date: dateStr,
              type: 'OPERATING',
              openingTime: constructDateTime(dateStr, open, TIMEZONE),
              closingTime: constructDateTime(dateStr, close, TIMEZONE),
            });
          }
        }
        cur = addDays(cur, 1);
      }
    };

    // Pattern 1: date range + single time slot
    // e.g. 10月1日-10月3日：10:00-19:00
    const regex1 = /(\d{1,2}月\d{1,2}日-\d{1,2}月\d{1,2}日)\s*(?:：|:)\s*(\d{1,2}:\d{1,2})-(\d{1,2}:\d{1,2})/g;
    let foundMatches = false;
    for (const m of html.matchAll(regex1)) {
      foundMatches = true;
      const parsed = parseDateRange(m[1]);
      if (!parsed) continue;
      addDatesInRange(
        parsed.startMonth, parsed.startDay,
        parsed.endMonth, parsed.endDay,
        normalizeTime(m[2]),
        normalizeTime(m[3]),
      );
    }

    // Pattern 2: date range + day-of-week filter + time slot
    // e.g. 10月8日-10月31日：周一至周五：10:00-18:00
    const dayOfWeekMap: Record<string, number[]> = {
      '周一至周日': [1, 2, 3, 4, 5, 6, 0],
      '周一至周五': [1, 2, 3, 4, 5],
      '周六-周日':  [6, 0],
      '周六至周日': [6, 0],
    };
    const regex2 = /(\d{1,2}月\d{1,2}日-\d{1,2}月\d{1,2}日)(?:：|:)(周一至周日|周一至周五|周六-周日|周六至周日)(?:：|:)(\d{1,2}:\d{1,2})-(\d{1,2}:\d{1,2})/g;
    for (const m of html.matchAll(regex2)) {
      foundMatches = true;
      const parsed = parseDateRange(m[1]);
      if (!parsed) continue;
      addDatesInRange(
        parsed.startMonth, parsed.startDay,
        parsed.endMonth, parsed.endDay,
        normalizeTime(m[3]),
        normalizeTime(m[4]),
        dayOfWeekMap[m[2]],
      );
    }

    // Pattern 3 (fallback): look for 园区营业时间 then find first HH:mm-HH:mm
    if (!foundMatches) {
      const markerIdx = html.indexOf('园区营业时间');
      if (markerIdx !== -1) {
        const after = html.substring(markerIdx + '园区营业时间'.length);
        const m = after.match(/(\d{1,2}:\d{1,2})-(\d{1,2}:\d{1,2})/);
        if (m) {
          const dateStr = formatDate(now, TIMEZONE);
          results.push({
            date: dateStr,
            type: 'OPERATING',
            openingTime: constructDateTime(dateStr, normalizeTime(m[1]), TIMEZONE),
            closingTime: constructDateTime(dateStr, normalizeTime(m[2]), TIMEZONE),
          });
        }
      }
    }

    return results;
  }
}

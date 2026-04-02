import {Destination, DestinationConstructor} from '../../destination.js';

import {cache} from '../../cache.js';
import {http, HTTPObj} from '../../http.js';
import {inject} from '../../injector.js';
import config from '../../config.js';
import {destinationController} from '../../destinationRegistry.js';
import {
  Entity,
  LiveData,
  EntitySchedule,
} from '@themeparks/typelib';
import {constructDateTime, hostnameFromUrl, addDays, formatDate} from '../../datetime.js';
import crypto from 'node:crypto';

// ── Constants ───────────────────────────────────────────────────────────────

const DESTINATION_ID = 'futuroscopedestination';
const PARK_ID = 'futuroscope';
const TIMEZONE = 'Europe/Paris';
const FALLBACK_APP_VERSION = '4.1.10';

// ── Types ────────────────────────────────────────────────────────────────────

interface FuturoscopePOIItem {
  id: number;
  title: string;
  type: string;
  theme: string;
  latitude?: string | number | null;
  longitude?: string | number | null;
}

interface FuturoscopePOIResponse {
  poi: FuturoscopePOIItem[];
}

interface FuturoscopeLiveDataItem {
  id: number;
  status?: number;
  minutes_left?: number | null;
  infos?: {
    texts?: string[] | null;
    textCard?: string | null;
  } | null;
}

interface SchedulePeriod {
  from: string;
  to: string;
}

interface ScheduleItem {
  type: string;
  periods: SchedulePeriod[];
  detailsSchedule?: {
    space?: string;
    hours?: {
      from?: string;
      to?: string;
    } | null;
  } | null;
  open?: number[];
  close?: number[];
}

interface ScheduleJSONData {
  items: ScheduleItem[];
}

// ── Implementation ───────────────────────────────────────────────────────────

@destinationController({category: 'Futuroscope'})
export class Futuroscope extends Destination {
  @config
  baseURL: string = '';

  @config
  timezone: string = TIMEZONE;

  constructor(options?: DestinationConstructor) {
    super(options);
    this.addConfigPrefix('FUTUROSCOPE');
  }

  // ── Authentication ─────────────────────────────────────────────────────────

  /**
   * Inject the session token into all API requests (excluding the auth request itself).
   */
  @inject({
    eventName: 'httpRequest',
    hostname: function (this: Futuroscope) {
      return hostnameFromUrl(this.baseURL);
    },
    tags: {$nin: ['auth']},
  })
  async injectToken(req: HTTPObj): Promise<void> {
    const token = await this.getAPIToken();
    req.headers = {
      ...req.headers,
      token,
    };
  }

  /**
   * Fetch a session token from the Futuroscope API.
   * Cached for 1 day.
   */
  @cache({ttlSeconds: 60 * 60 * 24})
  async getAPIToken(): Promise<string> {
    const resp = await this.fetchAPIToken();
    const data: any = await resp.json();
    return String(data.token);
  }

  /**
   * POST to the sessions/create endpoint to obtain a fresh token.
   * Tagged 'auth' so the token injector skips this request.
   */
  @http()
  async fetchAPIToken(): Promise<HTTPObj> {
    const randomToken = Math.random().toString(16).slice(2, 15);
    const randomUUID = crypto.randomUUID();

    return {
      method: 'POST',
      url: `${this.baseURL}/api/sessions/create/${randomToken}`,
      body: {
        session: {
          language: 'en',
          device_name: 'web',
          device_version: 'REL',
          os_name: 'Android',
          app_version: FALLBACK_APP_VERSION,
          uid: randomUUID,
          push_token: 'none',
        },
      },
      options: {json: true},
      tags: ['auth'],
    } as any as HTTPObj;
  }

  // ── POI data ───────────────────────────────────────────────────────────────

  /**
   * Fetch the POI list from the API. Cached for 12 hours.
   */
  @http({cacheSeconds: 60 * 60 * 12})
  async fetchPOIData(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.baseURL}/api/poi`,
      options: {json: true},
    } as any as HTTPObj;
  }

  @cache({ttlSeconds: 60 * 60 * 12})
  async getPOIData(): Promise<FuturoscopePOIResponse> {
    const resp = await this.fetchPOIData();
    return await resp.json();
  }

  // ── Live data ──────────────────────────────────────────────────────────────

  /**
   * Fetch real-time wait times. Cached for 1 minute.
   */
  @http({cacheSeconds: 60})
  async fetchLiveData(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.baseURL}/api/poi/get-realtime-datas`,
      options: {json: true},
    } as any as HTTPObj;
  }

  @cache({ttlSeconds: 60})
  async getRawLiveData(): Promise<FuturoscopeLiveDataItem[]> {
    const resp = await this.fetchLiveData();
    return await resp.json();
  }

  // ── Calendar / schedules ───────────────────────────────────────────────────

  /**
   * Fetch the HTML page containing the calendar. Cached for 1 day.
   */
  @http({cacheSeconds: 60 * 60 * 24})
  async fetchCalendarHTML(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: 'https://www.futuroscope.com/en/practical-info/park-opening-hours-and-calendar',
      options: {json: false},
      tags: ['calendar'],
    } as any as HTTPObj;
  }

  @cache({ttlSeconds: 60 * 60 * 24})
  async getCalendarHTML(): Promise<string> {
    const resp = await this.fetchCalendarHTML();
    return await resp.text();
  }

  // ── Destination / entity building ──────────────────────────────────────────

  async getDestinations(): Promise<Entity[]> {
    return [
      {
        id: DESTINATION_ID,
        name: 'Futuroscope',
        entityType: 'DESTINATION',
        timezone: this.timezone,
        location: {latitude: 46.667013, longitude: 0.367956},
      } as Entity,
    ];
  }

  protected async buildEntityList(): Promise<Entity[]> {
    const poiData = await this.getPOIData();

    const parkEntity: Entity = {
      id: PARK_ID,
      name: 'Futuroscope',
      entityType: 'PARK',
      parentId: DESTINATION_ID,
      destinationId: DESTINATION_ID,
      timezone: this.timezone,
      location: {latitude: 46.667013, longitude: 0.367956},
    } as Entity;

    // Attractions (type === 'attraction' and theme !== 'Shows')
    const attractions = this.mapEntities(
      poiData.poi.filter(
        (poi) => poi.type === 'attraction' && poi.theme !== 'Shows',
      ),
      {
        idField: (item) => String(item.id),
        nameField: 'title',
        entityType: 'ATTRACTION',
        parentIdField: () => PARK_ID,
        destinationId: DESTINATION_ID,
        timezone: this.timezone,
        locationFields: {
          lat: (item) => {
            const v = Number(item.latitude);
            return isNaN(v) ? undefined : v;
          },
          lng: (item) => {
            const v = Number(item.longitude);
            return isNaN(v) ? undefined : v;
          },
        },
        filter: (item) => !!item.id && !!item.title,
      },
    );

    // Shows (type === 'attraction' and theme === 'Shows')
    const shows = this.mapEntities(
      poiData.poi.filter(
        (poi) => poi.type === 'attraction' && poi.theme === 'Shows',
      ),
      {
        idField: (item) => String(item.id),
        nameField: 'title',
        entityType: 'SHOW',
        parentIdField: () => PARK_ID,
        destinationId: DESTINATION_ID,
        timezone: this.timezone,
        locationFields: {
          lat: (item) => {
            const v = Number(item.latitude);
            return isNaN(v) ? undefined : v;
          },
          lng: (item) => {
            const v = Number(item.longitude);
            return isNaN(v) ? undefined : v;
          },
        },
        filter: (item) => !!item.id && !!item.title,
      },
    );

    return [
      ...await this.getDestinations(),
      parkEntity,
      ...attractions,
      ...shows,
    ];
  }

  // ── Live data building ─────────────────────────────────────────────────────

  protected async buildLiveData(): Promise<LiveData[]> {
    const [rawLiveData, poiData] = await Promise.all([
      this.getRawLiveData(),
      this.getPOIData(),
    ]);

    // Build a set of known entity IDs for filtering
    const knownIds = new Set(
      poiData.poi
        .filter((p) => p.type === 'attraction')
        .map((p) => String(p.id)),
    );

    const results: LiveData[] = [];

    for (const data of rawLiveData) {
      const entityId = String(data.id);

      // Only emit live data for entities we know about
      if (!knownIds.has(entityId)) continue;

      const liveDataObj: LiveData = {
        id: entityId,
        status: 'OPERATING',
      } as LiveData;

      // Determine status from numeric status field
      //  0 = no data, 1 = open facility, 2 = opening later,
      //  3 = open with wait time, 4 = show, 6 = closed
      switch (data.status) {
        case 3:
          liveDataObj.status = 'OPERATING';
          // Parse wait time from textCard (e.g. "15 minutes wait")
          if (data.infos?.textCard) {
            const match = data.infos.textCard.match(/(\d+)\s*min/i);
            if (match) {
              liveDataObj.queue = {
                STANDBY: {waitTime: parseInt(match[1], 10)},
              };
            }
          }
          break;
        case 4: // show with next session
        case 1: // open facility (shops, WCs)
          liveDataObj.status = 'OPERATING';
          break;
        case 2: // not yet open today
        case 6: // closed
        default: // 0 or unknown
          liveDataObj.status = 'CLOSED';
          break;
      }

      results.push(liveDataObj);
    }

    return results;
  }

  // ── Schedule building ──────────────────────────────────────────────────────

  /**
   * Parse the Next.js serialized JSON data from the calendar page.
   *
   * The page embeds schedule data as escaped JSON inside:
   *   <script>self.__next_f.push([1,"...{\"items\"...\"schedule\"...}..."])</script>
   *
   * We use regex to find and extract this data (no cheerio dependency).
   */
  private parseCalendarData(html: string): ScheduleJSONData | null {
    // Find all script tag contents that contain self.__next_f.push
    // and have both "items" and "schedule" present
    const scriptPattern = /<script[^>]*>(.*?)<\/script>/gs;
    let match: RegExpExecArray | null;

    while ((match = scriptPattern.exec(html)) !== null) {
      const scriptContent = match[1];

      if (
        !scriptContent.includes('self.__next_f.push') ||
        !scriptContent.includes('\\"items\\"') ||
        !scriptContent.includes('\\"schedule\\"')
      ) {
        continue;
      }

      // Extract the escaped JSON object starting at {"items":...}
      const jsonMatch = scriptContent.match(/({\\"items\\".*)\]\\n"\]/s);
      if (!jsonMatch) continue;

      try {
        // Unescape backslash-quoted JSON and strip newlines
        const cleanedJSON = jsonMatch[1]
          .replace(/\\/g, '')
          .replace(/\n/g, '');
        return JSON.parse(cleanedJSON) as ScheduleJSONData;
      } catch {
        // Try next script tag if parsing fails
        continue;
      }
    }

    return null;
  }

  protected async buildSchedules(): Promise<EntitySchedule[]> {
    const html = await this.getCalendarHTML();
    const jsonData = this.parseCalendarData(html);

    if (!jsonData) {
      throw new Error('Futuroscope: failed to find calendar JSON data in page');
    }

    // Filter to only Futuroscope schedule items and extract hour ranges
    const scheduleItems: ScheduleItem[] = jsonData.items
      .filter(
        (x) =>
          x.type === 'schedule' &&
          x.detailsSchedule?.space === 'Futuroscope' &&
          x.detailsSchedule?.hours?.from &&
          x.detailsSchedule?.hours?.to,
      )
      .map((x) => {
        const openParts = x.detailsSchedule!.hours!.from!.split(':').map(Number);
        const closeParts = x.detailsSchedule!.hours!.to!.split(':').map(Number);
        return {
          ...x,
          open: openParts,
          close: closeParts,
        };
      });

    /**
     * Find the schedule item whose periods contain the given date.
     * Each period has `from` (inclusive) and `to` (exclusive) boundaries.
     */
    const findMatchingPeriod = (dateStr: string): ScheduleItem | undefined => {
      const dateMidnight = new Date(`${dateStr}T00:00:00`);

      return scheduleItems.find((item) =>
        item.periods?.some((period) => {
          // Parse period boundaries — treat as midnight local (park) time
          const periodFrom = new Date(period.from.replace(/T.*$/, 'T00:00:00'));
          // Subtract 1 day from 'to' to make it inclusive
          const periodTo = new Date(
            new Date(period.to.replace(/T.*$/, 'T00:00:00')).getTime() -
              24 * 60 * 60 * 1000,
          );
          return dateMidnight >= periodFrom && dateMidnight <= periodTo;
        }),
      );
    };

    const schedule: EntitySchedule['schedule'] = [];

    // Walk over 120 days from today
    const now = new Date();
    for (let i = 0; i < 120; i++) {
      const day = addDays(now, i);
      const dateStr = formatDate(day, this.timezone);

      const scheduleItem = findMatchingPeriod(dateStr);
      if (!scheduleItem || !scheduleItem.open || !scheduleItem.close) continue;

      const openHour = String(scheduleItem.open[0]).padStart(2, '0');
      const openMin = String(scheduleItem.open[1] ?? 0).padStart(2, '0');
      const closeHour = String(scheduleItem.close[0]).padStart(2, '0');
      const closeMin = String(scheduleItem.close[1] ?? 0).padStart(2, '0');

      schedule.push({
        date: dateStr,
        openingTime: constructDateTime(dateStr, `${openHour}:${openMin}`, this.timezone),
        closingTime: constructDateTime(dateStr, `${closeHour}:${closeMin}`, this.timezone),
        type: 'OPERATING',
      });
    }

    return [
      {
        id: PARK_ID,
        schedule,
      } as EntitySchedule,
    ];
  }
}

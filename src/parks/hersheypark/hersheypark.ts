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
import {constructDateTime, formatDate, formatInTimezone, hostnameFromUrl} from '../../datetime.js';
import {createStatusMap} from '../../statusMap.js';

/**
 * Status mapping for Hersheypark ride statuses.
 * API returns numeric status codes:
 *   1 = operating, 2 = down, 0/3 = closed
 */
const mapStatus = createStatusMap({
  OPERATING: ['1'],
  DOWN: ['2'],
  CLOSED: ['0', '3'],
}, {parkName: 'Hersheypark'});

/**
 * Temporary operating notes the park appends to ride names.
 *
 * Around events the feed renames rides in place: "Monorail - Closes at 5PM",
 * "Skyrush - Opens at 6PM", "Comet - Dark Coaster" (Dark Nights runs),
 * "Dry Gulch Railroad - Featuring Halloween Overlay". Passed through, every
 * change of note is a rename of a permanent ride. The notes are stripped so the
 * name stays stable; the times survive as operatingHours where the status feed
 * also gives them as data (see rideOperatingHours).
 *
 * Deliberately narrow and anchored at the end: a real two-part name such as
 * "Hershey Triple Tower - Hershey's Tower" must survive untouched.
 */
const OPERATING_NOTE_PATTERNS: RegExp[] = [
  /\s*[-\u2013\u2014]\s*(?:closes?|opens?)\s+at\s+\d{1,2}(?::\d{2})?\s*[ap]\.?\s*m\.?\s*$/i,
  /\s*[-\u2013\u2014]\s*dark\s+coaster\s*$/i,
  /\s*[-\u2013\u2014]\s*featuring\s+.*\boverlay\s*$/i,
];

/** A ride name with any trailing operating note removed. */
export function stripOperatingNote(name: string): string {
  let out = String(name ?? '');
  // Notes can stack in either order ("X - Dark Coaster - Closes at 5PM",
  // "X - Closes at 5PM - Dark Coaster"), and each pattern only sees the tail,
  // so keep passing over the list until a whole pass removes nothing.
  for (let changed = true; changed;) {
    changed = false;
    for (const re of OPERATING_NOTE_PATTERNS) {
      const next = out.replace(re, '');
      if (next !== out && next.trim()) {
        out = next;
        changed = true;
      }
    }
  }
  return out.trim();
}

/** Longest window accepted as one day's hours. Anything longer is not a day. */
const MAX_WINDOW_SECONDS = 24 * 60 * 60;

/**
 * A ride's opening window for today, from the status feed's `hours` (the same
 * {opens, closes} in epoch seconds that the index carries as `statusHours`), or null.
 *
 * A window is today's when it opens on today's date in the park's timezone, or
 * when `now` falls inside it: an 18:00-01:00 window is still the one running at
 * 00:30. Anything else (yesterday's finished window, a window longer than a day,
 * an epoch too large to be a date) is refused, so a stale or malformed record
 * can never be published as today's hours.
 */
export function rideOperatingHours(
  statusHours: unknown,
  timezone: string,
  now: Date = new Date(),
): {type: string; startTime: string; endTime: string} | null {
  const sh = statusHours as {opens?: unknown; closes?: unknown} | null;
  if (!sh || typeof sh !== 'object') return null;
  const opens = Number(sh.opens);
  const closes = Number(sh.closes);
  if (!Number.isFinite(opens) || !Number.isFinite(closes) || opens <= 0 || closes <= opens) return null;
  if (closes - opens > MAX_WINDOW_SECONDS) return null;
  const start = new Date(opens * 1000);
  const end = new Date(closes * 1000);
  // A finite number of seconds can still be outside the range a Date can hold.
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return null;
  const nowMs = now.getTime();
  const running = nowMs >= start.getTime() && nowMs <= end.getTime();
  if (!running && formatDate(start, timezone) !== formatDate(now, timezone)) return null;
  return {
    type: 'OPERATING',
    startTime: formatInTimezone(start, timezone, 'iso'),
    endTime: formatInTimezone(end, timezone, 'iso'),
  };
}

@destinationController({category: 'Hersheypark'})
export class Hersheypark extends Destination {
  @config
  apiKey: string = '';

  @config
  baseUrl: string = '';

  @config
  timezone: string = 'America/New_York';

  constructor(options?: DestinationConstructor) {
    super(options);
    this.addConfigPrefix('HERSHEYPARK');
  }

  // ===== Header Injection =====

  @inject({
    eventName: 'httpRequest',
    hostname: function () {
      return hostnameFromUrl(this.baseUrl);
    },
  })
  async injectApiHeaders(requestObj: HTTPObj): Promise<void> {
    requestObj.headers = {
      ...requestObj.headers,
      'x-api-key': this.apiKey,
    };
  }

  // ===== HTTP Fetch Methods =====

  /**
   * Fetch POI and schedule data from the index endpoint.
   * Cached 24 hours at HTTP layer.
   */
  @http({cacheSeconds: 86400, healthCheckArgs: []})
  async fetchPOI(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.baseUrl}/v2/index`,
      options: {json: true},
    } as any as HTTPObj;
  }

  /**
   * Get POI data (cached 24 hours).
   */
  @cache({ttlSeconds: 86400})
  async getPOI(): Promise<any> {
    const resp = await this.fetchPOI();
    const data = await resp.json();
    return data || {};
  }

  /**
   * Fetch live ride status data.
   * Cached 2 minutes at HTTP layer.
   */
  @http({cacheSeconds: 120})
  async fetchStatus(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.baseUrl}/v2/status`,
      options: {json: true},
    } as any as HTTPObj;
  }

  /**
   * Get live status data (cached 2 minutes).
   */
  @cache({ttlSeconds: 120})
  async getStatus(): Promise<any[]> {
    const resp = await this.fetchStatus();
    const data = await resp.json();
    return Array.isArray(data) ? data : [];
  }

  // ===== Data Builder Methods =====

  async getDestinations(): Promise<Entity[]> {
    return [{
      id: 'hersheypark',
      name: 'Hersheypark',
      entityType: 'DESTINATION',
      timezone: this.timezone,
      location: {latitude: 40.2870, longitude: -76.6536},
    } as Entity];
  }

  protected async buildEntityList(): Promise<Entity[]> {
    const poi = await this.getPOI();

    const destinationId = 'hersheypark';
    const parkId = 'hersheyparkthemepark';

    // Find the park from explore array
    const parkData = (poi.explore || []).find((x: any) => x.isHersheyPark);

    const parkEntity: Entity = {
      id: parkId,
      name: parkData?.name || 'Hersheypark',
      entityType: 'PARK',
      parentId: destinationId,
      destinationId,
      timezone: this.timezone,
      ...(parkData?.latitude && parkData?.longitude ? {
        location: {
          latitude: Number(parkData.latitude),
          longitude: Number(parkData.longitude),
        },
      } : {}),
    } as Entity;

    const rides = poi.rides || [];

    const attractions = this.mapEntities(rides, {
      idField: (item: any) => `rides_${item.id}`,
      nameField: (item: any) => stripOperatingNote(item.name),
      entityType: 'ATTRACTION',
      parentIdField: () => parkId,
      destinationId,
      timezone: this.timezone,
      locationFields: {
        lat: (item: any) => item.latitude ? Number(item.latitude) : undefined,
        lng: (item: any) => item.longitude ? Number(item.longitude) : undefined,
      },
    });

    return [parkEntity, ...attractions];
  }

  protected async buildLiveData(): Promise<LiveData[]> {
    const statusData = await this.getStatus();
    const liveData: LiveData[] = [];

    for (const entry of statusData) {
      // Only support rides
      if (entry.type !== 'rides') continue;

      const entityId = `rides_${entry.id}`;
      const status = mapStatus(String(entry.status));
      const ld: LiveData = {id: entityId, status} as LiveData;

      if (status === 'OPERATING' && entry.wait != null) {
        ld.queue = {
          STANDBY: {waitTime: entry.wait},
        };
      }

      // The status feed (2-minute cache) carries each ride's `hours`, the same
      // {opens, closes} the index holds as `statusHours`, so no second fetch is
      // needed. One bad record must not cost the row, or any other ride, anything.
      try {
        const hours = rideOperatingHours(entry.hours, this.timezone);
        if (hours) ld.operatingHours = [hours];
      } catch (err: any) {
        console.warn(`[Hersheypark] skipping hours for ride ${entry.id}: ${err?.message ?? err}`);
      }

      liveData.push(ld);
    }

    return liveData;
  }

  protected async buildSchedules(): Promise<EntitySchedule[]> {
    const poi = await this.getPOI();
    const exploreHours = poi.exploreHours || {};

    // Find the park ID from the explore data
    const parkData = (poi.explore || []).find((x: any) => x.isHersheyPark);
    const parkApiId = parkData?.id;
    if (!parkApiId) return [];

    const scheduleEntries: any[] = [];

    for (const date of Object.keys(exploreHours)) {
      const hours = exploreHours[date];
      const parkHours = hours[parkApiId];
      if (!parkHours) continue;

      // parkHours is "10:00 AM - 10:00 PM"
      const parts = parkHours.split(' - ');
      if (parts.length !== 2) continue;

      const openTime = this.parseAmPmTime(parts[0].trim());
      const closeTime = this.parseAmPmTime(parts[1].trim());
      if (!openTime || !closeTime) continue;

      const openingTime = constructDateTime(date, openTime, this.timezone);
      const closingTime = constructDateTime(date, closeTime, this.timezone);

      scheduleEntries.push({
        date,
        type: 'OPERATING',
        openingTime,
        closingTime,
      });
    }

    return [{
      id: 'hersheyparkthemepark',
      schedule: scheduleEntries,
    } as EntitySchedule];
  }

  /**
   * Parse an AM/PM time string like "10:00 AM" or "10:00 PM" into 24-hour "HH:mm" format.
   */
  private parseAmPmTime(timeStr: string): string | null {
    const match = timeStr.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (!match) return null;

    let hours = parseInt(match[1], 10);
    const minutes = match[2];
    const period = match[3].toUpperCase();

    if (period === 'PM' && hours !== 12) {
      hours += 12;
    } else if (period === 'AM' && hours === 12) {
      hours = 0;
    }

    return `${String(hours).padStart(2, '0')}:${minutes}`;
  }
}

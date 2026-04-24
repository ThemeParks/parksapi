import {Destination, DestinationConstructor} from '../../destination.js';
import {cache, CacheLib} from '../../cache.js';
import {http, HTTPObj} from '../../http.js';
import {inject} from '../../injector.js';
import config from '../../config.js';
import {destinationController} from '../../destinationRegistry.js';
import {Entity, LiveData, EntitySchedule} from '@themeparks/typelib';
import {constructDateTime, hostnameFromUrl} from '../../datetime.js';
import {TagBuilder} from '../../tags/index.js';
import {decodeHtmlEntities} from '../../htmlUtils.js';

const TOKEN_CACHE_KEY = 'blackpoolpleasurebeach:accessToken';

interface BpbQueueRide {
  id: number;
  rideId: number;
  ride: string;
  message?: string;
  category?: string;
  active: boolean;
  holding: boolean;
  closed: boolean;
  enabled: boolean;
  queueTime: number;
  ones?: boolean;
  easyPass?: boolean;
  is_flex_pass?: number;
  flex_pass_price?: number;
  ridePhotograpy?: boolean;
  restrictions?: string;
  latest_ride_time?: {
    date?: string;
    open_time?: string;
    close_time?: string;
  } | null;
}

interface BpbMarker {
  id: number;
  type: string;
  title: string;
  description?: string;
  lat?: string | number;
  lon?: string | number;
  linkable_type?: string | null;
  linkable_id?: number | null;
}

interface BpbWnDate {
  open_date: string;
  time_from: string;
  time_to: string;
  is_peak?: number;
  is_ten_day?: number;
  date_name?: string;
}

const DESTINATION_ID = 'blackpoolpleasurebeach';
const PARK_ID = 'blackpoolpleasurebeach-park';

@destinationController({category: 'Blackpool'})
export class BlackpoolPleasureBeach extends Destination {
  @config apiBase: string = '';
  @config websiteBase: string = '';
  @config timezone: string = 'Europe/London';
  @config email: string = '';
  @config password: string = '';

  constructor(options?: DestinationConstructor) {
    super(options);
    this.addConfigPrefix('BLACKPOOLPLEASUREBEACH');
  }

  // ===== Authentication =====

  @cache({ttlSeconds: 60 * 60 * 24 * 30, key: TOKEN_CACHE_KEY})
  async getAccessToken(): Promise<string> {
    if (!this.email || !this.password) {
      throw new Error(
        'Blackpool Pleasure Beach requires BLACKPOOLPLEASUREBEACH_EMAIL and BLACKPOOLPLEASUREBEACH_PASSWORD to be set',
      );
    }
    const resp = await this.fetchLogin(this.email, this.password);
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data?.token) {
      throw new Error(`BPB login failed: ${resp.status} ${JSON.stringify(data)}`);
    }
    return String(data.token);
  }

  @http({retries: 1})
  async fetchLogin(email: string, password: string): Promise<HTTPObj> {
    const body = new URLSearchParams({email, password});
    return {
      method: 'POST',
      url: `${this.apiBase}/login`,
      body: body.toString(),
      headers: {'content-type': 'application/x-www-form-urlencoded'},
      options: {json: false},
      tags: ['auth'],
    } as any as HTTPObj;
  }

  // ===== Injectors =====

  @inject({
    eventName: 'httpRequest',
    hostname: function () { return hostnameFromUrl(this.apiBase); },
  })
  async injectHeaders(req: HTTPObj): Promise<void> {
    req.headers = {
      ...req.headers,
      'user-agent': 'Dart/3.11 (dart:io)',
      'accept': 'application/json',
    };
  }

  @inject({
    eventName: 'httpRequest',
    hostname: function () { return hostnameFromUrl(this.apiBase); },
    tags: {$nin: ['auth']},
    priority: 1,
  } as any)
  async injectAuthToken(req: HTTPObj): Promise<void> {
    const token = await this.getAccessToken();
    req.headers = {
      ...req.headers,
      'authorization': `Bearer ${token}`,
    };
  }

  @inject({
    eventName: 'httpError',
    hostname: function () { return hostnameFromUrl(this.apiBase); },
    tags: {$nin: ['auth']},
  } as any)
  async handleUnauthorized(req: HTTPObj): Promise<void> {
    const status = req.response?.status;
    if (status !== 401) return;
    // Token revoked — clear cache and re-login on retry.
    CacheLib.delete(TOKEN_CACHE_KEY);
    req.response = undefined as any;
  }

  // ===== HTTP Fetches =====

  @http({cacheSeconds: 60, retries: 1})
  async fetchQueueTimes(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.apiBase}/queue-times`,
      options: {json: true},
    } as any as HTTPObj;
  }

  @http({cacheSeconds: 43200, retries: 1})
  async fetchMarkers(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.apiBase}/map/get-markers`,
      options: {json: true},
    } as any as HTTPObj;
  }

  @http({cacheSeconds: 21600, retries: 1})
  async fetchOpeningTimesHtml(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.websiteBase}/opening-times-prices/`,
      headers: {
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      tags: ['website'],
    } as any as HTTPObj;
  }

  @cache({ttlSeconds: 60})
  async getQueueTimes(): Promise<BpbQueueRide[]> {
    const resp = await this.fetchQueueTimes();
    const data = await resp.json();
    return Array.isArray(data) ? data : [];
  }

  @cache({ttlSeconds: 43200})
  async getMarkers(): Promise<BpbMarker[]> {
    const resp = await this.fetchMarkers();
    const data = await resp.json();
    return Array.isArray(data) ? data : [];
  }

  @cache({ttlSeconds: 21600})
  async getCalendar(): Promise<BpbWnDate[]> {
    const resp = await this.fetchOpeningTimesHtml();
    const html = await resp.text();
    const match = html.match(/wn_dates\s*=\s*(\[[\s\S]*?\])\s*;/);
    if (!match) return [];
    try {
      return JSON.parse(decodeHtmlEntities(match[1])) as BpbWnDate[];
    } catch (err) {
      console.warn('[BlackpoolPleasureBeach] Failed to parse wn_dates:', err);
      return [];
    }
  }

  // ===== Helpers =====

  private parseRestrictions(raw: string | undefined | null): {
    height?: number;
    aheight?: number;
    unaccompanied?: boolean;
  } {
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  private parseTimeOfDay(t: string): string | null {
    // Accepts "11:00am", "5:00pm", "11:00", "11:00:00"
    const m = t.trim().toLowerCase().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?$/);
    if (!m) return null;
    let h = parseInt(m[1], 10);
    const mm = m[2];
    const ss = m[3] ?? '00';
    const ap = m[4];
    if (!Number.isFinite(h)) return null;
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:${mm}:${ss}`;
  }

  // ===== Entities =====

  async getDestinations(): Promise<Entity[]> {
    return [{
      id: DESTINATION_ID,
      name: 'Blackpool Pleasure Beach',
      entityType: 'DESTINATION',
      timezone: this.timezone,
      location: {latitude: 53.7935, longitude: -3.0559},
    } as Entity];
  }

  protected async buildEntityList(): Promise<Entity[]> {
    const [queue, markers] = await Promise.all([this.getQueueTimes(), this.getMarkers()]);

    const parkEntity: Entity = {
      id: PARK_ID,
      name: 'Blackpool Pleasure Beach',
      entityType: 'PARK',
      parentId: DESTINATION_ID,
      destinationId: DESTINATION_ID,
      timezone: this.timezone,
      location: {latitude: 53.7935, longitude: -3.0559},
    } as Entity;

    // Index markers by linkable_id (linkable_type === 'App\\Rides') and by id for restaurants.
    const rideMarkers = new Map<number, BpbMarker>();
    for (const m of markers) {
      if (m.linkable_type === 'App\\Rides' && typeof m.linkable_id === 'number') {
        rideMarkers.set(m.linkable_id, m);
      }
    }

    const attractions: Entity[] = [];
    for (const r of queue) {
      // Keep entries even when the app hides them from its live list (enabled:false)
      // as long as the map still renders a marker — rides closed for the season
      // or refurbishment still exist at the park and should show CLOSED.
      const marker = rideMarkers.get(r.id);
      if (r.enabled === false && !marker) continue;

      const entity: Entity = {
        id: String(r.id),
        name: r.ride,
        entityType: 'ATTRACTION',
        parentId: PARK_ID,
        parkId: PARK_ID,
        destinationId: DESTINATION_ID,
        timezone: this.timezone,
      } as Entity;

      if (marker) {
        const lat = Number(marker.lat);
        const lng = Number(marker.lon);
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
          entity.location = {latitude: lat, longitude: lng};
        }
      }

      const tags: ReturnType<typeof TagBuilder.minimumHeight>[] = [];
      const restrictions = this.parseRestrictions(r.restrictions);
      const aheight = Number(restrictions.aheight);
      const height = Number(restrictions.height);
      if (Number.isFinite(aheight) && aheight > 0) {
        tags.push(TagBuilder.minimumHeight(aheight, 'cm'));
      }
      if (
        restrictions.unaccompanied === true &&
        Number.isFinite(height) &&
        height > 0 &&
        height !== aheight
      ) {
        tags.push(TagBuilder.minimumHeightUnaccompanied(height, 'cm'));
      }
      if (r.ridePhotograpy) tags.push(TagBuilder.onRidePhoto());
      if (r.is_flex_pass === 1 || r.easyPass) tags.push(TagBuilder.paidReturnTime());
      if (r.ones) tags.push(TagBuilder.singleRider());
      if (tags.length > 0) entity.tags = tags as any;

      attractions.push(entity);
    }

    // Restaurants from markers with linkable_type === 'App\\CateringUnit'.
    const restaurants: Entity[] = [];
    for (const m of markers) {
      if (m.linkable_type !== 'App\\CateringUnit') continue;
      const lat = Number(m.lat);
      const lng = Number(m.lon);
      const entity: Entity = {
        id: `restaurant-${m.id}`,
        name: m.title,
        entityType: 'RESTAURANT',
        parentId: PARK_ID,
        parkId: PARK_ID,
        destinationId: DESTINATION_ID,
        timezone: this.timezone,
      } as Entity;
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        entity.location = {latitude: lat, longitude: lng};
      }
      restaurants.push(entity);
    }

    return [parkEntity, ...attractions, ...restaurants];
  }

  // ===== Live Data =====

  protected async buildLiveData(): Promise<LiveData[]> {
    const [queue, markers] = await Promise.all([this.getQueueTimes(), this.getMarkers()]);
    const rideMarkerIds = new Set<number>();
    for (const m of markers) {
      if (m.linkable_type === 'App\\Rides' && typeof m.linkable_id === 'number') {
        rideMarkerIds.add(m.linkable_id);
      }
    }
    const out: LiveData[] = [];

    for (const r of queue) {
      // Match the entity filter in buildEntityList so we don't emit live data
      // for entries that have no corresponding entity.
      if (r.enabled === false && !rideMarkerIds.has(r.id)) continue;

      let status: LiveData['status'] = 'CLOSED';
      if (r.enabled === false) status = 'CLOSED';
      else if (r.closed) status = 'CLOSED';
      else if (r.holding) status = 'DOWN';
      else if (r.active) status = 'OPERATING';

      const ld: LiveData = {id: String(r.id), status} as LiveData;

      if (status === 'OPERATING') {
        const wt = Number(r.queueTime);
        if (Number.isFinite(wt)) {
          ld.queue = {STANDBY: {waitTime: wt}};
        }
      }

      out.push(ld);
    }

    return out;
  }

  // ===== Schedules =====

  protected async buildSchedules(): Promise<EntitySchedule[]> {
    const dates = await this.getCalendar();
    const schedule: NonNullable<EntitySchedule['schedule']> = [];

    for (const d of dates) {
      if (!d.open_date) continue;
      const openHm = this.parseTimeOfDay(d.time_from);
      const closeHm = this.parseTimeOfDay(d.time_to);
      if (!openHm || !closeHm) continue;
      schedule.push({
        date: d.open_date,
        type: 'OPERATING',
        openingTime: constructDateTime(d.open_date, openHm, this.timezone),
        closingTime: constructDateTime(d.open_date, closeHm, this.timezone),
      } as any);
    }

    return [{id: PARK_ID, schedule} as EntitySchedule];
  }
}

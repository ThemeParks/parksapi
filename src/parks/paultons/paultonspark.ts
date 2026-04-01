import {Destination, DestinationConstructor} from '../../destination.js';
import config from '../../config.js';
import {cache} from '../../cache.js';
import {http, HTTPObj} from '../../http.js';
import {inject} from '../../injector.js';
import {destinationController} from '../../destinationRegistry.js';
import type {Entity, LiveData, EntitySchedule} from '@themeparks/typelib';
import {constructDateTime, formatInTimezone, hostnameFromUrl, formatDate} from '../../datetime.js';

// ── Types ──────────────────────────────────────────────────────

interface POIEntry {
  id: number;
  title: string;
  type: string;
  orms_id?: number;
  entrance_location?: {type: string; coordinates: number[]};
  location?: {type: string; coordinates: number[]};
}

interface QueueTimeEntry {
  rideId: number;
  statusOpen: boolean;
  queueTime: number | null;
  openingTime?: string;
  closingTime?: string;
  updatedAt?: string;
}

interface OpeningHoursEntry {
  start: string;
  end: string;
}

// ── Implementation ─────────────────────────────────────────────

@destinationController({category: 'Paultons Park'})
export class PaultonsPark extends Destination {
  @config apiKey: string = '';
  @config apiBaseURL: string = '';
  @config bearerToken: string = '';
  @config timezone: string = 'Europe/London';

  constructor(options?: DestinationConstructor) {
    super(options);
    this.addConfigPrefix('PAULTONSPARK');
  }

  /**
   * Inject headers for all API requests.
   * /api/ paths use x-token, /items/ paths use Bearer token,
   * /assets/ paths get no auth.
   */
  @inject({
    eventName: 'httpRequest',
    hostname: function (this: PaultonsPark) { return hostnameFromUrl(this.apiBaseURL); },
  })
  async injectHeaders(req: HTTPObj): Promise<void> {
    req.headers = {
      ...req.headers,
      'x-requested-with': 'thrillseeker.app.paultons',
      'accept-language': 'en-GB,en-US;q=0.9,en;q=0.8',
      'origin': 'http://localhost',
      'referer': 'http://localhost/',
      'is-mobile': 'true',
    };

    const path = new URL(req.url).pathname;
    if (path.startsWith('/api')) {
      req.headers['x-token'] = this.apiKey;
    } else if (!path.startsWith('/assets')) {
      req.headers['authorization'] = `Bearer ${this.bearerToken}`;
    }
  }

  // ── HTTP Methods ─────────────────────────────────────────────

  @http({cacheSeconds: 86400}) // 24h
  async fetchPOIData(): Promise<HTTPObj> {
    const fields = [
      '*',
      'category_tags.category_tags_id.id',
      'images.directus_files_id.*',
      'timed_pois_list.timed_pois_list_id.id',
      'user_interest_tags.user_interest_tags_id.id',
      'filter_tags.filter_tags_id.id',
      'icon.*',
      'show.id',
    ];
    const params = new URLSearchParams({
      'fields': fields.join(','),
      'limit': '1000',
    });
    return {
      method: 'GET',
      url: `${this.apiBaseURL}/items/points_of_interest?${params.toString()}`,
      options: {json: true},
    } as any as HTTPObj;
  }

  @http({cacheSeconds: 60})
  async fetchLiveData(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.apiBaseURL}/api/queue-times`,
      options: {json: true},
    } as any as HTTPObj;
  }

  @http({cacheSeconds: 86400})
  async fetchOpeningHours(): Promise<HTTPObj> {
    const date = formatDate(new Date(), this.timezone);
    return {
      method: 'GET',
      url: `${this.apiBaseURL}/api/opening-hours?currentMonthInView=${date}T23:00:00.000Z`,
      options: {json: true},
    } as any as HTTPObj;
  }

  // ── Cached Data ──────────────────────────────────────────────

  @cache({ttlSeconds: 86400})
  async getPOIData(): Promise<POIEntry[]> {
    const resp = await this.fetchPOIData();
    const data = await resp.json();
    return data?.data || [];
  }

  @cache({ttlSeconds: 60})
  async getQueueTimes(): Promise<QueueTimeEntry[]> {
    const resp = await this.fetchLiveData();
    return await resp.json() || [];
  }

  // ── Entity Building ──────────────────────────────────────────

  async getDestinations(): Promise<Entity[]> {
    return [{
      id: 'paultonsparkresort',
      name: 'Paultons Park',
      entityType: 'DESTINATION',
      timezone: this.timezone,
      location: {latitude: 50.948063, longitude: -1.552221},
    } as Entity];
  }

  private extractLocation(entry: POIEntry): {latitude: number; longitude: number} | undefined {
    const geo = entry.entrance_location || entry.location;
    if (geo?.type === 'Point' && geo.coordinates?.length === 2) {
      return {latitude: geo.coordinates[1], longitude: geo.coordinates[0]};
    }
    return undefined;
  }

  protected async buildEntityList(): Promise<Entity[]> {
    const pois = await this.getPOIData();
    const destId = 'paultonsparkresort';
    const parkId = 'paultonspark';

    const parkEntity: Entity = {
      id: parkId,
      name: 'Paultons Park',
      entityType: 'PARK',
      parentId: destId,
      destinationId: destId,
      timezone: this.timezone,
      location: {latitude: 50.94821775877611, longitude: -1.5523016452789309},
    } as Entity;

    const typeMap: Record<string, string> = {
      ride: 'ATTRACTION',
      show: 'SHOW',
      restaurant: 'RESTAURANT',
    };

    const entities = pois
      .filter(poi => typeMap[poi.type])
      .map(poi => {
        const loc = this.extractLocation(poi);
        const entity: Entity = {
          id: String(poi.id),
          name: poi.title,
          entityType: typeMap[poi.type],
          parentId: parkId,
          destinationId: destId,
          timezone: this.timezone,
        } as Entity;
        if (loc) (entity as any).location = loc;
        return entity;
      });

    return [parkEntity, ...entities];
  }

  // ── Live Data ────────────────────────────────────────────────

  protected async buildLiveData(): Promise<LiveData[]> {
    const [liveEntries, pois] = await Promise.all([
      this.getQueueTimes(),
      this.getPOIData(),
    ]);

    // Build orms_id → entity id map
    const ormsMap = new Map<number, string>();
    for (const poi of pois) {
      if (poi.orms_id) {
        ormsMap.set(poi.orms_id, String(poi.id));
      }
    }

    return liveEntries
      .map((entry) => {
        const entityId = ormsMap.get(entry.rideId);
        if (!entityId) return null;

        const ld: LiveData = {
          id: entityId,
          status: entry.statusOpen ? 'OPERATING' : 'CLOSED',
        } as LiveData;

        if (entry.queueTime != null) {
          ld.queue = {
            STANDBY: {waitTime: entry.queueTime},
          };
        }

        return ld;
      })
      .filter((x): x is LiveData => x !== null);
  }

  // ── Schedules ────────────────────────────────────────────────

  protected async buildSchedules(): Promise<EntitySchedule[]> {
    let data: any;
    try {
      const resp = await this.fetchOpeningHours();
      data = await resp.json();
    } catch {
      return [];
    }

    const parkHours: OpeningHoursEntry[] = data?.open?.park;
    if (!parkHours || !Array.isArray(parkHours)) return [];

    const schedule = parkHours.map((entry) => {
      // start/end are ISO 8601 strings (e.g., "2026-04-01T09:00:00.000Z")
      const startDate = new Date(entry.start);
      const endDate = new Date(entry.end);

      const dateStr = formatDate(startDate, this.timezone);

      return {
        date: dateStr,
        type: 'OPERATING',
        openingTime: formatInTimezone(startDate, this.timezone, 'iso'),
        closingTime: formatInTimezone(endDate, this.timezone, 'iso'),
      };
    });

    return [{id: 'paultonspark', schedule} as EntitySchedule];
  }
}

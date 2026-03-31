import {Destination, DestinationConstructor} from '../../destination.js';
import config from '../../config.js';
import {cache} from '../../cache.js';
import {http, HTTPObj} from '../../http.js';
import {inject} from '../../injector.js';
import {destinationController} from '../../destinationRegistry.js';
import type {Entity, LiveData, EntitySchedule} from '@themeparks/typelib';
import {constructDateTime} from '../../datetime.js';
import {createStatusMap} from '../../statusMap.js';
import {TagBuilder} from '../../tags/index.js';

const mapStatus = createStatusMap({
  OPERATING: ['Open', 'Variable schedule'],
  CLOSED: ['Closed'],
  REFURBISHMENT: ['Maintenance'],
  DOWN: ['Disorder'],
}, {parkName: 'Toverland', defaultStatus: 'OPERATING'});

@destinationController({category: 'Toverland'})
export class Toverland extends Destination {
  @config apiBase: string = '';
  @config authToken: string = '';
  @config calendarUrl: string = '';
  @config timezone: string = 'Europe/Amsterdam';

  constructor(options?: DestinationConstructor) {
    super(options);
    this.addConfigPrefix('TOVERLAND');
  }

  private getApiHostname(): string | undefined {
    if (!this.apiBase) return undefined;
    try { return new URL(this.apiBase).hostname; } catch { return undefined; }
  }

  @inject({
    eventName: 'httpRequest',
    hostname: function (this: Toverland) { return this.getApiHostname(); },
  })
  async injectAuth(req: HTTPObj): Promise<void> {
    req.headers = {
      ...req.headers,
      'authorization': `Bearer ${this.authToken}`,
    };
  }

  // ── HTTP Methods ─────────────────────────────────────────────

  @http({cacheSeconds: 60})
  async fetchRideData(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.apiBase}park/ride/operationInfo/list`,
      options: {json: true},
    } as any as HTTPObj;
  }

  @http({cacheSeconds: 14400}) // 4h
  async fetchShowData(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.apiBase}park/show/operationInfo/list`,
      options: {json: true},
    } as any as HTTPObj;
  }

  @http({cacheSeconds: 28800}) // 8h
  async fetchDiningData(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.apiBase}park/foodAndDrinks/operationInfo/list`,
      options: {json: true},
    } as any as HTTPObj;
  }

  @http({cacheSeconds: 86400, healthCheckArgs: ['{month}', '{year}']})
  async fetchCalendar(month: number, year: number): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.calendarUrl}?month=${month}&year=${year}`,
      options: {json: true},
    } as any as HTTPObj;
  }

  // ── Cached Data Helpers ──────────────────────────────────────

  @cache({ttlSeconds: 60})
  async getRideData(): Promise<any[]> {
    const resp = await this.fetchRideData();
    return await resp.json() || [];
  }

  @cache({ttlSeconds: 14400})
  async getShowData(): Promise<any[]> {
    const resp = await this.fetchShowData();
    return await resp.json() || [];
  }

  @cache({ttlSeconds: 28800})
  async getDiningData(): Promise<any[]> {
    const resp = await this.fetchDiningData();
    return await resp.json() || [];
  }

  // ── Entity Building ──────────────────────────────────────────

  async getDestinations(): Promise<Entity[]> {
    return [{
      id: 'toverlandresort',
      name: 'Attractiepark Toverland',
      entityType: 'DESTINATION',
      timezone: this.timezone,
      location: {latitude: 51.3982068, longitude: 5.9838255},
    } as Entity];
  }

  protected async buildEntityList(): Promise<Entity[]> {
    const [rides, shows, dining] = await Promise.all([
      this.getRideData(),
      this.getShowData(),
      this.getDiningData(),
    ]);

    const destId = 'toverlandresort';
    const parkId = 'toverland';

    const parkEntity: Entity = {
      id: parkId,
      name: 'Attractiepark Toverland',
      entityType: 'PARK',
      parentId: destId,
      destinationId: destId,
      timezone: this.timezone,
      location: {latitude: 51.3982068, longitude: 5.9838255},
    } as Entity;

    const rideEntities = this.mapEntities(rides, {
      idField: (item) => String(item.id),
      nameField: (item) => this.extractName(item.name),
      entityType: 'ATTRACTION',
      parentIdField: () => parkId,
      destinationId: destId,
      timezone: this.timezone,
      locationFields: {lat: 'latitude', lng: 'longitude'},
    });

    const showEntities = this.mapEntities(shows, {
      idField: (item) => `show_${item.id}`,
      nameField: (item) => this.extractName(item.name),
      entityType: 'SHOW',
      parentIdField: () => parkId,
      destinationId: destId,
      timezone: this.timezone,
      locationFields: {lat: 'latitude', lng: 'longitude'},
    });

    const diningEntities = this.mapEntities(dining, {
      idField: (item) => `dining_${item.id}`,
      nameField: (item) => this.extractName(item.name),
      entityType: 'RESTAURANT',
      parentIdField: () => parkId,
      destinationId: destId,
      timezone: this.timezone,
      locationFields: {lat: 'latitude', lng: 'longitude'},
    });

    return [parkEntity, ...rideEntities, ...showEntities, ...diningEntities];
  }

  /**
   * Extract a localised name string. The API returns either a string or
   * an object with language keys (en, nl, de).
   */
  private extractName(name: any): string {
    if (!name) return '';
    if (typeof name === 'string') return name;
    return name.en || name.nl || name.de || Object.values(name)[0] as string || '';
  }

  // ── Live Data ────────────────────────────────────────────────

  protected async buildLiveData(): Promise<LiveData[]> {
    const rides = await this.getRideData();

    return rides.map((entry) => {
      const statusName = entry?.last_status?.status?.name?.en;
      if (!statusName) return null;

      const waitTime = entry?.last_waiting_time?.waiting_time;
      if (waitTime === undefined) return null;

      return {
        id: String(entry.id),
        status: mapStatus(statusName),
        queue: {
          STANDBY: {waitTime: Number(waitTime)},
        },
      } as LiveData;
    }).filter((x): x is LiveData => x !== null);
  }

  // ── Schedules ────────────────────────────────────────────────

  protected async buildSchedules(): Promise<EntitySchedule[]> {
    const now = new Date();
    const schedule: Array<{date: string; type: string; openingTime: string; closingTime: string}> = [];

    // Fetch 6 months of calendar data
    for (let i = 0; i < 6; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
      const month = d.getMonth() + 1;
      const year = d.getFullYear();

      try {
        const resp = await this.fetchCalendar(month, year);
        const data = await resp.json();
        if (!data?.days) continue;

        for (const day of data.days) {
          if (!day.openingHoursFrom || !day.openingHoursTo) continue;
          if (day.openingHoursFrom === '00:00:00' || day.openingHoursTo === '00:00:00') continue;

          const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day.dayNr).padStart(2, '0')}`;
          const openTime = day.openingHoursFrom.substring(0, 5); // HH:mm from HH:mm:ss
          const closeTime = day.openingHoursTo.substring(0, 5);

          schedule.push({
            date: dateStr,
            type: 'OPERATING',
            openingTime: constructDateTime(dateStr, openTime, this.timezone),
            closingTime: constructDateTime(dateStr, closeTime, this.timezone),
          });
        }
      } catch {
        // Skip months that fail (e.g., past months returning errors)
      }
    }

    return [{id: 'toverland', schedule} as EntitySchedule];
  }
}

import {Destination, DestinationConstructor} from '../../destination.js';
import config from '../../config.js';
import {cache} from '../../cache.js';
import {http, HTTPObj} from '../../http.js';
import {inject} from '../../injector.js';
import {destinationController} from '../../destinationRegistry.js';
import type {Entity, LiveData, EntitySchedule} from '@themeparks/typelib';
import {constructDateTime, hostnameFromUrl, formatDate} from '../../datetime.js';

/**
 * Format entity names: replace app-specific placeholders with Unicode symbols.
 * {1} → ™  {2} → ®  {3} → ©
 */
function formatName(name: string): string {
  return name
    .replace(/\{1\}/g, '™')
    .replace(/\{2\}/g, '®')
    .replace(/\{3\}/g, '©');
}

/**
 * Map gems_status codes to ThemeParks.wiki status strings.
 * Based on IndoorPoiName class in the Universal Studios Beijing app.
 */
function gemsStatusToStatus(gemsStatus: string): string {
  switch (gemsStatus) {
    case '':  // no status, assume open (e.g. cinema)
    case '1': // Open
    case '2': // Running
      return 'OPERATING';
    case '3': // Closed
    case '5': // UnavailableToday
      return 'CLOSED';
    case '4': // ClosedDueToWeather
    case '6': // UnavailableTemporarily
    case '7': // NotOperational
      return 'DOWN';
    case '8': // ClosedForRoutineMaintenance
      return 'REFURBISHMENT';
    default:
      return 'CLOSED';
  }
}

@destinationController({category: 'Universal'})
export class UniversalStudiosBeijing extends Destination {
  @config baseURL: string = '';
  @config timezone: string = 'Asia/Shanghai';

  constructor(options?: DestinationConstructor) {
    super(options);
    this.addConfigPrefix('UNIVERSALSTUDIOSBEIJING');
    this.addConfigPrefix('UNIVERSALBEIJING');
  }

  // ── Header Injection ─────────────────────────────────────────

  @inject({
    eventName: 'httpRequest',
    hostname: function (this: UniversalStudiosBeijing) { return hostnameFromUrl(this.baseURL); },
  })
  async injectHeaders(req: HTTPObj): Promise<void> {
    req.headers = {
      ...req.headers,
      'language': 'en',
      'IsInPark': '1',
      'OS': 'Android',
      'appversion': '3.6.1',
      'versioncode': '36',
      'USERAREA': 'other',
      'x-date': new Date().toUTCString(),
      'lat': '39.9042',
      'lng': '116.4074',
      'user-agent': 'okhttp/3.12.1',
    };
  }

  // ── HTTP Methods ─────────────────────────────────────────────

  /** Attractions with wait times — cache 1 minute (live data) */
  @http({cacheSeconds: 60})
  async fetchAttractionData(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.baseURL}/map/attraction/list?type_id=&mode=list`,
      options: {json: true},
    } as any as HTTPObj;
  }

  /** Shows with show times — cache 3 hours */
  @http({cacheSeconds: 10800})
  async fetchShowData(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.baseURL}/map/perform/list/v2?type_id=&mode=list&version=1`,
      options: {json: true},
    } as any as HTTPObj;
  }

  /** Month overview (which days park is open) — cache 12 hours */
  @http({cacheSeconds: 43200, healthCheckArgs: ['{year}', '{month}']})
  async fetchMonthOverview(year: number, month: number): Promise<HTTPObj> {
    const yearMonth = `${year}-${String(month).padStart(2, '0')}`;
    return {
      method: 'GET',
      url: `${this.baseURL}/event/calendar?date=${yearMonth}`,
      options: {json: true},
    } as any as HTTPObj;
  }

  /** Daily schedule — cache 1 day */
  @http({cacheSeconds: 86400, healthCheckArgs: ['{today}']})
  async fetchDailySchedule(date: string): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.baseURL}/event/calendar/${date}?meettype=meeting&version=1`,
      options: {json: true},
    } as any as HTTPObj;
  }

  // ── Cached Data Helpers ──────────────────────────────────────

  @cache({ttlSeconds: 60})
  async getAttractionData(): Promise<any[]> {
    const resp = await this.fetchAttractionData();
    const data = await resp.json();
    return data?.data?.list || [];
  }

  @cache({ttlSeconds: 10800})
  async getShowData(): Promise<any[]> {
    const resp = await this.fetchShowData();
    const data = await resp.json();
    return data?.data?.list || [];
  }

  @cache({ttlSeconds: 43200})
  async getMonthOverview(year: number, month: number): Promise<any[]> {
    const resp = await this.fetchMonthOverview(year, month);
    const data = await resp.json();
    return data?.data?.date_list || [];
  }

  @cache({ttlSeconds: 86400})
  async getDailySchedule(date: string): Promise<any | null> {
    const resp = await this.fetchDailySchedule(date);
    const data = await resp.json();
    return data?.data || null;
  }

  // ── Entity Building ──────────────────────────────────────────

  async getDestinations(): Promise<Entity[]> {
    return [{
      id: 'universalbeijingresort',
      name: 'Universal Beijing Resort',
      entityType: 'DESTINATION',
      timezone: this.timezone,
      location: {latitude: 39.853159, longitude: 116.673946},
    } as Entity];
  }

  protected async buildEntityList(): Promise<Entity[]> {
    const [attractions, shows] = await Promise.all([
      this.getAttractionData(),
      this.getShowData(),
    ]);

    const destId = 'universalbeijingresort';
    const parkId = 'universalstudiosbeijing';

    const parkEntity: Entity = {
      id: parkId,
      name: 'Universal Studios Beijing',
      entityType: 'PARK',
      parentId: destId,
      destinationId: destId,
      timezone: this.timezone,
      location: {latitude: 39.853159, longitude: 116.673946},
    } as Entity;

    const attractionEntities = this.mapEntities(attractions, {
      idField: (item) => String(item.id),
      nameField: (item) => formatName(item.title || ''),
      entityType: 'ATTRACTION',
      parentIdField: () => parkId,
      destinationId: destId,
      timezone: this.timezone,
      locationFields: {
        lat: (item) => item.position?.latitude != null ? Number(item.position.latitude) : undefined,
        lng: (item) => item.position?.longitude != null ? Number(item.position.longitude) : undefined,
      },
    });

    const showEntities = this.mapEntities(shows, {
      idField: (item) => String(item.id),
      nameField: (item) => formatName(item.title || ''),
      entityType: 'SHOW',
      parentIdField: () => parkId,
      destinationId: destId,
      timezone: this.timezone,
      locationFields: {
        lat: (item) => item.position?.latitude != null ? Number(item.position.latitude) : undefined,
        lng: (item) => item.position?.longitude != null ? Number(item.position.longitude) : undefined,
      },
    });

    return [parkEntity, ...attractionEntities, ...showEntities];
  }

  // ── Live Data ────────────────────────────────────────────────

  protected async buildLiveData(): Promise<LiveData[]> {
    const [attractions, shows] = await Promise.all([
      this.getAttractionData(),
      this.getShowData(),
    ]);

    const liveData: LiveData[] = [];

    // Attraction wait times
    for (const attraction of attractions) {
      let status = gemsStatusToStatus(attraction.gems_status);
      if (attraction.is_closed) {
        status = 'CLOSED';
      }

      const ld: LiveData = {
        id: String(attraction.id),
        status,
      } as LiveData;

      if (status === 'OPERATING' && attraction.waiting_time != null && attraction.waiting_time >= 0) {
        ld.queue = {
          STANDBY: {waitTime: attraction.waiting_time},
        };
      }

      liveData.push(ld);
    }

    // Show times
    const todayStr = formatDate(new Date(), this.timezone);

    for (const show of shows) {
      let status = gemsStatusToStatus(show.gems_status);
      if (show.is_closed) {
        status = 'CLOSED';
      }

      const ld: LiveData = {
        id: String(show.id),
        status,
      } as LiveData;

      if (show.show_time_arr && Array.isArray(show.show_time_arr)) {
        const showtimes = show.show_time_arr
          .filter((st: any) => st && st.time)
          .map((st: any) => ({
            type: 'Performance Time',
            startTime: constructDateTime(todayStr, st.time, this.timezone),
            endTime: null,
          }));

        if (showtimes.length > 0) {
          ld.showtimes = showtimes;
        }
      }

      liveData.push(ld);
    }

    return liveData;
  }

  // ── Schedules ────────────────────────────────────────────────

  protected async buildSchedules(): Promise<EntitySchedule[]> {
    const now = new Date();
    const schedule: Array<{date: string; type: string; openingTime: string; closingTime: string}> = [];

    // Collect unique months for next 90 days
    const monthsSeen = new Set<string>();
    const monthsToFetch: Array<{year: number; month: number}> = [];
    for (let i = 0; i < 90; i++) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
      const key = `${d.getFullYear()}-${d.getMonth() + 1}`;
      if (!monthsSeen.has(key)) {
        monthsSeen.add(key);
        monthsToFetch.push({year: d.getFullYear(), month: d.getMonth() + 1});
      }
    }

    // Find open dates from month overviews
    const datesToFetch: string[] = [];
    for (const {year, month} of monthsToFetch) {
      const dateList = await this.getMonthOverview(year, month);
      for (const day of dateList) {
        if (day.status) {
          datesToFetch.push(day.date);
        }
      }
    }

    // Fetch daily schedule for each open date
    for (const date of datesToFetch) {
      const dayData = await this.getDailySchedule(date);
      if (!dayData?.service_time?.park) continue;

      const parkData = dayData.service_time.park;
      if (parkData.gems_status !== '1' && parkData.gems_status !== '2') continue;

      if (!parkData.open || !parkData.close) continue;

      schedule.push({
        date,
        type: 'OPERATING',
        openingTime: constructDateTime(date, parkData.open, this.timezone),
        closingTime: constructDateTime(date, parkData.close, this.timezone),
      });
    }

    return [{id: 'universalstudiosbeijing', schedule} as EntitySchedule];
  }
}

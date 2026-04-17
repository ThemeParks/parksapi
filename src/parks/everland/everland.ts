/**
 * Everland Resort, South Korea
 *
 * Two parks: Everland (parkKindCd=01) and Caribbean Bay (parkKindCd=02).
 * Public API at wwwapi.everland.com, no auth required.
 */

import {Destination, DestinationConstructor} from '../../destination.js';
import config from '../../config.js';
import {cache} from '../../cache.js';
import {http, HTTPObj} from '../../http.js';
import {inject} from '../../injector.js';
import {destinationController} from '../../destinationRegistry.js';
import type {Entity, LiveData, EntitySchedule} from '@themeparks/typelib';
import {constructDateTime, formatDate, addDays, hostnameFromUrl} from '../../datetime.js';

// ── Constants ──────────────────────────────────────────────────

const DESTINATION_ID = 'everlandresort';
const TIMEZONE = 'Asia/Seoul';

interface ParkConfig {
  name: string;
  parkId: string;
  parkKindCd: string;
  lat: number;
  lng: number;
}

const PARKS: ParkConfig[] = [
  {name: 'Everland', parkId: 'everland', parkKindCd: '01', lat: 37.295206, lng: 127.204360},
  {name: 'Caribbean Bay', parkId: 'caribbeanbay', parkKindCd: '02', lat: 37.296021, lng: 127.203194},
];

// ── Status mapping ─────────────────────────────────────────────

function mapStatus(operStatusCd: string): string {
  switch (operStatusCd) {
    case 'OPEN':
    case 'RSVP':
      return 'OPERATING';
    case 'RAIN':   // heavy rain
    case 'SMMR':   // summer suspension
    case 'SNOW':   // snow
    case 'THUN':   // thunderstorm
    case 'WIND':   // heavy wind
    case 'LTMP':   // low temperature
    case 'HTMP':   // high temperature
    case 'PMCH':   // PM inspection
    case 'WNTR':   // winter suspension
      return 'DOWN';
    case 'CONR':
      return 'REFURBISHMENT';
    case 'CLOS':
    case 'OVER':
    case 'STND':
    case 'PEND':
    case 'RNTR':   // suspension by renting (private event)
    default:
      return 'CLOSED';
  }
}

// ── Implementation ─────────────────────────────────────────────

@destinationController({category: 'Everland'})
export class Everland extends Destination {
  @config baseURL: string = '';
  @config timezone: string = TIMEZONE;

  constructor(options?: DestinationConstructor) {
    super(options);
    this.addConfigPrefix('EVERLAND');
  }

  getCacheKeyPrefix(): string {
    return 'everland';
  }

  @inject({
    eventName: 'httpRequest',
    hostname: function (this: Everland) { return hostnameFromUrl(this.baseURL); },
  })
  async injectHeaders(req: HTTPObj): Promise<void> {
    req.headers = {
      ...req.headers,
      'Referer': 'https://www.everland.com/',
      'Accept': 'application/json, text/plain, */*',
      'x-user-locale': 'en',
    };
  }

  // ── HTTP Methods ─────────────────────────────────────────────

  @http({cacheSeconds: 60})
  async fetchFacilities(parkKindCd: string): Promise<HTTPObj> {
    const params = new URLSearchParams({
      faciltCateKindCd: '01',
      parkKindCd,
      langCd: 'en',
      disabledCd: 'N',
      latud: '',
      lgtud: '',
      waitSortYn: 'N',
      courseSortYn: 'N',
      limitHeight: '0',
      foodTypeCds: '',
      perfrmSortYn: 'N',
    });
    return {
      method: 'GET',
      url: `${this.baseURL}/api/v1/iam/facilities/kind?${params.toString()}`,
      options: {json: true},
    } as any as HTTPObj;
  }

  @http({cacheSeconds: 43200}) // 12h
  async fetchParkOpenTime(salesDate: string, parkKindCd: string): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.baseURL}/api/v1/iam/facilities/parkOpenTime?salesDate=${salesDate}&parkKindCd=${parkKindCd}`,
      options: {json: true},
    } as any as HTTPObj;
  }

  // ── Cached Data ──────────────────────────────────────────────

  @cache({ttlSeconds: 60})
  async getFacilities(parkKindCd: string): Promise<any[]> {
    const resp = await this.fetchFacilities(parkKindCd);
    const data = await resp.json();
    return data?.faciltList || [];
  }

  // ── Entity Building ──────────────────────────────────────────

  async getDestinations(): Promise<Entity[]> {
    return [{
      id: DESTINATION_ID,
      name: 'Everland Resort',
      entityType: 'DESTINATION',
      timezone: TIMEZONE,
      location: {latitude: 37.295206, longitude: 127.204360},
    } as Entity];
  }

  protected async buildEntityList(): Promise<Entity[]> {
    const entities: Entity[] = [];

    // Park entities
    for (const park of PARKS) {
      entities.push({
        id: park.parkId,
        name: park.name,
        entityType: 'PARK',
        parentId: DESTINATION_ID,
        destinationId: DESTINATION_ID,
        timezone: TIMEZONE,
        location: {latitude: park.lat, longitude: park.lng},
      } as Entity);
    }

    // Fetch attractions for each park
    for (const park of PARKS) {
      const facilities = await this.getFacilities(park.parkKindCd);

      for (const fac of facilities) {
        const name = fac.faciltNameEng || fac.faciltName;
        if (!name) continue;

        const entity: Entity = {
          id: fac.faciltId,
          name,
          entityType: 'ATTRACTION',
          parentId: park.parkId,
          destinationId: DESTINATION_ID,
          timezone: TIMEZONE,
        } as Entity;

        // Location from locList
        if (fac.locList?.length > 0 && fac.locList[0].latud && fac.locList[0].lgtud) {
          (entity as any).location = {
            latitude: Number(fac.locList[0].latud),
            longitude: Number(fac.locList[0].lgtud),
          };
        }

        entities.push(entity);
      }
    }

    return entities;
  }

  // ── Live Data ────────────────────────────────────────────────

  protected async buildLiveData(): Promise<LiveData[]> {
    const liveData: LiveData[] = [];

    for (const park of PARKS) {
      const facilities = await this.getFacilities(park.parkKindCd);

      for (const fac of facilities) {
        const status = mapStatus(fac.operStatusCd || '');

        const ld: LiveData = {
          id: fac.faciltId,
          status,
        } as LiveData;

        if (status === 'OPERATING' && fac.waitTime != null && fac.waitTime !== '' && !isNaN(Number(fac.waitTime))) {
          ld.queue = {
            STANDBY: {waitTime: Number(fac.waitTime)},
          };
        }

        liveData.push(ld);
      }
    }

    return liveData;
  }

  // ── Schedules ────────────────────────────────────────────────

  protected async buildSchedules(): Promise<EntitySchedule[]> {
    const schedules: EntitySchedule[] = [];
    const now = new Date();

    for (const park of PARKS) {
      const schedule: Array<{date: string; type: string; openingTime: string; closingTime: string}> = [];

      for (let i = 0; i < 30; i++) {
        const day = addDays(now, i);
        const salesDate = formatDate(day).replace(/-/g, ''); // YYYYMMDD

        try {
          const resp = await this.fetchParkOpenTime(salesDate, park.parkKindCd);
          const data = await resp.json();

          const hours = Array.isArray(data)
            ? data.find((h: any) => h.openTime && h.closeTime)
            : null;

          if (hours) {
            const dateStr = formatDate(day);
            schedule.push({
              date: dateStr,
              type: 'OPERATING',
              openingTime: constructDateTime(dateStr, hours.openTime, TIMEZONE),
              closingTime: constructDateTime(dateStr, hours.closeTime, TIMEZONE),
            });
          }
        } catch {
          // Skip days that fail
        }
      }

      schedules.push({id: park.parkId, schedule} as EntitySchedule);
    }

    return schedules;
  }
}

/**
 * Lotte World Adventure, Seoul, South Korea
 */

import {Destination, DestinationConstructor} from '../../destination.js';
import config from '../../config.js';
import {cache} from '../../cache.js';
import {http, HTTPObj} from '../../http.js';
import {inject} from '../../injector.js';
import {destinationController} from '../../destinationRegistry.js';
import {createStatusMap} from '../../statusMap.js';
import type {Entity, LiveData, EntitySchedule} from '@themeparks/typelib';
import {AttractionTypeEnum} from '@themeparks/typelib';
import {constructDateTime, formatDate, addDays, hostnameFromUrl} from '../../datetime.js';

// ── Constants ──────────────────────────────────────────────────

const DESTINATION_ID = 'lotteworld';
const PARK_ID = 'lotteworldpark';
const TIMEZONE = 'Asia/Seoul';
const STORE_CD = 'HC01801';
const LANG_CD_EN = 'HC01702';

const LAT = 37.511360;
const LNG = 127.099768;

// ── Status mapping ─────────────────────────────────────────────
// The park was closed during HAR capture so exact codes are unknown.
// Conservative approach: log unknowns and default to CLOSED.

const mapStatus = createStatusMap(
  {
    OPERATING: ['정상운영', 'operating', 'open', 'normal'],
    DOWN: ['일시중단', 'temp closed', 'temporarily closed', 'weather'],
    REFURBISHMENT: ['정기점검', 'maintenance', 'refurbishment'],
    CLOSED: ['운영종료', 'closed', ''],
  },
  {parkName: 'LotteWorld', defaultStatus: 'CLOSED'},
);

// ── Interfaces ─────────────────────────────────────────────────

interface AttractionVo {
  shopSysCd: string;
  atrctNm: string;
  atrctSttsCd: string | null;
  atrctSttsNm: string | null;
  waitTm: string | null;
  useYn: string;
}

interface AllListResponse {
  atrctVoList: AttractionVo[];
}

interface OperTime {
  bgntm: string;
  bgnTmFmt: string;
  endTm: string;
  endTmFmt: string;
  operYn: string;
}

interface ClosedListResponse {
  operTime: OperTime | null;
}

// ── Implementation ─────────────────────────────────────────────

@destinationController({category: 'Lotte World'})
export class LotteWorld extends Destination {
  @config apiURL: string = '';
  @config scheduleURL: string = '';
  @config apiKey: string = '';
  @config timezone: string = TIMEZONE;

  constructor(options?: DestinationConstructor) {
    super(options);
    this.addConfigPrefix('LOTTEWORLD');
  }

  getCacheKeyPrefix(): string {
    return 'lotteworld';
  }

  // ── HTTP injection ───────────────────────────────────────────

  @inject({
    eventName: 'httpRequest',
    hostname: function(this: LotteWorld) { return hostnameFromUrl(this.apiURL); },
  })
  async injectApiKey(req: HTTPObj): Promise<void> {
    req.headers = {
      ...req.headers,
      'apikey': this.apiKey,
      'Content-Type': 'application/json',
      'User-Agent': 'okhttp/4.12.0',
    };
  }

  // ── HTTP Methods ─────────────────────────────────────────────

  @http({cacheSeconds: 60})
  async fetchAllList(langCd: string): Promise<HTTPObj> {
    return {
      method: 'POST',
      url: `${this.apiURL}/master/allList`,
      body: {
        storeCd: STORE_CD,
        langCd,
        custId: '',
        loginId: '',
      },
      options: {json: true},
    } as any as HTTPObj;
  }

  @http({cacheSeconds: 43200}) // 12h — schedule data doesn't change frequently
  async fetchClosedList(storeCd: string, langCd: string, searchDt: string): Promise<HTTPObj> {
    const params = new URLSearchParams({storeCd, langCd, searchDt});
    return {
      method: 'GET',
      url: `${this.scheduleURL}/api/usage-guide/service/closed-list?${params.toString()}`,
      options: {json: true},
    } as any as HTTPObj;
  }

  // ── Cached Data ──────────────────────────────────────────────

  @cache({ttlSeconds: 60})
  async getAllAttractions(): Promise<AttractionVo[]> {
    const resp = await this.fetchAllList(LANG_CD_EN);
    const data: AllListResponse = await resp.json();
    return (data?.atrctVoList || []).filter((a) => a.useYn === 'Y');
  }

  // ── Entity Building ──────────────────────────────────────────

  async getDestinations(): Promise<Entity[]> {
    return [{
      id: DESTINATION_ID,
      name: 'Lotte World Adventure',
      entityType: 'DESTINATION',
      timezone: TIMEZONE,
      location: {latitude: LAT, longitude: LNG},
    } as Entity];
  }

  protected async buildEntityList(): Promise<Entity[]> {
    const entities: Entity[] = [];

    // Park entity
    entities.push({
      id: PARK_ID,
      name: 'Lotte World Adventure',
      entityType: 'PARK',
      parentId: DESTINATION_ID,
      destinationId: DESTINATION_ID,
      timezone: TIMEZONE,
      location: {latitude: LAT, longitude: LNG},
    } as Entity);

    // Attraction entities
    const attractions = await this.getAllAttractions();
    for (const attr of attractions) {
      if (!attr.shopSysCd || !attr.atrctNm) continue;

      entities.push({
        id: String(attr.shopSysCd),
        name: attr.atrctNm,
        entityType: 'ATTRACTION',
        attractionType: AttractionTypeEnum.RIDE,
        parentId: PARK_ID,
        destinationId: DESTINATION_ID,
        timezone: TIMEZONE,
        location: {latitude: LAT, longitude: LNG},
      } as Entity);
    }

    return entities;
  }

  // ── Live Data ────────────────────────────────────────────────

  protected async buildLiveData(): Promise<LiveData[]> {
    const attractions = await this.getAllAttractions();
    const liveData: LiveData[] = [];

    for (const attr of attractions) {
      if (!attr.shopSysCd) continue;

      // When park is closed, atrctSttsCd is null — treat as CLOSED
      const statusInput = attr.atrctSttsNm ?? attr.atrctSttsCd ?? '';
      const status = mapStatus(statusInput);

      const ld: LiveData = {
        id: String(attr.shopSysCd),
        status,
      } as LiveData;

      // waitTm is a numeric string (minutes) when the park is open
      if (status === 'OPERATING' && attr.waitTm !== null && attr.waitTm !== '') {
        const waitTime = parseInt(attr.waitTm, 10);
        if (!isNaN(waitTime)) {
          ld.queue = {
            STANDBY: {waitTime},
          };
        }
      }

      liveData.push(ld);
    }

    return liveData;
  }

  // ── Schedules ────────────────────────────────────────────────

  protected async buildSchedules(): Promise<EntitySchedule[]> {
    const schedule: Array<{date: string; type: string; openingTime: string; closingTime: string}> = [];
    const now = new Date();

    for (let i = 0; i < 40; i++) {
      const day = addDays(now, i);
      const dateStr = formatDate(day);           // YYYY-MM-DD
      const searchDt = dateStr.replace(/-/g, ''); // YYYYMMDD

      try {
        const resp = await this.fetchClosedList(STORE_CD, LANG_CD_EN, searchDt);
        const data: ClosedListResponse = await resp.json();

        const operTime = data?.operTime;
        if (!operTime || operTime.operYn !== 'Y') continue;

        // bgnTmFmt / endTmFmt are in "HH:mm" format
        const openingTime = constructDateTime(dateStr, operTime.bgnTmFmt, TIMEZONE);
        const closingTime = constructDateTime(dateStr, operTime.endTmFmt, TIMEZONE);

        schedule.push({
          date: dateStr,
          type: 'OPERATING',
          openingTime,
          closingTime,
        });
      } catch {
        // Skip days that fail (e.g. beyond available range)
      }
    }

    return [{id: PARK_ID, schedule} as EntitySchedule];
  }
}

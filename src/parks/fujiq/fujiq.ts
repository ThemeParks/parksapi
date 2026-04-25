import {Destination, DestinationConstructor} from '../../destination.js';
import {cache} from '../../cache.js';
import {http, HTTPObj} from '../../http.js';
import {inject} from '../../injector.js';
import config from '../../config.js';
import {destinationController} from '../../destinationRegistry.js';
import {Entity, LiveData, EntitySchedule} from '@themeparks/typelib';
import {constructDateTime, hostnameFromUrl} from '../../datetime.js';
import {TagBuilder} from '../../tags/index.js';

const DESTINATION_ID = 'fujiqhighland';
const PARK_ID = 'fujiqhighland-park';

interface FqFacility {
  id: number;
  facilityCode: string;
  type: string;
  subType?: string | null;
  inOperation?: boolean | null;
  priorityPass?: boolean | null;
  waitingFor?: string | null;
  scheduleToday?: string | null;
  modifiedAt?: number | null;
  name?: string | null;
  title?: string | null;
  category?: string | null;
  area?: string | null;
  feature?: {
    heightLimit?: string | null;
    ageLimit?: string | null;
  } | null;
  tags?: string[] | null;
  lat?: number | null;
  lon?: number | null;
}

interface FqCrawlerEntry {
  facilityId: string;
  inOperation?: boolean | null;
  priorityPass?: boolean | null;
  waitingFor?: string | null;
  scheduleToday?: string | null;
  modifiedAt?: number | null;
}

@destinationController({category: 'Fuji-Q'})
export class FujiQHighland extends Destination {
  @config apiBase: string = '';
  @config websiteBase: string = '';
  @config token: string = '';
  @config userAgent: string = '';
  @config locale: string = 'EN_US';
  @config timezone: string = 'Asia/Tokyo';
  @config scheduleMonthsAhead: number = 3;

  constructor(options?: DestinationConstructor) {
    super(options);
    this.addConfigPrefix('FUJIQ');
  }

  // ===== Injectors =====

  @inject({
    eventName: 'httpRequest',
    hostname: function () { return hostnameFromUrl(this.apiBase); },
  })
  async injectHeaders(req: HTTPObj): Promise<void> {
    if (!this.token) {
      throw new Error('Fuji-Q Highland requires FUJIQ_TOKEN to be set (10-year device JWT)');
    }
    req.headers = {
      ...req.headers,
      'authorization': `Bearer ${this.token}`,
      'user-agent': this.userAgent || 'Dart/3.10 (dart:io)',
      'accept': 'application/json',
    };
  }

  // ===== HTTP Fetches =====

  @http({cacheSeconds: 60, retries: 2})
  async fetchCrawler(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.apiBase}/api/crawler/fujiq?locale=${this.locale}`,
      options: {json: true},
    } as any as HTTPObj;
  }

  @http({cacheSeconds: 21600, retries: 2})
  async fetchFacilities(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.apiBase}/api/facility/information?locale=${this.locale}`,
      options: {json: true},
    } as any as HTTPObj;
  }

  @http({cacheSeconds: 21600, retries: 1})
  async fetchScheduleHtml(year: number, month: number): Promise<HTTPObj> {
    const yyyymm = `${year}${String(month).padStart(2, '0')}`;
    return {
      method: 'GET',
      url: `${this.websiteBase}/schedule/highland/${yyyymm}/index.html`,
      headers: {
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      tags: ['website'],
    } as any as HTTPObj;
  }

  @cache({ttlSeconds: 60})
  async getCrawler(): Promise<FqCrawlerEntry[]> {
    const resp = await this.fetchCrawler();
    const data = await resp.json();
    return Array.isArray(data?.attractions) ? data.attractions : [];
  }

  @cache({ttlSeconds: 21600})
  async getFacilities(): Promise<FqFacility[]> {
    const resp = await this.fetchFacilities();
    const data = await resp.json();
    return Array.isArray(data) ? data : [];
  }

  @cache({ttlSeconds: 21600})
  async getMonthSchedule(year: number, month: number): Promise<{date: string; open: string; close: string}[]> {
    const resp = await this.fetchScheduleHtml(year, month);
    const html = await resp.text();
    return this.parseScheduleHtml(html, year, month);
  }

  // ===== Helpers =====

  private parseWaitingFor(
    raw: string | null | undefined,
    inOperation: boolean,
  ): {status: LiveData['status']; waitTime?: number} {
    if (!raw) return {status: inOperation ? 'OPERATING' : 'CLOSED'};
    const s = raw.trim();

    // Status phrases (EN + JA)
    if (/^preparing$|営業準備中/i.test(s)) return {status: 'CLOSED'};
    if (/closed for maintenance|施設点検/i.test(s)) return {status: 'REFURBISHMENT'};
    if (/^closed$|受付終了/i.test(s)) return {status: 'CLOSED'};
    if (/ticket sales available|時間指定券販売中/i.test(s)) {
      // Reservation-only / priority-pass — ride IS running but walk-up wait isn't tracked
      return {status: 'OPERATING'};
    }

    // "10 Min Wait" or "10分以内" → bucketed at 10
    let m = s.match(/^(\d+)\s*(min wait|分以内)$/i);
    if (m) {
      const n = parseInt(m[1], 10);
      return Number.isFinite(n) ? {status: 'OPERATING', waitTime: n} : {status: 'OPERATING'};
    }

    // "30分" / "30 Min"
    m = s.match(/^(\d+)\s*(min|分)$/i);
    if (m) {
      const n = parseInt(m[1], 10);
      return Number.isFinite(n) ? {status: 'OPERATING', waitTime: n} : {status: 'OPERATING'};
    }

    return {status: inOperation ? 'OPERATING' : 'CLOSED'};
  }

  private parseHeightLimit(raw: string | null | undefined): number | undefined {
    if (!raw) return undefined;
    const m = raw.match(/(\d+)/);
    if (!m) return undefined;
    const n = parseInt(m[1], 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }

  private parseScheduleToday(raw: string | null | undefined): {open: string; close: string} | null {
    if (!raw) return null;
    // Format observed: "9:00~18:00"
    const m = raw.match(/^(\d{1,2}):(\d{2})\s*[~〜～]\s*(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const open = `${m[1].padStart(2, '0')}:${m[2]}:00`;
    const close = `${m[3].padStart(2, '0')}:${m[4]}:00`;
    return {open, close};
  }

  private parseScheduleHtml(
    html: string,
    year: number,
    month: number,
  ): {date: string; open: string; close: string}[] {
    // The schedule table on www.fujiq.jp/schedule/highland/{YYYYMM}/index.html lists
    // one row per day. Open day rows look like: <td>03(金)</td><td>9:00 - 19:00</td><td>...</td>
    // Closed days are: <td>09(木)</td><td> - </td><td>...休園日...</td>
    const rowRe = /<tr[^>]*>\s*<td[^>]*>\s*(\d{1,2})\s*\([^)]*\)\s*<\/td>\s*<td[^>]*>\s*([^<]*?)\s*<\/td>/g;
    const out: {date: string; open: string; close: string}[] = [];
    let m: RegExpExecArray | null;
    while ((m = rowRe.exec(html)) !== null) {
      const day = parseInt(m[1], 10);
      const hours = m[2].trim();
      if (!Number.isFinite(day) || day < 1 || day > 31) continue;

      const hm = hours.match(/^(\d{1,2}):(\d{2})\s*[-–—~〜～]\s*(\d{1,2}):(\d{2})$/);
      if (!hm) continue; // Closed days ("-") or unparseable rows are skipped.
      const open = `${hm[1].padStart(2, '0')}:${hm[2]}:00`;
      const close = `${hm[3].padStart(2, '0')}:${hm[4]}:00`;
      const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      out.push({date, open, close});
    }
    return out;
  }

  // ===== Entities =====

  async getDestinations(): Promise<Entity[]> {
    return [{
      id: DESTINATION_ID,
      name: 'Fuji-Q Highland',
      entityType: 'DESTINATION',
      timezone: this.timezone,
      location: {latitude: 35.4871, longitude: 138.7800},
    } as Entity];
  }

  protected async buildEntityList(): Promise<Entity[]> {
    const facilities = await this.getFacilities();

    const parkEntity: Entity = {
      id: PARK_ID,
      name: 'Fuji-Q Highland',
      entityType: 'PARK',
      parentId: DESTINATION_ID,
      destinationId: DESTINATION_ID,
      timezone: this.timezone,
      location: {latitude: 35.4871, longitude: 138.7800},
    } as Entity;

    const out: Entity[] = [parkEntity];

    for (const f of facilities) {
      // Only attractions and restaurants — skip services, toilets, areas, backups, deleted.
      const isAttraction = f.type === 'attraction';
      const isRestaurant = f.type === 'foodAndRestaurant';
      if (!isAttraction && !isRestaurant) continue;

      const id = f.facilityCode;
      const name = f.name;
      if (!id || !name) continue;

      const entity: Entity = {
        id,
        name,
        entityType: isAttraction ? 'ATTRACTION' : 'RESTAURANT',
        parentId: PARK_ID,
        parkId: PARK_ID,
        destinationId: DESTINATION_ID,
        timezone: this.timezone,
      } as Entity;

      const lat = Number(f.lat);
      const lon = Number(f.lon);
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        entity.location = {latitude: lat, longitude: lon};
      }

      if (isAttraction) {
        const tags: ReturnType<typeof TagBuilder.minimumHeight>[] = [];
        const height = this.parseHeightLimit(f.feature?.heightLimit);
        if (height !== undefined) tags.push(TagBuilder.minimumHeight(height, 'cm'));
        if (f.priorityPass) tags.push(TagBuilder.paidReturnTime());
        if (tags.length > 0) entity.tags = tags as any;
      }

      out.push(entity);
    }

    return out;
  }

  // ===== Live Data =====

  protected async buildLiveData(): Promise<LiveData[]> {
    const [crawler, facilities] = await Promise.all([this.getCrawler(), this.getFacilities()]);

    // Only emit live data for entities we actually surface (i.e. attractions).
    const attractionIds = new Set<string>();
    for (const f of facilities) {
      if (f.type === 'attraction' && f.facilityCode) attractionIds.add(f.facilityCode);
    }

    const out: LiveData[] = [];
    for (const c of crawler) {
      const id = c.facilityId;
      if (!id || !attractionIds.has(id)) continue;

      const inOperation = !!c.inOperation;
      const {status, waitTime} = this.parseWaitingFor(c.waitingFor, inOperation);

      const ld: LiveData = {id, status} as LiveData;
      if (status === 'OPERATING' && typeof waitTime === 'number') {
        ld.queue = {STANDBY: {waitTime}};
      }

      out.push(ld);
    }

    return out;
  }

  // ===== Schedules =====

  protected async buildSchedules(): Promise<EntitySchedule[]> {
    const months = this.scheduleMonthsAhead > 0 ? this.scheduleMonthsAhead : 1;

    // Anchor on Tokyo "today" so month boundaries reflect park-local time.
    const tokyoParts = new Intl.DateTimeFormat('en-CA', {
      timeZone: this.timezone,
      year: 'numeric',
      month: '2-digit',
    }).formatToParts(new Date());
    let year = parseInt(tokyoParts.find((p) => p.type === 'year')?.value ?? '0', 10);
    let month = parseInt(tokyoParts.find((p) => p.type === 'month')?.value ?? '0', 10);

    const days: NonNullable<EntitySchedule['schedule']> = [];
    for (let i = 0; i < months; i++) {
      const monthDays = await this.getMonthSchedule(year, month).catch(() => []);
      for (const d of monthDays) {
        days.push({
          date: d.date,
          type: 'OPERATING',
          openingTime: constructDateTime(d.date, d.open, this.timezone),
          closingTime: constructDateTime(d.date, d.close, this.timezone),
        } as any);
      }
      // Roll forward one month.
      month += 1;
      if (month > 12) {
        month = 1;
        year += 1;
      }
    }

    // Fallback: if multi-month scrape returned nothing, fall back to today's
    // per-facility scheduleToday so we never emit a fully empty schedule when
    // we know the park is operating.
    if (days.length === 0) {
      const facilities = await this.getFacilities();
      const todayParts = new Intl.DateTimeFormat('en-CA', {
        timeZone: this.timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date());
      for (const f of facilities) {
        if (f.type !== 'attraction') continue;
        const parsed = this.parseScheduleToday(f.scheduleToday);
        if (!parsed) continue;
        days.push({
          date: todayParts,
          type: 'OPERATING',
          openingTime: constructDateTime(todayParts, parsed.open, this.timezone),
          closingTime: constructDateTime(todayParts, parsed.close, this.timezone),
        } as any);
        break;
      }
    }

    return [{id: PARK_ID, schedule: days} as EntitySchedule];
  }
}

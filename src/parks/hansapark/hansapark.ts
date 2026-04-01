import {Destination, DestinationConstructor} from '../../destination.js';
import config from '../../config.js';
import {cache} from '../../cache.js';
import {http, HTTPObj} from '../../http.js';
import {destinationController} from '../../destinationRegistry.js';
import type {Entity, LiveData, EntitySchedule} from '@themeparks/typelib';
import {constructDateTime, formatDate, addDays} from '../../datetime.js';

/**
 * Hansa-Park, Sierksdorf, Germany
 *
 * API at hansapark.de/api requires an API key passed as ?key= query param.
 * Entity and schedule data works remotely, but live wait times are only
 * populated on the park's local Wi-Fi network — remote queries return
 * isOpen: null and minutes: 0 for all attractions.
 */
@destinationController({category: 'Hansa-Park'})
export class HansaPark extends Destination {
  @config apiKey: string = '';
  @config baseURL: string = 'https://www.hansapark.de/api';
  @config timezone: string = 'Europe/Berlin';

  constructor(options?: DestinationConstructor) {
    super(options);
    this.addConfigPrefix('HANSAPARK');
  }

  // ── HTTP Methods ─────────────────────────────────────────────

  @http({cacheSeconds: 300}) // 5 min — also contains live wait times
  async fetchAttractions(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.baseURL}/attractions/?key=${this.apiKey}&locale=en`,
      options: {json: true},
    } as any as HTTPObj;
  }

  @http({cacheSeconds: 86400}) // 1 day
  async fetchSeasons(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.baseURL}/seasons/?key=${this.apiKey}&locale=en`,
      options: {json: true},
    } as any as HTTPObj;
  }

  // ── Cached Data ──────────────────────────────────────────────

  @cache({ttlSeconds: 300})
  async getAttractions(): Promise<any[]> {
    const resp = await this.fetchAttractions();
    const data = await resp.json();
    return data?.data || [];
  }

  @cache({ttlSeconds: 86400})
  async getSeasons(): Promise<any[]> {
    const resp = await this.fetchSeasons();
    const data = await resp.json();
    return data?.data || [];
  }

  // ── Category helpers ─────────────────────────────────────────

  private hasCategory(item: any, name: string): boolean {
    return !!item.categories?.find((c: any) => c.name === name);
  }

  // ── Entity Building ──────────────────────────────────────────

  async getDestinations(): Promise<Entity[]> {
    return [{
      id: 'hansa-park-resort',
      name: 'Hansa-Park',
      entityType: 'DESTINATION',
      timezone: this.timezone,
      location: {latitude: 54.0747402, longitude: 10.77961},
    } as Entity];
  }

  protected async buildEntityList(): Promise<Entity[]> {
    const allPois = await this.getAttractions();
    const destId = 'hansa-park-resort';
    const parkId = 'hansa-park';

    const parkEntity: Entity = {
      id: parkId,
      name: 'Hansa-Park',
      entityType: 'PARK',
      parentId: destId,
      destinationId: destId,
      timezone: this.timezone,
      location: {latitude: 54.0747402, longitude: 10.77961},
    } as Entity;

    const attractions = allPois
      .filter(p => this.hasCategory(p, 'Attractions') && !this.hasCategory(p, 'Shows'))
      .map(p => ({
        id: String(p.id),
        name: p.name,
        entityType: 'ATTRACTION',
        parentId: parkId,
        destinationId: destId,
        timezone: this.timezone,
      } as Entity));

    const shows = allPois
      .filter(p => this.hasCategory(p, 'Shows'))
      .map(p => ({
        id: String(p.id),
        name: p.name,
        entityType: 'SHOW',
        parentId: parkId,
        destinationId: destId,
        timezone: this.timezone,
      } as Entity));

    const restaurants = allPois
      .filter(p => this.hasCategory(p, 'Restaurants'))
      .map(p => ({
        id: String(p.id),
        name: p.name,
        entityType: 'RESTAURANT',
        parentId: parkId,
        destinationId: destId,
        timezone: this.timezone,
      } as Entity));

    return [parkEntity, ...attractions, ...shows, ...restaurants];
  }

  // ── Live Data ────────────────────────────────────────────────

  /**
   * Live wait times are only available on the park's local Wi-Fi.
   * Remote API calls return isOpen: null and minutes: 0 for all rides.
   */
  protected async buildLiveData(): Promise<LiveData[]> {
    return [];
  }

  // ── Schedules ────────────────────────────────────────────────

  protected async buildSchedules(): Promise<EntitySchedule[]> {
    const seasons = await this.getSeasons();
    const now = new Date();
    const sixMonths = addDays(now, 180);

    // Filter to valid, non-closed seasons with calendar visibility
    const validSeasons = seasons
      .filter(s => s.seasonStart && s.seasonEnd && !s.isParkClosed && s.showOpeningHoursInCalendar)
      .map(s => ({
        start: new Date(s.seasonStart * 1000),
        end: new Date(s.seasonEnd * 1000),
        openTime: s.parkOpeningHoursFrom as string,
        closeTime: s.parkOpeningHoursTo as string,
      }));

    const schedule: Array<{date: string; type: string; openingTime: string; closingTime: string}> = [];

    // Iterate day-by-day for 6 months
    for (let d = new Date(now); d <= sixMonths; d = addDays(d, 1)) {
      const dateStr = formatDate(d);
      const dayMs = d.getTime();

      // Find matching season
      const season = validSeasons.find(s =>
        dayMs >= s.start.getTime() && dayMs <= s.end.getTime(),
      );
      if (!season) continue;

      schedule.push({
        date: dateStr,
        type: 'OPERATING',
        openingTime: constructDateTime(dateStr, season.openTime, this.timezone),
        closingTime: constructDateTime(dateStr, season.closeTime, this.timezone),
      });
    }

    return [{id: 'hansa-park', schedule} as EntitySchedule];
  }
}

import {Destination, DestinationConstructor} from '../../destination.js';

import {cache} from '../../cache.js';
import {http, HTTPObj} from '../../http.js';
import config from '../../config.js';
import {destinationController} from '../../destinationRegistry.js';
import {
  Entity,
  LiveData,
  EntitySchedule,
} from '@themeparks/typelib';
import {formatInTimezone, addDays} from '../../datetime.js';
import {TagBuilder} from '../../tags/index.js';

@destinationController({category: 'Liseberg'})
export class Liseberg extends Destination {
  @config
  baseURL: string = '';

  @config
  timezone: string = 'Europe/Stockholm';

  constructor(options?: DestinationConstructor) {
    super(options);
    this.addConfigPrefix('LISEBERG');
  }

  // ===== HTTP Fetch Methods =====

  /**
   * Fetch attractions data (entities + live data combined).
   * Cached 1 minute for live data freshness.
   */
  @http({cacheSeconds: 60})
  async fetchAttractions(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.baseURL}app/attractions/`,
      options: {json: true},
    } as any as HTTPObj;
  }

  /**
   * Get attractions data (cached 1 minute)
   */
  @cache({ttlSeconds: 60})
  async getAttractions(): Promise<any[]> {
    const resp = await this.fetchAttractions();
    const data = await resp.json();
    return Array.isArray(data) ? data : [];
  }

  /**
   * Fetch calendar data for a date range.
   * Cached 12 hours.
   */
  @http({cacheSeconds: 43200})
  async fetchCalendar(startDate: string, numDays: number): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.baseURL}calendar/${startDate}/${numDays}`,
      options: {json: true},
    } as any as HTTPObj;
  }

  /**
   * Get calendar data (cached 12 hours)
   */
  @cache({ttlSeconds: 43200})
  async getCalendar(startDate: string, numDays: number): Promise<any[]> {
    try {
      const resp = await this.fetchCalendar(startDate, numDays);
      const data = await resp.json();
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }

  // ===== Timezone Helpers =====

  /**
   * Get the UTC offset string for a given date in Europe/Stockholm timezone.
   * Returns e.g. "+01:00" (CET winter) or "+02:00" (CEST summer).
   */
  private getStockholmOffset(dateStr: string): string {
    const refDate = new Date(`${dateStr}T12:00:00Z`);
    const formatted = formatInTimezone(refDate, 'Europe/Stockholm', 'iso');
    const match = formatted.match(/([+-]\d{2}:\d{2})$/);
    return match ? match[1] : '+01:00';
  }

  // ===== Data Builder Methods =====

  async getDestinations(): Promise<Entity[]> {
    return [{
      id: 'liseberg',
      name: 'Liseberg',
      entityType: 'DESTINATION',
      timezone: this.timezone,
      location: {latitude: 57.6945173, longitude: 11.9936954},
    } as Entity];
  }

  protected async buildEntityList(): Promise<Entity[]> {
    const attractions = await this.getAttractions();

    const destinationId = 'liseberg';
    const parkId = 'lisebergpark';

    const parkEntity: Entity = {
      id: parkId,
      name: 'Liseberg',
      entityType: 'PARK',
      parentId: destinationId,
      destinationId,
      timezone: this.timezone,
      location: {latitude: 57.6945173, longitude: 11.9936954},
    } as Entity;

    const filteredAttractions = attractions.filter(
      (item: any) => item.type === 'attraction',
    );

    const entities = this.mapEntities(filteredAttractions, {
      idField: (item: any) => String(item.id),
      nameField: (item: any) => item.title || '',
      entityType: 'ATTRACTION',
      parentIdField: () => parkId,
      destinationId,
      timezone: this.timezone,
      locationFields: {
        lat: (item: any) => item.coordinates?.latitude,
        lng: (item: any) => item.coordinates?.longitude,
      },
      transform: (entity, item: any) => {
        const lat = item.coordinates?.latitude;
        const lng = item.coordinates?.longitude;
        if (lat && lng) {
          entity.tags = [TagBuilder.location(lat, lng, entity.name as string)];
        }
        return entity;
      },
    });

    return [parkEntity, ...entities];
  }

  protected async buildLiveData(): Promise<LiveData[]> {
    const attractions = await this.getAttractions();
    const liveData: LiveData[] = [];

    for (const item of attractions) {
      if (item.type !== 'attraction') continue;

      const entityId = String(item.id);
      const ld: LiveData = {id: entityId, status: 'CLOSED'} as LiveData;

      if (item.state) {
        ld.status = (item.state.isOpen ? 'OPERATING' : 'CLOSED') as any;

        if (item.state.isOpen && item.state.maxWaitTime != null && item.state.maxWaitTime >= 0) {
          ld.queue = {
            STANDBY: {waitTime: item.state.maxWaitTime},
          };
        }
      }

      liveData.push(ld);
    }

    return liveData;
  }

  protected async buildSchedules(): Promise<EntitySchedule[]> {
    const now = new Date();
    const scheduleEntries: any[] = [];

    // Fetch 60 days in 7-day batches
    for (let dayOffset = 0; dayOffset < 60; dayOffset += 7) {
      const batchStart = addDays(now, dayOffset);
      const startDate = formatInTimezone(batchStart, this.timezone, 'iso').substring(0, 10);
      const numDays = Math.min(7, 60 - dayOffset);

      const days = await this.getCalendar(startDate, numDays);

      for (const day of days) {
        if (day.closed) continue;
        if (!day.dateRaw || !day.openingHoursDetailed) continue;

        const from = day.openingHoursDetailed.from;
        const to = day.openingHoursDetailed.to;
        if (from == null || to == null) continue;

        // dateRaw is "YYYY-MM-DDT00:00:00" - extract the date part
        const dateStr = String(day.dateRaw).substring(0, 10);
        const offset = this.getStockholmOffset(dateStr);

        const openHour = String(from).padStart(2, '0');
        const closeHour = String(to).padStart(2, '0');

        const openingTime = `${dateStr}T${openHour}:00:00${offset}`;
        const closingTime = `${dateStr}T${closeHour}:00:00${offset}`;

        scheduleEntries.push({
          date: dateStr,
          type: 'OPERATING',
          openingTime,
          closingTime,
        });

        // Check for evening entrance hours
        if (day.eveningEntranceFrom) {
          const eveningStr = String(day.eveningEntranceFrom);
          if (eveningStr !== '0' && eveningStr !== '00:00') {
            // Parse HH:MM format
            const eveningParts = eveningStr.split(':');
            const eveningHour = parseInt(eveningParts[0], 10);
            const openHourNum = parseInt(from, 10);
            const closeHourNum = parseInt(to, 10);

            // Only add if evening hours fall between open and close
            if (eveningHour > openHourNum && eveningHour < closeHourNum) {
              const eveningTime = eveningStr.length <= 2
                ? `${eveningStr.padStart(2, '0')}:00`
                : eveningStr;

              const eveningOpeningTime = `${dateStr}T${eveningTime}:00${offset}`;

              scheduleEntries.push({
                date: dateStr,
                type: 'INFO',
                description: 'Evening Hours',
                openingTime: eveningOpeningTime,
                closingTime,
              });
            }
          }
        }
      }
    }

    return [{
      id: 'lisebergpark',
      schedule: scheduleEntries,
    } as EntitySchedule];
  }
}

import {Destination, DestinationConstructor} from '../../destination.js';
import crypto from 'crypto';

import {cache} from '../../cache.js';
import {http, HTTPObj} from '../../http.js';
import {inject} from '../../injector.js';
import config from '../../config.js';
import {destinationController} from '../../destinationRegistry.js';
import {
  Entity,
  LiveData,
  EntitySchedule,
  LanguageCode,
} from '@themeparks/typelib';
import {formatUTC, parseTimeInTimezone, formatInTimezone, addDays, isBefore} from '../../datetime.js';
import {TagBuilder} from '../../tags/index.js';

@config
@destinationController({ category: 'Efteling' })
export class Efteling extends Destination {
  @config
  apiKey: string = '';

  @config
  apiVersion: string = '9';

  @config
  appVersion: string = 'v5.18.0';

  @config
  timezone: string = 'Europe/Amsterdam';

  @config
  language: LanguageCode = 'nl';

  deviceId: string;

  /** Maps single rider alternate IDs to parent entity IDs (populated during entity building) */
  private singleRiderMap: Map<string, string> = new Map();

  constructor(options?: DestinationConstructor) {
    super(options);
    this.addConfigPrefix('EFTELING');
    this.deviceId = crypto.randomUUID();
  }

  /**
   * Inject headers into all HTTP requests for api.efteling.com
   */
  @inject({
    eventName: 'httpRequest',
    hostname: 'api.efteling.com',
  })
  async injectApiHeaders(requestObj: HTTPObj): Promise<void> {
    requestObj.headers = {
      ...requestObj.headers,
      'x-api-key': this.apiKey,
      'x-api-version': this.apiVersion,
      'x-app-version': this.appVersion,
      'x-app-name': 'Efteling',
      'x-app-id': 'nl.efteling.android',
      'x-app-platform': 'Android',
      'x-app-language': requestObj.headers?.['x-app-language'] || 'en',
      'x-app-timezone': 'Europe/Amsterdam',
      'x-app-deviceid': this.deviceId,
      'user-agent': 'okhttp/5.1.0',
    };
  }

  /**
   * Inject headers into all HTTP requests for www.efteling.com
   */
  @inject({
    eventName: 'httpRequest',
    hostname: 'www.efteling.com',
  })
  async injectCalendarHeaders(requestObj: HTTPObj): Promise<void> {
    requestObj.headers = {
      ...requestObj.headers,
      'X-Requested-With': 'XMLHttpRequest',
      'referer': 'https://www.efteling.com/en/park/opening-hours?app=true',
      'cookie': 'website#lang=en',
    };
  }

  // ===== HTTP Fetch Methods =====

  /**
   * Fetch POI data with English language header
   */
  @http({ cacheSeconds: 43200 })
  async fetchPOIEnglish(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: 'https://api.efteling.com/app/poi',
      headers: { 'x-app-language': 'en' },
      options: { json: true },
    } as any as HTTPObj;
  }

  /**
   * Fetch POI data with Dutch language header
   */
  @http({ cacheSeconds: 43200 })
  async fetchPOIDutch(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: 'https://api.efteling.com/app/poi',
      headers: { 'x-app-language': 'nl' },
      options: { json: true },
    } as any as HTTPObj;
  }

  /**
   * Get POI data (cached), returns array of POI hits
   */
  @cache({ ttlSeconds: 43200 })
  async getPOIData(language: string): Promise<any[]> {
    const resp = language === 'nl' ? await this.fetchPOIDutch() : await this.fetchPOIEnglish();
    const data = await resp.json();
    return data?.hits?.hit || [];
  }

  /**
   * Fetch wait time data from WIS endpoint
   */
  @http({ cacheSeconds: 60 })
  async fetchWaitTimes(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: 'https://api.efteling.com/app/wis',
      options: { json: true },
    } as any as HTTPObj;
  }

  /**
   * Get wait times (cached)
   */
  @cache({ ttlSeconds: 60 })
  async getWaitTimes(): Promise<any[]> {
    const resp = await this.fetchWaitTimes();
    const data = await resp.json();
    return data?.AttractionInfo || [];
  }

  /**
   * Fetch calendar/opening hours data
   */
  @http({ cacheSeconds: 43200 })
  async fetchCalendar(year: number, month: number): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `https://www.efteling.com/service/cached/getpoiinfo/en/${year}/${month}`,
      options: { json: true },
    } as any as HTTPObj;
  }

  /**
   * Get calendar data (cached), returns opening hours array
   */
  @cache({ ttlSeconds: 43200 })
  async getCalendar(year: number, month: number): Promise<any[]> {
    try {
      const resp = await this.fetchCalendar(year, month);
      const data = await resp.json();
      return data?.OpeningHours || [];
    } catch {
      // Returns 400 for past months
      return [];
    }
  }

  // ===== Data Builder Methods =====

  async getDestinations(): Promise<Entity[]> {
    return [{
      id: 'eftelingresort',
      name: { en: 'Efteling', nl: 'Efteling' },
      entityType: 'DESTINATION',
      timezone: 'Europe/Amsterdam',
      location: { latitude: 51.649515, longitude: 5.043776 },
    } as Entity];
  }

  protected async buildEntityList(): Promise<Entity[]> {
    const enHits = await this.getPOIData('en');
    const nlHits = await this.getPOIData('nl');

    // Index both by fields.id
    const enMap = new Map<string, any>();
    for (const hit of enHits) {
      if (hit.fields?.id) enMap.set(hit.fields.id, hit.fields);
    }
    const nlMap = new Map<string, any>();
    for (const hit of nlHits) {
      if (hit.fields?.id) nlMap.set(hit.fields.id, hit.fields);
    }

    // Merge: English primary, Dutch fills gaps
    const merged: Array<{ id: string; en: any; nl: any }> = [];
    const allIds = new Set([...enMap.keys(), ...nlMap.keys()]);
    for (const id of allIds) {
      const en = enMap.get(id);
      const nl = nlMap.get(id);
      const primary = en || nl;
      if (!primary) continue;
      merged.push({ id, en: en || nl, nl: nl || en });
    }

    // Clear single rider map (rebuilt each time)
    this.singleRiderMap.clear();

    // Collect entities to build
    const poiEntries: any[] = [];

    for (const { id, en, nl } of merged) {
      const category = en.category;

      // Only include attractions and shows
      if (category !== 'attraction' && category !== 'show') continue;

      // Skip hidden entries
      if (en.hide_in_app) continue;

      // Store single rider mapping
      if (en.alternatetype === 'singlerider' && en.alternateid) {
        this.singleRiderMap.set(en.alternateid, id);
      }

      // Parse location
      let lat: number | undefined;
      let lng: number | undefined;
      if (en.latlon && en.latlon !== '0.0,0.0') {
        const [latStr, lngStr] = en.latlon.split(',');
        lat = parseFloat(latStr);
        lng = parseFloat(lngStr);
      }

      // Build multi-language name with overrides
      let enName = en.name || '';
      let nlName = nl.name || enName;
      if (id === 'stoomtreinr') { enName += ' - Oost'; nlName += ' - Oost'; }
      if (id === 'stoomtreinm') { enName += ' - Marerijk'; nlName += ' - Marerijk'; }

      poiEntries.push({
        id,
        enName,
        nlName,
        category,
        lat,
        lng,
        properties: en.properties || [],
        hasAlternateSingleRider: en.alternatetype === 'singlerider',
      });
    }

    const destinationId = 'eftelingresort';
    const parkId = 'efteling';

    const parkEntity: Entity = {
      id: parkId,
      name: { en: 'Efteling', nl: 'Efteling' },
      entityType: 'PARK',
      parentId: destinationId,
      destinationId,
      timezone: 'Europe/Amsterdam',
      location: { latitude: 51.649515, longitude: 5.043776 },
    } as Entity;

    const attractions = this.mapEntities(
      poiEntries.filter(e => e.category === 'attraction'),
      {
        idField: 'id',
        nameField: (item) => ({ en: item.enName, nl: item.nlName }),
        entityType: 'ATTRACTION',
        parentIdField: () => parkId,
        destinationId,
        timezone: 'Europe/Amsterdam',
        locationFields: { lat: 'lat', lng: 'lng' },
        transform: (entity, item) => {
          entity.tags = this.buildTags(item);
          return entity;
        },
      }
    );

    const shows = this.mapEntities(
      poiEntries.filter(e => e.category === 'show'),
      {
        idField: 'id',
        nameField: (item) => ({ en: item.enName, nl: item.nlName }),
        entityType: 'SHOW',
        parentIdField: () => parkId,
        destinationId,
        timezone: 'Europe/Amsterdam',
        locationFields: { lat: 'lat', lng: 'lng' },
        transform: (entity, item) => {
          entity.tags = this.buildTags(item);
          return entity;
        },
      }
    );

    return [parkEntity, ...attractions, ...shows];
  }

  /**
   * Build tags for an entity from its POI properties
   */
  private buildTags(item: any): any[] {
    const tags: any[] = [];

    // Location
    if (item.lat && item.lng) {
      tags.push(TagBuilder.location(item.lat, item.lng, item.enName));
    }

    // Height restrictions from properties
    for (const prop of item.properties) {
      const heightMatch = prop.match(/^minimum(\d+)$/);
      if (heightMatch) {
        tags.push(TagBuilder.minimumHeight(parseInt(heightMatch[1], 10), 'cm'));
      }
    }

    // Other property tags
    if (item.properties.includes('wet')) tags.push(TagBuilder.mayGetWet());
    if (item.properties.includes('pregnantwomen')) tags.push(TagBuilder.unsuitableForPregnantPeople());
    if (item.properties.includes('babyswitch')) tags.push(TagBuilder.childSwap());

    // Single rider
    if (item.hasAlternateSingleRider) tags.push(TagBuilder.singleRider());

    return tags.filter(Boolean);
  }

  protected async buildLiveData(): Promise<LiveData[]> {
    return [];
  }

  protected async buildSchedules(): Promise<EntitySchedule[]> {
    return [];
  }
}

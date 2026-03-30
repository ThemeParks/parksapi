import {Destination, DestinationConstructor} from '../../destination.js';

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
import {constructDateTime} from '../../datetime.js';
import {TagBuilder} from '../../tags/index.js';

import AdmZip from 'adm-zip';
import {DatabaseSync} from 'node:sqlite';
import {writeFileSync, unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// ── Types ──────────────────────────────────────────────────────

interface PaxLatency {
  drupalId: string;
  latency: number | string | null;
  isOpen: boolean;
  message: string | null;
  openingTime: string | null;
  closingTime: string | null;
}

interface PaxSchedule {
  drupalId: string;
  times: Array<{
    at: string | null;
    startAt: string | null;
    endAt: string | null;
  }>;
}

interface PaxConfiguration {
  parkOpen: boolean;
  parkTimeOpening: string;
  parkTimeClosing: string;
  parkMainText: string;
  parkMainTextOutPark: string;
  updatedAt: string;
  currentEventTag: string | null;
  minAppVersion: string;
  zenchefDrupalIds: string[];
}

interface OfflinePackageInfo {
  id: string;
  version: string;
  fileSize: number;
  md5Signature: string;
  builtAt: string;
  url: string;
  autoDownload: boolean;
  forcePush: boolean;
}

interface SqliteAttraction {
  drupal_id: number;
  title: string;
  experience: string | null;
  latitude: number | null;
  longitude: number | null;
  min_age: number | null;
  min_size: number | null;
  min_size_unaccompanied: number | null;
}

interface SqliteRestaurant {
  drupal_id: number;
  title: string;
  meal_types: string | null;
  latitude: number | null;
  longitude: number | null;
  menu_url: string | null;
  mobile_url: string | null;
}

interface SqliteShow {
  drupal_id: number;
  title: string;
  duration: string | null;
  latitude: number | null;
  longitude: number | null;
}

interface SqliteCalendarItem {
  day: string;
  type: string;
}

interface SqliteLabel {
  key: string;
  value: string;
}

interface POIEntry {
  drupal_id: number;
  title: string;
  latitude: number | null;
  longitude: number | null;
  _type: 'attraction' | 'restaurant' | 'show';
  min_size?: number | null;
  min_size_unaccompanied?: number | null;
}

interface ParsedHours {
  hour: number;
  minute: number;
}

interface TimeRange {
  start: ParsedHours;
  end: ParsedHours;
}

interface ScheduleEntry {
  date: string;
  type: string;
  openingTime: string;
  closingTime: string;
}

// ── Persisted query hashes (v6.0) ──────────────────────────────

const POLLING_HASH = '3ceb23ec91c92568f084a99388dbfe442aae7bfc22c3271a474d27155c89c56d';
const PACKAGE_HASH = '309702a5c744f3389a4cc971c589dfb351d4548701899f6335c17f8095d94982';

// ── Implementation ─────────────────────────────────────────────

@destinationController({category: 'Parc Asterix'})
export class ParcAsterix extends Destination {
  @config apiBase: string = '';
  @config timezone: string = 'Europe/Paris';
  @config language: LanguageCode = 'en';
  @config packageVersion: string = '1.1.73';

  constructor(options?: DestinationConstructor) {
    super(options);
    this.addConfigPrefix('PARCASTERIX');
  }

  // ── API hostname for injector ────────────────────────────────

  private getApiHostname(): string | undefined {
    if (!this.apiBase) return undefined;
    try {
      return new URL(this.apiBase).hostname;
    } catch {
      return undefined;
    }
  }

  // ── Header injection ─────────────────────────────────────────

  @inject({
    eventName: 'httpRequest',
    hostname: function (this: ParcAsterix) {
      return this.getApiHostname();
    },
  })
  async injectHeaders(req: HTTPObj): Promise<void> {
    req.headers = {
      ...req.headers,
      'accept-language': this.language,
      'x-package-version': this.packageVersion,
      'content-type': 'application/json',
    };
  }

  // ── GraphQL: paxPolling (persisted query, GET) ───────────────

  @http({cacheSeconds: 60})
  async fetchPolling(): Promise<HTTPObj> {
    const params = new URLSearchParams({
      operationName: 'paxPolling',
      variables: '{}',
      extensions: JSON.stringify({
        persistedQuery: {version: 1, sha256Hash: POLLING_HASH},
      }),
    });
    return {
      method: 'GET',
      url: `${this.apiBase}graphql?${params.toString()}`,
      options: {json: true},
    } as any as HTTPObj;
  }

  @cache({ttlSeconds: 60})
  async getPolling(): Promise<{
    latencies: PaxLatency[];
    schedules: PaxSchedule[];
  }> {
    const resp = await this.fetchPolling();
    const data = (await resp.json()) as any;
    return {
      latencies: data?.data?.paxLatencies || [],
      schedules: data?.data?.paxSchedules || [],
    };
  }

  // ── GraphQL: paxConfiguration (POST, full query) ─────────────

  @http({cacheSeconds: 300})
  async fetchConfiguration(): Promise<HTTPObj> {
    return {
      method: 'POST',
      url: `${this.apiBase}graphql`,
      body: {
        query: `query paxConfiguration {
  paxConfiguration {
    parkOpen
    parkTimeOpening
    parkTimeClosing
    parkMainText
    parkMainTextOutPark
    updatedAt
    currentEventTag
    minAppVersion
    zenchefDrupalIds
  }
}`,
        variables: {},
      },
      options: {json: true},
    } as any as HTTPObj;
  }

  @cache({ttlSeconds: 300})
  async getConfiguration(): Promise<PaxConfiguration> {
    const resp = await this.fetchConfiguration();
    const data = (await resp.json()) as any;
    return data?.data?.paxConfiguration;
  }

  // ── GraphQL: offlinePackageLast (persisted query, GET) ───────

  @http({cacheSeconds: 3600})
  async fetchPackageInfo(): Promise<HTTPObj> {
    const params = new URLSearchParams({
      operationName: 'offlinePackageLast',
      variables: '{}',
      extensions: JSON.stringify({
        persistedQuery: {version: 1, sha256Hash: PACKAGE_HASH},
      }),
    });
    return {
      method: 'GET',
      url: `${this.apiBase}graphql?${params.toString()}`,
      options: {json: true},
    } as any as HTTPObj;
  }

  @cache({ttlSeconds: 3600})
  async getPackageInfo(): Promise<OfflinePackageInfo> {
    const resp = await this.fetchPackageInfo();
    const data = (await resp.json()) as any;
    return data?.data?.offlinePackageLast;
  }

  // ── Download offline package ZIP ─────────────────────────────

  @http({cacheSeconds: 0}) // No HTTP-level caching — binary ZIP corrupts text cache. Cached by @cache on getPOIData() instead.
  async fetchPackageZip(): Promise<HTTPObj> {
    const info = await this.getPackageInfo();
    if (!info?.url) {
      throw new Error('ParcAsterix: failed to get offline package URL');
    }
    return {
      method: 'GET',
      url: info.url,
      options: {json: false},
      tags: ['package'],
    } as any as HTTPObj;
  }

  // ── SQLite extraction ────────────────────────────────────────

  @cache({ttlSeconds: 43200}) // 12h
  async getPOIData(): Promise<{poi: POIEntry[]; calendar: ScheduleEntry[]}> {
    const resp = await this.fetchPackageZip();
    const buffer = await resp.arrayBuffer();

    const zip = new AdmZip(Buffer.from(buffer));
    const zipEntries = zip.getEntries();

    // Extract from English database first, then merge French
    const cultures = ['en', 'fr'] as const;
    const allPOI: POIEntry[] = [];
    let calendar: ScheduleEntry[] = [];

    for (const culture of cultures) {
      const entry = zipEntries.find(
        (e) => e.entryName.indexOf(`pax_${culture}.sqlite`) >= 0,
      );
      if (!entry) continue;

      const result = this.loadSqliteDatabase(entry.getData(), culture);
      if (culture === cultures[0]) {
        // First culture: use all data
        allPOI.push(...result.poi);
        calendar = result.calendar;
      } else {
        // Merge: add any missing entries from secondary culture
        for (const item of result.poi) {
          const existing = allPOI.find(
            (p) => p.drupal_id === item.drupal_id,
          );
          if (!existing) {
            allPOI.push(item);
          }
        }
      }
    }

    return {poi: allPOI, calendar};
  }

  /**
   * Extract POI + calendar data from a SQLite database buffer.
   * Writes to a temp file because node:sqlite requires a file path.
   */
  private loadSqliteDatabase(
    data: Buffer,
    culture: string,
  ): {poi: POIEntry[]; calendar: ScheduleEntry[]} {
    const tmpFile = join(tmpdir(), `pax_${culture}_${Date.now()}.sqlite`);
    writeFileSync(tmpFile, data);

    try {
      const db = new DatabaseSync(tmpFile);

      // Query entities
      const attractions = db
        .prepare(
          'SELECT drupal_id, title, experience, latitude, longitude, min_age, min_size, min_size_unaccompanied FROM attractions',
        )
        .all() as unknown as SqliteAttraction[];

      const restaurants = db
        .prepare(
          'SELECT drupal_id, title, meal_types, latitude, longitude, menu_url, mobile_url FROM restaurants',
        )
        .all() as unknown as SqliteRestaurant[];

      const shows = db
        .prepare(
          'SELECT drupal_id, title, duration, latitude, longitude FROM shows',
        )
        .all() as unknown as SqliteShow[];

      // Query calendar
      const now = new Date();
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      const calendarItems = db
        .prepare('SELECT day, type FROM calendar_items WHERE day >= ?')
        .all(today) as unknown as SqliteCalendarItem[];

      const labels = db
        .prepare(
          "SELECT key, value FROM labels WHERE key LIKE 'calendar.dateType.legend.%'",
        )
        .all() as unknown as SqliteLabel[];

      db.close();

      // Parse calendar labels into hours map
      const hoursMap = this.parseCalendarLabels(labels);

      // Build calendar entries
      const calendar = this.buildCalendarEntries(calendarItems, hoursMap);

      // Build POI list
      const poi: POIEntry[] = [
        ...attractions.map((a) => ({
          drupal_id: a.drupal_id,
          title: a.title,
          latitude: a.latitude,
          longitude: a.longitude,
          min_size: a.min_size,
          min_size_unaccompanied: a.min_size_unaccompanied,
          _type: 'attraction' as const,
        })),
        ...restaurants.map((r) => ({
          drupal_id: r.drupal_id,
          title: r.title,
          latitude: r.latitude,
          longitude: r.longitude,
          _type: 'restaurant' as const,
        })),
        ...shows.map((s) => ({
          drupal_id: s.drupal_id,
          title: s.title,
          latitude: s.latitude,
          longitude: s.longitude,
          _type: 'show' as const,
        })),
      ];

      return {poi, calendar};
    } finally {
      try {
        unlinkSync(tmpFile);
      } catch {
        // ignore cleanup errors
      }
    }
  }

  // ── Calendar parsing ─────────────────────────────────────────

  /**
   * Parse time strings like "9:30 p.m." or "10am" into hours/minutes.
   */
  private parseTimeString(str: string): ParsedHours | null {
    // Normalize a.m./p.m. → am/pm
    const normalized = str.replace(/([ap])\.m\.?/gi, '$1m');

    // Try HH:MM am/pm/h format
    let match = normalized.match(/(\d+):(\d+)\s*(?:am|pm|h|hr)/i);
    if (match) {
      let hour = parseInt(match[1], 10);
      const minute = parseInt(match[2], 10);
      if (/pm/i.test(normalized) && hour < 12) hour += 12;
      if (/am/i.test(normalized) && hour === 12) hour = 0;
      return {hour, minute};
    }

    // Try H am/pm/h format (no minutes)
    match = normalized.match(/(\d+)\s*(?:am|pm|h|hr)/i);
    if (match) {
      let hour = parseInt(match[1], 10);
      if (/pm/i.test(normalized) && hour < 12) hour += 12;
      if (/am/i.test(normalized) && hour === 12) hour = 0;
      return {hour, minute: 0};
    }

    return null;
  }

  /**
   * Parse calendar labels into a map of date type → time ranges.
   * Labels contain free-form text like:
   *   "10:00 a.m. to 6:00 p.m."
   *   "Daytime 9:00 a.m. - 6:00 p.m. and Evening 7:00 p.m. - 1:00 a.m."
   */
  private parseCalendarLabels(
    labels: SqliteLabel[],
  ): Record<string, TimeRange[]> {
    const hoursMap: Record<string, TimeRange[]> = {};

    const connector = '\\s*(?:-|to)\\s*';
    const postfix = '(?:am|pm|a\\.m|p\\.m|h|hr)\\.?';
    const withMinutes = `\\d+:\\d+\\s*${postfix}`;
    const withoutMinutes = `\\d+\\s*${postfix}`;

    const patterns = [
      new RegExp(
        `(${withMinutes})${connector}(${withMinutes})`,
        'gi',
      ),
      new RegExp(
        `(${withoutMinutes})${connector}(${withoutMinutes})`,
        'gi',
      ),
    ];

    for (const label of labels) {
      const key = label.key.replace('calendar.dateType.legend.', '');
      if (hoursMap[key]) continue;

      for (const pattern of patterns) {
        const matches = label.value.match(pattern);
        if (matches) {
          hoursMap[key] = matches.map((m) => {
            const parts = m.replace(/ to /g, '-').split('-');
            return {
              start: this.parseTimeString(parts[0].trim())!,
              end: this.parseTimeString(parts[1].trim())!,
            };
          }).filter((r) => r.start && r.end);
          break;
        }
      }
    }

    return hoursMap;
  }

  /**
   * Build schedule entries from calendar items + parsed hours map.
   */
  private buildCalendarEntries(
    calendarItems: SqliteCalendarItem[],
    hoursMap: Record<string, TimeRange[]>,
  ): ScheduleEntry[] {
    const entries: ScheduleEntry[] = [];

    for (const item of calendarItems) {
      const hours = hoursMap[item.type];
      if (!hours) continue;

      // SQLite day field may include time portion ("2026-04-04 00:00:00")
      const dateStr = item.day.split(' ')[0];

      for (const range of hours) {
        if (!range.start || !range.end) continue;

        const openTime = `${String(range.start.hour).padStart(2, '0')}:${String(range.start.minute).padStart(2, '0')}`;
        const closeTime = `${String(range.end.hour).padStart(2, '0')}:${String(range.end.minute).padStart(2, '0')}`;

        let openingTime = constructDateTime(dateStr, openTime, this.timezone);
        let closingTime = constructDateTime(dateStr, closeTime, this.timezone);

        // If closing is before opening, it's past midnight — add a day
        if (closingTime <= openingTime) {
          const nextDay = new Date(
            new Date(dateStr + 'T12:00:00Z').getTime() + 86400000,
          );
          const nextDayStr = `${nextDay.getFullYear()}-${String(nextDay.getMonth() + 1).padStart(2, '0')}-${String(nextDay.getDate()).padStart(2, '0')}`;
          closingTime = constructDateTime(nextDayStr, closeTime, this.timezone);
        }

        entries.push({
          date: dateStr,
          type: 'OPERATING',
          openingTime,
          closingTime,
        });
      }
    }

    return entries;
  }

  // ── Entity building ──────────────────────────────────────────

  async getDestinations(): Promise<Entity[]> {
    return [
      {
        id: 'parcasterix',
        name: 'Parc Asterix',
        entityType: 'DESTINATION',
        timezone: this.timezone,
        location: {latitude: 49.13675, longitude: 2.573816},
      } as Entity,
    ];
  }

  protected async buildEntityList(): Promise<Entity[]> {
    const {poi} = await this.getPOIData();

    const parkEntity: Entity = {
      id: 'parcasterixpark',
      name: 'Parc Asterix',
      entityType: 'PARK',
      parentId: 'parcasterix',
      destinationId: 'parcasterix',
      timezone: this.timezone,
      location: {latitude: 49.13675, longitude: 2.573816},
    } as Entity;

    const attractions = this.mapEntities(
      poi.filter((p) => p._type === 'attraction'),
      {
        idField: (item) => String(item.drupal_id),
        nameField: 'title',
        entityType: 'ATTRACTION',
        parentIdField: () => 'parcasterixpark',
        destinationId: 'parcasterix',
        timezone: this.timezone,
        locationFields: {lat: 'latitude', lng: 'longitude'},
        filter: (item) => !!item.drupal_id,
        transform: (entity, item) => {
          const tags = [];
          if (item.min_size && item.min_size > 0) {
            tags.push(TagBuilder.minimumHeight(item.min_size, 'cm'));
          }
          if (
            item.min_size_unaccompanied &&
            item.min_size_unaccompanied > 0
          ) {
            // Unaccompanied minimum height stored as a second height tag
            tags.push(
              TagBuilder.minimumHeight(
                item.min_size_unaccompanied,
                'cm',
              ),
            );
          }
          if (item.latitude && item.longitude) {
            tags.push(
              TagBuilder.location(
                Number(item.latitude),
                Number(item.longitude),
                entity.name as string,
              ),
            );
          }
          if (tags.length > 0) {
            entity.tags = tags;
          }
          return entity;
        },
      },
    );

    const restaurants = this.mapEntities(
      poi.filter((p) => p._type === 'restaurant'),
      {
        idField: (item) => String(item.drupal_id),
        nameField: 'title',
        entityType: 'RESTAURANT',
        parentIdField: () => 'parcasterixpark',
        destinationId: 'parcasterix',
        timezone: this.timezone,
        locationFields: {lat: 'latitude', lng: 'longitude'},
        filter: (item) => !!item.drupal_id,
      },
    );

    return [parkEntity, ...attractions, ...restaurants];
  }

  // ── Live data ────────────────────────────────────────────────

  protected async buildLiveData(): Promise<LiveData[]> {
    const {latencies} = await this.getPolling();

    return latencies.map((entry) => {
      const ld: LiveData = {
        id: String(entry.drupalId),
        status: 'OPERATING',
      } as LiveData;

      if (!entry.isOpen) {
        ld.status = 'CLOSED';
      } else {
        ld.queue = {
          STANDBY: {waitTime: undefined},
        };

        if (entry.latency !== null) {
          const latency =
            typeof entry.latency === 'number'
              ? entry.latency
              : typeof entry.latency === 'string' &&
                  /^\d+$/.test(entry.latency)
                ? parseInt(entry.latency, 10)
                : null;

          if (latency !== null) {
            ld.queue!.STANDBY = {waitTime: latency};
          } else {
            // Unknown latency format — treat as closed
            ld.status = 'CLOSED';
          }
        }
      }

      return ld;
    });
  }

  // ── Schedules ────────────────────────────────────────────────

  protected async buildSchedules(): Promise<EntitySchedule[]> {
    const {calendar} = await this.getPOIData();

    if (!calendar || calendar.length === 0) {
      return [];
    }

    return [
      {
        id: 'parcasterixpark',
        schedule: calendar.map((entry) => ({
          date: entry.date,
          type: entry.type,
          openingTime: entry.openingTime,
          closingTime: entry.closingTime,
        })),
      } as EntitySchedule,
    ];
  }
}

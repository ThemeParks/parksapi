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
  LiveTimeSlot,
  LocalisedString,
  MultilangString,
} from '@themeparks/typelib';
import {constructDateTime, hostnameFromUrl, formatDate, formatInTimezone} from '../../datetime.js';
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
  title_fr?: string | null;
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
  title_fr?: string | null;
  meal_types: string | null;
  latitude: number | null;
  longitude: number | null;
  menu_url: string | null;
  mobile_url: string | null;
}

interface SqliteShow {
  drupal_id: number;
  title: string;
  title_fr?: string | null;
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

export interface POIEntry {
  drupal_id: number;
  title: string;
  /** One entry per culture present in the offline package, e.g. {en, fr, es, nl}. */
  titles: Record<string, string>;
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

// ── Name building ──────────────────────────────────────────────

/**
 * Build the entity name from every culture the offline package carries.
 * Falls back to a plain string when only one culture is available, so a
 * stripped-down package still produces a valid name.
 */
export function buildLocalisedName(item: POIEntry): LocalisedString {
  const entries = Object.entries(item.titles ?? {}).filter(
    ([, value]) => typeof value === 'string' && value.length > 0,
  );
  if (entries.length <= 1) return item.title;

  const name: MultilangString = {};
  for (const [code, value] of entries) {
    name[code as LanguageCode] = value;
  }
  return name;
}

/**
 * Share of the offline package's attraction list that `paxLatencies` has to
 * deliver before an absence from `paxSchedules` is read as a show being dark.
 * Healthy polls carry all of them; half is a wide margin that still refuses a
 * feed returning a handful.
 */
const MIN_ATTRACTION_BILL_FRACTION = 0.5;

/** Local hour at which the previous operating day's after-midnight tail ends. */
const NIGHT_ENDS_HOUR = 6;

/**
 * What today's calendar lets us say about a show that is missing from
 * `paxSchedules`.
 *
 * The bill is not rewritten for the new day at midnight. It goes on serving the
 * last open day's programme until the morning: on 2026-09-09 the bill served
 * from local midnight until 09:28 was still 2026-09-06's, two closed days
 * earlier, and gave itself away by carrying that day's 19:00 close inside a
 * show window that the 09:28 rewrite corrected to 18:00. Absence from that bill
 * means "was not on the last open day", which is not the thing we would be
 * publishing. Today's bill happened to be a subset of it; a day whose programme
 * is larger than the previous open day's would have closed shows that perform.
 *
 * So absence is only read as darkness once the park has opened and the bill has
 * had to become about today. Before that the calendar still settles the one
 * case it knows for certain — on a day the park does not operate, no show
 * performs — and that one matters, because a retained bill means the closed
 * days are exactly when the stale programme looks most like a live one.
 *
 * `parkIsBusy` is the live feed's own vote, and it only ever vetoes: a calendar
 * claiming today is closed while attractions report themselves open is a
 * calendar to distrust, not a park to close.
 *
 * The four answers separate two things that look alike and are not. `stale`
 * means the bill is known to be about a day that has passed, so neither its
 * performances nor its silences may be published — republishing them re-dates
 * the last open day's programme onto today, which is how a wrong showtime comes
 * to look freshly confirmed. `unknown` means we cannot tell, and there the only
 * safe move is to change nothing about what the bill already says.
 */
export function showBillAuthority(
  now: Date,
  timezone: string,
  calendar: ScheduleEntry[],
  parkIsBusy: boolean,
): 'all-dark' | 'read-bill' | 'stale' | 'unknown' {
  // An event night runs past midnight — Halloween closes at 01:00 — so the
  // small hours still belong to the day before. The bill is still that day's
  // and is still correct, so this is `unknown`, not `stale`: the shows on it
  // are mid-performance and their times must keep publishing.
  const localHour = parseInt(formatInTimezone(now, timezone, 'iso').slice(11, 13), 10);
  if (!Number.isFinite(localHour) || localHour < NIGHT_ENDS_HOUR) return 'unknown';

  if (calendar.length === 0) return 'unknown';

  // Closed days carry no hours and so never reach the calendar at all.
  const todaysHours = calendar.filter(
    (entry) => entry.date === formatDate(now, timezone),
  );
  if (todaysHours.length === 0) return parkIsBusy ? 'unknown' : 'all-dark';

  const opensAt = Math.min(
    ...todaysHours.map((entry) => new Date(entry.openingTime).getTime()),
  );
  if (!Number.isFinite(opensAt)) return 'unknown';
  return now.getTime() >= opensAt ? 'read-bill' : 'stale';
}

// ── Implementation ─────────────────────────────────────────────

@destinationController({category: 'Parc Asterix'})
export class ParcAsterix extends Destination {
  @config apiBase: string = '';
  @config timezone: string = 'Europe/Paris';
  @config language: LanguageCode = 'en';
  @config packageVersion: string = '1.1.238';

  /**
   * A backstop for the one absence buildLiveData() cannot read: a show that
   * leaves the offline package as well as the bill, taking its POI row with
   * it. Nothing then names the id, so there is no row to close it against, and
   * the collector being upsert-only means omitting it achieves nothing — four
   * retired shows read OPERATING on the wiki for 8 to 24 days that way. See
   * Destination.retireMissingLiveEntities for the mechanism.
   *
   * Everything else is settled the same poll, from `paxSchedules` directly, so
   * the gate is deliberately the slower and narrower of the two. It has to be:
   * it can only close ids it has watched go absent, which leaves a show whose
   * run ended before it was ever observed invisible to it for good. That is
   * not a hole worth widening — a gate that could close an id on no evidence
   * at all is a worse thing to own — so the bill does that work instead.
   */
  protected retireMissingLiveEntities = true;

  /**
   * Tightened from the 0.5 default because the dark-show closures changed what
   * the default measures. Every show now appears in every build, so the shows
   * inflate the gate's denominator while only the attractions can ever be
   * counted absent — which moved the point at which the gate stops trusting
   * the feed from 29 missing entities to 32, in the direction of trusting it
   * more. Silently widening a guard is not a thing to inherit from a change
   * that was about something else.
   *
   * 0.2 puts it back the other way: more than about a fifth of the tracked set
   * gone at once is distrusted, roughly thirteen attractions. Nothing is lost
   * by being strict here — `paxLatencies` lists every attraction year-round, so
   * an attraction going absent is already an anomaly rather than a retirement,
   * and the absence the gate genuinely exists for (a show losing its POI row)
   * is one or two entities, well under `liveEntityRetirementMinBulk`.
   */
  protected liveEntityRetirementMaxFraction = 0.2;

  constructor(options?: DestinationConstructor) {
    super(options);
    this.addConfigPrefix('PARCASTERIX');
  }

  // ── Header injection ─────────────────────────────────────────

  @inject({
    eventName: 'httpRequest',
    hostname: function (this: ParcAsterix) {
      return hostnameFromUrl(this.apiBase);
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

  // ── GraphQL: paxPolling (POST, full query) ───────────────────

  @http({cacheSeconds: 60})
  async fetchPolling(): Promise<HTTPObj> {
    return {
      method: 'POST',
      url: `${this.apiBase}graphql`,
      body: {
        operationName: 'paxPolling',
        query: `query paxPolling {
  paxLatencies {
    drupalId
    latency
    isOpen
    message
    openingTime
    closingTime
  }
  paxSchedules {
    drupalId
    times {
      at
      startAt
      endAt
    }
  }
}`,
        variables: {},
      },
      options: {json: true},
    } as any as HTTPObj;
  }

  /**
   * A GraphQL failure carries HTTP 200, so defaulting the two bills to `[]`
   * turned every server-side error into a well-formed park with nothing open
   * and no shows on. buildLiveData() reads an absent show as dark, so that
   * silent default is the difference between skipping a poll and publishing a
   * CLOSED across the whole park. Fail the poll and let the next one stand in.
   *
   * A populated `errors` array is rejected even when `data` came back with it.
   * Partial success is ordinary in GraphQL, and the shape that matters here is
   * a full `paxLatencies` beside an `errors`-truncated empty `paxSchedules`:
   * that passes every structural check and reads as a park with every show
   * dark. Both bills come from the one query, so a partial failure is never a
   * poll worth trusting.
   */
  @cache({ttlSeconds: 60})
  async getPolling(): Promise<{
    latencies: PaxLatency[];
    schedules: PaxSchedule[];
  }> {
    const resp = await this.fetchPolling();
    const data = (await resp.json()) as any;

    const errors = (Array.isArray(data?.errors) ? data.errors : [])
      .map((e: any) => e?.message)
      .filter(Boolean)
      .join('; ');
    const missing = ['paxLatencies', 'paxSchedules'].filter(
      (field) => !Array.isArray(data?.data?.[field]),
    );
    if (missing.length || errors) {
      const fault = missing.length
        ? `returned no ${missing.join(' or ')}`
        : 'reported an error';
      throw new Error(
        `ParcAsterix: paxPolling ${fault}` + (errors ? ` — ${errors}` : ''),
      );
    }

    return {
      latencies: data.data.paxLatencies as PaxLatency[],
      schedules: data.data.paxSchedules as PaxSchedule[],
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

  // ── GraphQL: offlinePackageLast (POST, full query) ───────────

  @http({cacheSeconds: 3600})
  async fetchPackageInfo(): Promise<HTTPObj> {
    return {
      method: 'POST',
      url: `${this.apiBase}graphql`,
      body: {
        operationName: 'offlinePackageLast',
        query: `query offlinePackageLast {
  offlinePackageLast {
    id
    version
    fileSize
    md5Signature
    builtAt
    url
    autoDownload
    forcePush
  }
}`,
        variables: {},
      },
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
      throw new Error('ParcAsterix: failed to get offline package URL from API');
    }
    return {
      method: 'GET',
      url: info.url,
      options: {json: false},
      tags: ['package'],
    } as any as HTTPObj;
  }

  // ── SQLite extraction ────────────────────────────────────────

  // cacheVersion 2: POI entries gained a per-culture `titles` map. Old entries
  // still sit in SQLite until their TTL expires but are no longer looked up,
  // so a deploy picks up localised names immediately instead of serving
  // half-a-day of stale single-language ones.
  @cache({ttlSeconds: 43200, cacheVersion: 2}) // 12h
  async getPOIData(): Promise<{poi: POIEntry[]; calendar: ScheduleEntry[]}> {
    const resp = await this.fetchPackageZip();
    const buffer = await resp.arrayBuffer();

    const zip = new AdmZip(Buffer.from(buffer));
    const zipEntries = zip.getEntries();

    // The package ships one database per culture. The first one drives the POI
    // list, coordinates and calendar; the rest contribute their translated
    // titles, so each entity carries every name the park publishes for it.
    // Those translations are not decoration: the wiki holds whichever name the
    // park was publishing when the entity was created, and Parc Asterix
    // switched its whole POI list from French to English in September 2026.
    // Keeping the French title is what lets an existing wiki entity still be
    // recognised after a rename.
    const cultures = [this.language, 'fr', 'en', 'es', 'nl'].filter(
      (c, i, arr) => arr.indexOf(c) === i,
    );
    const allPOI: POIEntry[] = [];
    const byId = new Map<number, POIEntry>();
    let calendar: ScheduleEntry[] = [];
    let primaryLoaded = false;

    for (const culture of cultures) {
      const entry = zipEntries.find(
        (e) => e.entryName.indexOf(`pax_${culture}.sqlite`) >= 0,
      );
      if (!entry) continue;

      const result = this.loadSqliteDatabase(entry.getData(), culture);

      if (!primaryLoaded) {
        // First culture present: it owns the shape of the output.
        primaryLoaded = true;
        for (const item of result.poi) {
          allPOI.push(item);
          byId.set(item.drupal_id, item);
        }
        calendar = result.calendar;
        continue;
      }

      for (const item of result.poi) {
        const existing = byId.get(item.drupal_id);
        if (!existing) {
          // Present in a secondary culture only — still worth publishing.
          allPOI.push(item);
          byId.set(item.drupal_id, item);
          continue;
        }
        // Only fill gaps. Every database carries the French title as well as
        // its own, so a later culture must not overwrite what an earlier one
        // already established — that keeps the result the same whichever
        // subset of databases the package happens to ship.
        for (const [code, value] of Object.entries(item.titles)) {
          existing.titles[code] ??= value;
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

      // `title_fr` only appeared with the September 2026 package rebuild.
      // Select it where the table has it and leave it out where it doesn't,
      // rather than letting an older package fail the whole query.
      const hasColumn = (table: string, column: string): boolean =>
        (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{
          name: string;
        }>).some((c) => c.name === column);
      const titleFr = (table: string): string =>
        hasColumn(table, 'title_fr') ? ', title_fr' : '';

      // Query entities
      const attractions = db
        .prepare(
          `SELECT drupal_id, title${titleFr('attractions')}, experience, latitude, longitude, min_age, min_size, min_size_unaccompanied FROM attractions`,
        )
        .all() as unknown as SqliteAttraction[];

      const restaurants = db
        .prepare(
          `SELECT drupal_id, title${titleFr('restaurants')}, meal_types, latitude, longitude, menu_url, mobile_url FROM restaurants`,
        )
        .all() as unknown as SqliteRestaurant[];

      const shows = db
        .prepare(
          `SELECT drupal_id, title${titleFr('shows')}, duration, latitude, longitude FROM shows`,
        )
        .all() as unknown as SqliteShow[];

      // Query calendar
      const now = new Date();
      const today = formatDate(now);
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

      // Build POI list. Every localised database also carries a `title_fr`
      // column holding the original French name, so a single database is
      // enough to recover both names even if the other cultures are missing
      // from the package.
      const titlesFor = (row: {title: string; title_fr?: string | null}) => {
        const titles: Record<string, string> = {[culture]: row.title};
        if (row.title_fr) titles.fr ??= row.title_fr;
        return titles;
      };

      const poi: POIEntry[] = [
        ...attractions.map((a) => ({
          drupal_id: a.drupal_id,
          title: a.title,
          titles: titlesFor(a),
          latitude: a.latitude,
          longitude: a.longitude,
          min_size: a.min_size,
          min_size_unaccompanied: a.min_size_unaccompanied,
          _type: 'attraction' as const,
        })),
        ...restaurants.map((r) => ({
          drupal_id: r.drupal_id,
          title: r.title,
          titles: titlesFor(r),
          latitude: r.latitude,
          longitude: r.longitude,
          _type: 'restaurant' as const,
        })),
        ...shows.map((s) => ({
          drupal_id: s.drupal_id,
          title: s.title,
          titles: titlesFor(s),
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

        let openingType = 'OPERATING';

        const openTime = `${String(range.start.hour).padStart(2, '0')}:${String(range.start.minute).padStart(2, '0')}`;
        const closeTime = `${String(range.end.hour).padStart(2, '0')}:${String(range.end.minute).padStart(2, '0')}`;

        let openingTime = constructDateTime(dateStr, openTime, this.timezone);
        let closingTime = constructDateTime(dateStr, closeTime, this.timezone);

        // If closing is before opening, it's past midnight — add a day
        if (closingTime <= openingTime) {
          const nextDay = new Date(
            new Date(dateStr + 'T12:00:00Z').getTime() + 86400000,
          );
          const nextDayStr = formatDate(nextDay);
          closingTime = constructDateTime(nextDayStr, closeTime, this.timezone);
          openingType = "TICKETED_EVENT"; // If park is open until next day, it's 99% probably a Halloween night
        }

        entries.push({
          date: dateStr,
          type: openingType,
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
        nameField: (item) => buildLocalisedName(item),
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
        nameField: (item) => buildLocalisedName(item),
        entityType: 'RESTAURANT',
        parentIdField: () => 'parcasterixpark',
        destinationId: 'parcasterix',
        timezone: this.timezone,
        locationFields: {lat: 'latitude', lng: 'longitude'},
        filter: (item) => !!item.drupal_id,
      },
    );

    const shows = this.mapEntities(
      poi.filter((p) => p._type === "show"),
      {
        idField: (item) => String(item.drupal_id),
        nameField: (item) => buildLocalisedName(item),
        entityType: "SHOW",
        parentIdField: () => 'parcasterixpark',
        destinationId: 'parcasterix',
        timezone: this.timezone,
        locationFields: {lat: 'latitude', lng: 'longitude'},
        filter: (item) => !!item.drupal_id,
      },
    );

    return [parkEntity, ...attractions, ...restaurants, ...shows];
  }

  // ── Live data ────────────────────────────────────────────────

  protected async buildLiveData(): Promise<LiveData[]> {
    const {latencies, schedules} = await this.getPolling();

    // Only the dark-show pass below needs the POI list, and it is the one
    // thing here that is worth losing. The rest of this build wants nothing
    // from the offline package, and letting a 23MB ZIP download stand between
    // the bill and the wait times would put every attraction's live row behind
    // a fetch that can fail three separate ways. Degrade to publishing no
    // closures rather than publishing nothing.
    let poi: POIEntry[] = [];
    let calendar: ScheduleEntry[] = [];
    try {
      ({poi, calendar} = await this.getPOIData());
    } catch (err) {
      console.warn(
        `[${this.constructor.name}] offline package unavailable, ` +
          `publishing live data without show closures: ${err}`,
      );
    }

    const liveWaitTimes = latencies.map((entry) => {
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

    const liveShowtimes = schedules.map((entry) => {
      const ld: LiveData = {
        id: String(entry.drupalId),
        status: 'OPERATING',
      } as LiveData;
      const todayStr = formatDate(new Date(), this.timezone);
      const tomorrow = new Date(
        new Date(`${todayStr}T12:00:00Z`).getTime() + 86400000,
      );
      const tomorrowStr = formatDate(tomorrow, this.timezone);

      const showtimes: LiveTimeSlot[] = (entry.times ?? [])
        .map((time): LiveTimeSlot | null => {
          if (time.at) {
            let dayStr = todayStr;
            const hour = parseInt(time.at.split(':')[0], 10);
            // If showtime is before 06:00, it belongs to the next calendar day
            if (Number.isFinite(hour) && hour < 6) {
              dayStr = tomorrowStr;
            }

            const t = constructDateTime(dayStr, time.at, this.timezone);
            return {
              type: 'Performance Time',
              startTime: t,
              endTime: t,
            };
          }

          if (time.startAt && time.endAt) {
            const startHour = parseInt(time.startAt.split(':')[0], 10);
            const startDayStr =
              Number.isFinite(startHour) && startHour < 6 ? tomorrowStr : todayStr;
            const endDayStr =
              time.startAt.localeCompare(time.endAt) >= 0 ? tomorrowStr : startDayStr;

            return {
              type: 'Performance Time',
              startTime: constructDateTime(startDayStr, time.startAt, this.timezone),
              endTime: constructDateTime(endDayStr, time.endAt, this.timezone),
            };
          }

          return null;
        })
        .filter((slot): slot is LiveTimeSlot => slot !== null);

      if (showtimes.length === 0) {
        ld.status = 'CLOSED';
      } else {
        ld.showtimes = showtimes;
      }

      return ld;
    });

    // The two bills have never yet named the same id, and if they ever do the
    // build must still carry one row for it rather than two that contradict
    // each other and leave array order to decide. `paxLatencies` is a direct
    // observation of whether the thing is open, so its status wins; the
    // performances are additional information, so they are carried across
    // rather than dropped.
    const waitTimeById = new Map(liveWaitTimes.map((entry) => [entry.id, entry]));
    const showtimeRows = liveShowtimes.filter((entry) => {
      const observation = waitTimeById.get(entry.id);
      if (!observation) return true;
      if (entry.showtimes) observation.showtimes = entry.showtimes;
      return false;
    });

    // `paxSchedules` is a same-day bill: one entry per show performing today,
    // nothing at all for the rest. A show that is dark therefore produces no
    // row, and because the collector is upsert-only the wiki went on serving
    // the times of whichever day it last performed, still reading OPERATING —
    // three shows were 11 days stale when a user reported it.
    //
    // Absence needs no window to interpret. A bill that names every
    // performance today, and does not name this show, says it has none today,
    // which is what CLOSED says. What absence cannot do is speak for a bill
    // that failed to arrive, so it is only read as darkness when the feed is
    // corroborated and the day it describes is unambiguous — the two guards
    // below.
    const scheduled = new Set(schedules.map((entry) => String(entry.drupalId)));
    // A show has never yet appeared in both bills, but if one ever did, the
    // observation would have to win over the inference: without this the build
    // carries an OPERATING row and a CLOSED row for the one id, and which of
    // them lands is nothing better than array order.
    const observed = new Set(latencies.map((entry) => String(entry.drupalId)));
    const attractions = poi.filter((item) => item._type === 'attraction').length;

    // `paxLatencies` carries every attraction year-round, closed ones included
    // through the winter shutdown, so a short one is a broken poll and never a
    // shut park. Counting it against the package's own attraction total keeps
    // that self-calibrating as the park adds and drops rides, and catches the
    // partial regeneration an emptiness check misses: a bill of one attraction
    // out of fifty would otherwise close every show in the park.
    const corroborated = attractions > 0
      && latencies.length >= attractions * MIN_ATTRACTION_BILL_FRACTION;

    // Whether the bill is about today at all, and what to publish when it is
    // not. See showBillAuthority.
    const authority = showBillAuthority(
      new Date(),
      this.timezone,
      calendar,
      latencies.some((entry) => entry.isOpen),
    );

    const showIds = poi
      .filter((item) => item._type === 'show' && !!item.drupal_id)
      .map((item) => String(item.drupal_id));

    // Morning, before opening, on a day the park does operate: the bill is the
    // last open day's and has not been rewritten yet. Publishing its
    // performances would assert a passed day's programme as today's, and
    // publishing its silences would close shows that are on today's bill once
    // it arrives. Say nothing about shows either way until it does.
    if (authority === 'stale') {
      return liveWaitTimes;
    }

    if (!corroborated || authority === 'unknown') {
      return [...liveWaitTimes, ...showtimeRows];
    }

    // The park is not operating today, so nothing on the bill is about today
    // either. Publishing its performances would re-date the last open day's
    // programme onto a day the park is shut, which is how a closed day ends up
    // looking busier than an open one. The bill's own ids are closed alongside
    // the package's, so an id the package has never carried is not left
    // advertising a performance that cannot happen.
    if (authority === 'all-dark') {
      const dark = [...new Set([...showIds, ...scheduled])]
        .filter((id) => !observed.has(id))
        .map((id) => ({id, status: 'CLOSED'}) as LiveData);
      return [...liveWaitTimes, ...dark];
    }

    const darkShows: LiveData[] = showIds
      .filter((id) => !scheduled.has(id) && !observed.has(id))
      .map((id) => ({id, status: 'CLOSED'}) as LiveData);

    return [...liveWaitTimes, ...showtimeRows, ...darkShows];
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

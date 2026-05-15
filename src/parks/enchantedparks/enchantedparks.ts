import {Destination, type DestinationConstructor} from '../../destination.js';
import {http, type HTTPObj} from '../../http.js';
import {cache} from '../../cache.js';
import config from '../../config.js';
import type {Entity, LiveData, EntitySchedule, ScheduleEntry} from '@themeparks/typelib';
import {constructDateTime} from '../../datetime.js';
import {decodeHtmlEntities} from '../../htmlUtils.js';

export type TribeEvent = {
  start_date: string;       // "YYYY-MM-DD HH:MM:SS"
  end_date: string;         // "YYYY-MM-DD HH:MM:SS"
  all_day: boolean;
  categories?: Array<{name: string}>;
};
export type TribeEventsResponse = {
  events: TribeEvent[];
  total_pages?: number;
  next_rest_url?: string;
};


/**
 * Filter Tribe events to those tagged with `categoryName` and convert to
 * operating-hours schedule entries. Skips all-day events (those are
 * marketing/group events, not operating hours).
 */
export function parseTribeEvents(
  json: TribeEventsResponse,
  categoryName: string,
  timezone: string,
): ScheduleEntry[] {
  const out: ScheduleEntry[] = [];
  for (const ev of json.events ?? []) {
    if (ev.all_day) continue;
    if (!ev.categories?.some(c => c.name === categoryName)) continue;
    // start_date / end_date are "YYYY-MM-DD HH:MM:SS" wall-clock in `timezone`.
    const [date, startTime] = ev.start_date.split(' ');
    if (!date || !startTime) continue;
    const endTime = ev.end_date.split(' ')[1];
    if (!endTime) continue;
    out.push({
      date,
      type: 'OPERATING' as const,
      openingTime: constructDateTime(date, startTime.slice(0, 5), timezone),
      closingTime: constructDateTime(date, endTime.slice(0, 5), timezone),
    });
  }
  return out;
}

/**
 * Fallback parser for the iCal/.ics feed. Extracts VEVENT blocks whose
 * CATEGORIES line includes `categoryName` and converts to operating hours.
 */
export function parseICalFeed(
  text: string,
  categoryName: string,
  timezone: string,
): ScheduleEntry[] {
  const out: ScheduleEntry[] = [];
  // Split into VEVENT blocks. The text uses CRLF or LF; normalise to LF first.
  const blocks = text.replace(/\r\n/g, '\n').split('BEGIN:VEVENT').slice(1);
  for (const block of blocks) {
    const body = block.split('END:VEVENT')[0];
    // Drop all-day events — they use VALUE=DATE: rather than a TZID:… form.
    if (/DTSTART;VALUE=DATE:/.test(body)) continue;
    const cats = body.match(/^CATEGORIES:(.+)$/m)?.[1] ?? '';
    if (!cats.split(',').map(s => s.trim()).includes(categoryName)) continue;
    const start = body.match(/DTSTART(?:;[^:]+)?:(\d{8})T(\d{6})/);
    const end   = body.match(/DTEND(?:;[^:]+)?:(\d{8})T(\d{6})/);
    if (!start) continue;
    const dateStr = `${start[1].slice(0,4)}-${start[1].slice(4,6)}-${start[1].slice(6,8)}`;
    const startHm = `${start[2].slice(0,2)}:${start[2].slice(2,4)}`;
    const endHm = end ? `${end[2].slice(0,2)}:${end[2].slice(2,4)}` : startHm;
    out.push({
      date: dateStr,
      type: 'OPERATING' as const,
      openingTime: constructDateTime(dateStr, startHm, timezone),
      closingTime: constructDateTime(dateStr, endHm, timezone),
    });
  }
  return out;
}

export type AttractionStub = {slug: string; name: string};

/**
 * Extract attraction stubs from a `/rides-and-experiences/<path>/` page.
 * Each entry has a slug (URL fragment) and a name (h3 heading text).
 *
 * The pages embed each ride as a card with a link
 *   <a href="…/rides-and-experiences/attractions/{slug}/">…</a>
 * and a heading `<h3>{name}</h3>`. Both appear inside the same card markup,
 * so we collect distinct slug→name pairs by walking the HTML in order.
 */
export function parseAttractionsPage(html: string): AttractionStub[] {
  const seen = new Set<string>();
  const out: AttractionStub[] = [];
  // Two-phase h3 search: first look for the next <h3> within ~2KB after the
  // link (the common case — h3 inside or immediately after the card's <a>).
  // If none is found, fall back to the most-recent <h3> in the 2KB before the
  // link (for cards that put the heading above the anchor).
  const linkRe = /href=["'][^"']*\/rides-and-experiences\/attractions\/([a-z0-9][a-z0-9-]*)\/?["'][^>]*>/gi;
  const h3Re = /<h3[^>]*>([\s\S]*?)<\/h3>/gi;
  for (const m of html.matchAll(linkRe)) {
    const slug = m[1];
    if (seen.has(slug)) continue;
    const linkPos = m.index!;
    // Search a window of ~2KB after the link first, then before, for the nearest h3.
    const afterStart = linkPos;
    const afterEnd = Math.min(html.length, linkPos + 2000);
    const afterWindow = html.slice(afterStart, afterEnd);
    let h3: RegExpMatchArray | null = null;
    // Try after the link
    h3Re.lastIndex = 0;
    const afterMatch = h3Re.exec(afterWindow);
    if (afterMatch) {
      h3 = afterMatch;
    } else {
      // Try before the link
      const beforeStart = Math.max(0, linkPos - 2000);
      const beforeWindow = html.slice(beforeStart, linkPos);
      h3Re.lastIndex = 0;
      let candidate: RegExpMatchArray | null = null;
      let cur: RegExpMatchArray | null;
      while ((cur = h3Re.exec(beforeWindow)) !== null) {
        candidate = cur;
      }
      h3 = candidate;
    }
    if (!h3) continue;
    const name = decodeHtmlEntities(h3[1].replace(/<[^>]+>/g, '').trim());
    if (!name) continue;
    seen.add(slug);
    out.push({slug, name});
  }
  return out;
}

export type ParkConfig = {
  /** Entity id, e.g. `enchantedparks_park_VF` */
  id: string;
  /** Display name */
  name: string;
  /** Path under `/rides-and-experiences/` whose page lists this park's attractions */
  ridesPath: string;
  /** Tribe Events category name that flags this park's operating-hours events (e.g. `Park Hours`, `Waterpark Hours`) */
  scheduleCategory: string;
};

@config
class EnchantedParks extends Destination {
  /** Subdomain root, e.g. `https://valleyfair.enchantedparks.com` (no trailing slash) */
  @config subdomain: string = '';
  /** Top-level destination id, e.g. `enchantedparks_valleyfair` */
  @config destinationId: string = '';
  /** Display name for the DESTINATION entity */
  @config destinationName: string = '';
  /** Optional theme-park child PARK */
  themePark?: ParkConfig;
  /** Optional water-park child PARK */
  waterPark?: ParkConfig;
  /** IANA timezone for the destination */
  @config timezone: string = 'America/Chicago';

  constructor(options?: DestinationConstructor) {
    super(options);
    this.addConfigPrefix('ENCHANTEDPARKS');
    // Apply themePark/waterPark from options.config since they aren't @config primitives.
    const cfg = (options?.config ?? {}) as Partial<EnchantedParks>;
    if (cfg.themePark) this.themePark = cfg.themePark;
    if (cfg.waterPark) this.waterPark = cfg.waterPark;
  }

  /** Cache-key prefix so multiple Enchanted Parks don't collide on shared cache keys. */
  getCacheKeyPrefix(): string {
    return `enchantedparks:${this.destinationId}`;
  }

  // ===== HTTP =====

  /**
   * Fetch one page of Tribe Events for a date range. The WP plugin silently
   * caps page size at 50 regardless of `per_page`, so callers must paginate
   * (`page=1, 2, …`) using the `total_pages` field in the response. We
   * request `per_page=50` to make the cap explicit at the call site.
   */
  @http({cacheSeconds: 60 * 60, retries: 2})
  async fetchTribeEvents(startDate: string, endDate: string, page: number = 1): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.subdomain}/wp-json/tribe/events/v1/events?per_page=50&page=${page}&start_date=${encodeURIComponent(startDate)}&end_date=${encodeURIComponent(endDate)}`,
      options: {json: true},
    } as any as HTTPObj;
  }

  @http({cacheSeconds: 60 * 60, retries: 2})
  async fetchICalFeed(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.subdomain}/?post_type=tribe_events&ical=1&eventDisplay=list`,
      options: {json: false},
    } as any as HTTPObj;
  }

  @http({cacheSeconds: 60 * 60 * 24, retries: 2})
  async fetchAttractionsPage(ridesPath: string): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.subdomain}/rides-and-experiences/${ridesPath}/`,
      options: {json: false},
    } as any as HTTPObj;
  }

  // ===== Schedule scraping =====

  /**
   * Schedule for the next 90 days for one specific category. Tries the
   * Tribe REST endpoint first (paginating through all pages, since the
   * server caps each at 50 events); on any failure or empty result, falls
   * back to the iCal feed. Returns [] when both sources fail.
   *
   * Cached 1h.
   */
  @cache({ttlSeconds: 60 * 60})
  async scrapeSchedule(category: string): Promise<ScheduleEntry[]> {
    const today = new Date();
    const end = new Date(today.getTime() + 90 * 24 * 60 * 60 * 1000);
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    const startStr = fmt(today);
    const endStr = fmt(end);

    try {
      const all: ScheduleEntry[] = [];
      let page = 1;
      // Safety cap so a malformed response (total_pages: huge) can't loop
      // indefinitely. 30 pages × 50 events = 1500 events — well above any
      // realistic season.
      const MAX_PAGES = 30;
      while (page <= MAX_PAGES) {
        const resp = await this.fetchTribeEvents(startStr, endStr, page);
        const json = await resp.json() as TribeEventsResponse;
        const pageEntries = parseTribeEvents(json, category, this.timezone);
        all.push(...pageEntries);
        const totalPages = json.total_pages ?? 1;
        if (page >= totalPages) break;
        page += 1;
      }
      if (all.length > 0) return all;
      // Fall through to iCal if Tribe returned no matches — possible if WP
      // changes the REST contract or temporarily strips categories.
    } catch {
      // Fall through to iCal on any Tribe REST failure.
    }

    try {
      const resp = await this.fetchICalFeed();
      const text = await resp.text();
      return parseICalFeed(text, category, this.timezone);
    } catch {
      return [];
    }
  }

  // ===== Public-API overrides =====

  async getDestinations(): Promise<Entity[]> {
    if (!this.destinationId) return [];
    return [{
      id: this.destinationId,
      name: this.destinationName,
      entityType: 'DESTINATION',
      timezone: this.timezone,
    } as Entity];
  }

  protected async buildEntityList(): Promise<Entity[]> {
    return [];
  }

  protected async buildLiveData(): Promise<LiveData[]> {
    // No live wait-times source for Enchanted Parks until their app launches.
    return [];
  }

  protected async buildSchedules(): Promise<EntitySchedule[]> {
    return [];
  }
}

export {EnchantedParks};

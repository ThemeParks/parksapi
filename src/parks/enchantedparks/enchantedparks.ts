import {Destination, type DestinationConstructor} from '../../destination.js';
import {http, type HTTPObj} from '../../http.js';
import {cache} from '../../cache.js';
import config from '../../config.js';
import type {Entity, LiveData, EntitySchedule, ScheduleEntry} from '@themeparks/typelib';
import {constructDateTime, formatDate} from '../../datetime.js';
import {decodeHtmlEntities, stripHtmlTags} from '../../htmlUtils.js';
import {createStatusMap} from '../../statusMap.js';

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
    const [endDate, endTime] = ev.end_date.split(' ');
    if (!endDate || !endTime) continue;
    out.push({
      date,
      type: 'OPERATING' as const,
      openingTime: constructDateTime(date, startTime.slice(0, 5), timezone),
      // Use end_date's own date so a cross-midnight close (e.g. evening event
      // ending after 00:00 the next day) doesn't fold the closing time back
      // before opening.
      closingTime: constructDateTime(endDate, endTime.slice(0, 5), timezone),
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
    const startDateStr = `${start[1].slice(0,4)}-${start[1].slice(4,6)}-${start[1].slice(6,8)}`;
    const startHm = `${start[2].slice(0,2)}:${start[2].slice(2,4)}`;
    // Use DTEND's own date for closingTime so cross-midnight events (DTEND
    // on the next day) don't fold the closing time back before opening.
    const endDateStr = end
      ? `${end[1].slice(0,4)}-${end[1].slice(4,6)}-${end[1].slice(6,8)}`
      : startDateStr;
    const endHm = end ? `${end[2].slice(0,2)}:${end[2].slice(2,4)}` : startHm;
    out.push({
      date: startDateStr,
      type: 'OPERATING' as const,
      openingTime: constructDateTime(startDateStr, startHm, timezone),
      closingTime: constructDateTime(endDateStr, endHm, timezone),
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
 *   <a href="…/rides-and-experiences/{linkPathSegment}/{slug}/">…</a>
 * and a heading `<h3>{name}</h3>`. Both appear inside the same card markup,
 * so we collect distinct slug→name pairs by walking the HTML in order.
 *
 * `linkPathSegment` is the category segment the detail-page links use —
 * this is independent of whatever page is being scraped. Every attraction
 * (including water-park ones, listed on a separate page) links back to
 * `/rides-and-experiences/attractions/{slug}/`, so ride-listing scrapes
 * always pass `'attractions'` regardless of which page they fetched. Dining
 * cards link to `/rides-and-experiences/dining/{slug}/`, so dining scrapes
 * pass `'dining'`.
 */
export function parseAttractionsPage(html: string, linkPathSegment: string = 'attractions'): AttractionStub[] {
  const seen = new Set<string>();
  const out: AttractionStub[] = [];
  // Two-phase h3 search: first look for the next <h3> within ~2KB after the
  // link (the common case — h3 inside or immediately after the card's <a>).
  // If none is found, fall back to the most-recent <h3> in the 2KB before the
  // link (for cards that put the heading above the anchor).
  const escapedSegment = linkPathSegment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const linkRe = new RegExp(
    `href=["'][^"']*/rides-and-experiences/${escapedSegment}/([a-z0-9][a-z0-9-]*)/?["'][^>]*>`,
    'gi',
  );
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
    const name = decodeHtmlEntities(stripHtmlTags(h3[1]));
    if (!name) continue;
    seen.add(slug);
    out.push({slug, name});
  }
  return out;
}

/**
 * Slugify a name for use in an entity id. Shows have no detail-page URL to
 * take a slug from (see {@link parseShowsPage}), so we derive one from the
 * display name instead: strip trademark/ampersand glyphs, lowercase, and
 * collapse everything else to single hyphens.
 */
function slugify(name: string): string {
  return name
    .replace(/[™®©]/g, '')
    .replace(/&/g, ' and ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Extract show stubs from a `/rides-and-experiences/<path>/` page (e.g.
 * `live-entertainment`). Unlike rides and dining, show cards have no
 * individual detail-page link to take a slug from — they're inline content
 * blocks:
 *   <article class="… category-{categorySlug} …">
 *     <figure>…</figure>
 *     <div class="container"><h4>{name}</h4> … </div>
 *   </article>
 *
 * `categorySlug` is the WordPress category class suffix (e.g.
 * `live-entertainment`) that marks a card as a show rather than one of the
 * other card types (footer CTAs, upsells, …) mixed into the same page.
 */
export function parseShowsPage(html: string, categorySlug: string): AttractionStub[] {
  const seen = new Set<string>();
  const out: AttractionStub[] = [];
  const escapedCategory = categorySlug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const cardRe = new RegExp(`<article\\b[^>]*\\bcategory-${escapedCategory}\\b[^>]*>`, 'gi');
  const h4Re = /<h4[^>]*>([\s\S]*?)<\/h4>/i;
  for (const m of html.matchAll(cardRe)) {
    const cardStart = m.index! + m[0].length;
    const cardEnd = Math.min(html.length, cardStart + 3000);
    const window = html.slice(cardStart, cardEnd);
    const h4 = h4Re.exec(window);
    if (!h4) continue;
    const name = decodeHtmlEntities(stripHtmlTags(h4[1]));
    if (!name) continue;
    const slug = slugify(name);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    out.push({slug, name});
  }
  return out;
}

// ===== Live ride status (operator guest-experience API) =====
//
// The operator runs a guest-experience platform whose live feed publishes a
// per-attraction `operationalStatus`. It's the only real-time source for these
// parks (there are no published wait times). The status distinguishes an
// all-day CLOSED ride from a temporarily-DOWN one — a distinction the operator
// app itself collapses. Endpoint + key are config (kept in `.env`), never
// hardcoded here.

/** One attraction record from the operator's live feed. */
export type LiveFeature = {
  /** Display name, prefixed with a park code, e.g. "WOF - RipCord". */
  name: string;
  /** Site the feature belongs to, e.g. "Worlds of Fun". */
  parentName: string;
  /** Free-text operational status, e.g. "Open", "Temporarily Closed". */
  operationalStatus: string;
};

/**
 * Map the feed's free-text status to a framework status. The feed uses
 * inconsistent casing (Open/OPEN) and both spaced and underscored temporary-
 * closure strings; `createStatusMap` lowercases before lookup so one entry per
 * spelling covers every casing. Unknown/empty defaults to CLOSED and logs once.
 */
export const mapFeatureStatus = createStatusMap(
  {
    OPERATING: ['open', 'opened'],
    DOWN: ['temporarily closed', 'temporarily_closed', 'temp closed', 'temp closed due weather'],
    CLOSED: ['closed', 'not scheduled', ''],
  },
  {parkName: 'EnchantedParks', defaultStatus: 'CLOSED'},
);

/**
 * Normalize a scraped ride name for cross-source matching: fold curly
 * apostrophes and trademark glyphs, lowercase, and collapse any run of
 * non-alphanumerics to a single space. Does NOT strip leading words.
 */
export function normalizeRideName(name: string): string {
  return name
    .replace(/[‘’]/g, "'")
    .replace(/[™®©]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Normalize a live-feed feature name. Same as {@link normalizeRideName} but
 * first strips the uppercase park-code prefix ("WOF - ", "OOF - ", "SSA - ")
 * that the feed carries and the scraped ride names don't. The prefix strip is
 * uppercase-only so it can't eat a leading word from a scraped name.
 */
export function normalizeFeatureName(name: string): string {
  return normalizeRideName(name.replace(/^[A-Z]{2,5}\s*-\s*/, ''));
}

/**
 * Join live-feed features to scraped ride entities by normalized name and
 * emit LiveData. Only features whose `parentName` is in `siteNames` are used,
 * so a same-named ride at a sibling park can't bleed across. Features with no
 * matching ride entity (POS registers, gates, retail carts, points offers) are
 * dropped — the ride roster is the scraped entity list, not the feed.
 */
export function matchFeaturesToLiveData(
  features: LiveFeature[],
  siteNames: string[],
  rides: Array<{id: string; name: string}>,
): LiveData[] {
  if (!siteNames.length) return [];
  const siteSet = new Set(siteNames);
  const statusByName = new Map<string, string>();
  for (const f of features) {
    if (!siteSet.has(f.parentName)) continue;
    const key = normalizeFeatureName(f.name);
    if (!key) continue;
    statusByName.set(key, mapFeatureStatus(f.operationalStatus));
  }

  const out: LiveData[] = [];
  const emitted = new Set<string>();
  for (const r of rides) {
    if (emitted.has(r.id)) continue;
    const status = statusByName.get(normalizeRideName(r.name));
    if (!status) continue;
    emitted.add(r.id);
    out.push({id: r.id, status} as LiveData);
  }
  return out;
}

export type ParkConfig = {
  /** Entity id, e.g. `enchantedparks_park_VF` */
  id: string;
  /** Short code used in attraction ids (e.g. `VF`, `VFW`). Must be unique across parks in this destination. */
  code: string;
  /** Display name */
  name: string;
  /** Path under `/rides-and-experiences/` whose page lists this park's attractions */
  ridesPath: string;
  /** Path under `/rides-and-experiences/` whose page lists this park's dining locations. Omit if not scraped. */
  diningPath?: string;
  /** Path/category under `/rides-and-experiences/` whose page lists this park's shows. Omit if not scraped. */
  showsPath?: string;
  /** Tribe Events category name that flags this park's operating-hours events (e.g. `Park Hours`, `Waterpark Hours`) */
  scheduleCategory: string;
  /** Park-level geographic location (lat/lng). Required for the harness's anchor-entity check. */
  location?: {latitude: number; longitude: number};
};

/** Paginated list of live attraction statuses across every site. */
const LIST_FEATURES_QUERY =
  'query($nextToken:String){ listFeatures(limit:300, nextToken:$nextToken){ nextToken items{ name parentName operationalStatus } } }';

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
  /** Destination-level geographic location (lat/lng) */
  destinationLocation?: {latitude: number; longitude: number};

  /**
   * Optional snapshot of per-attraction coordinates, keyed by attraction
   * name. The EP WordPress source does not expose ride-level lat/lng, so
   * without this every collector tick proposes deleting the existing
   * location data on each attraction. Subclasses load a static JSON
   * snapshot from `locations/<slug>.json` taken when the park was migrated.
   * Attractions added by EP later will land without coordinates and need
   * the moderation queue.
   */
  protected attractionLocations?: Record<string, {latitude: number; longitude: number}>;

  /**
   * Lookup table for attractionLocations, keyed by normalized name. Lazily
   * built on first use so subclasses can assign `attractionLocations` in
   * the constructor without ordering concerns.
   */
  private normalizedLocations?: Map<string, {latitude: number; longitude: number}>;

  /**
   * Normalize ride names for cross-source matching. The WP source uses
   * curly apostrophes (’ U+2019) while the wiki snapshot stores straight
   * ones — without folding both to the same form we lose ~20% of matches.
   */
  private normalizeName(name: string): string {
    return name.replace(/[‘’]/g, "'").toLowerCase();
  }

  protected lookupAttractionLocation(
    rideName: string,
  ): {latitude: number; longitude: number} | undefined {
    if (!this.attractionLocations) return undefined;
    if (!this.normalizedLocations) {
      this.normalizedLocations = new Map(
        Object.entries(this.attractionLocations).map(
          ([k, v]) => [this.normalizeName(k), v] as const,
        ),
      );
    }
    return this.normalizedLocations.get(this.normalizeName(rideName));
  }
  /** IANA timezone for the destination */
  @config timezone: string = 'America/Chicago';

  /**
   * Operator live guest-experience API — GraphQL endpoint and public key.
   * Empty by default; real values come from `.env` (never hardcoded per the
   * no-secrets rule). When either is empty, live data is skipped.
   */
  @config liveStatusEndpoint: string = '';
  @config liveStatusApiKey: string = '';

  /**
   * Site name(s) in the operator's live feed that belong to this destination
   * (matched against a feature's `parentName`). Set per subclass. When unset,
   * live data is skipped.
   */
  liveStatusSites?: string[];

  constructor(options?: DestinationConstructor) {
    super(options);
    this.addConfigPrefix('ENCHANTEDPARKS');
    // Apply themePark/waterPark/destinationLocation from options.config since they aren't @config primitives.
    const cfg = (options?.config ?? {}) as Partial<EnchantedParks>;
    if (cfg.themePark) this.themePark = cfg.themePark;
    if (cfg.waterPark) this.waterPark = cfg.waterPark;
    if (cfg.destinationLocation) this.destinationLocation = cfg.destinationLocation;
    if (cfg.liveStatusSites) this.liveStatusSites = cfg.liveStatusSites;
  }

  /** Cache-key prefix so multiple Enchanted Parks don't collide on shared cache keys. */
  getCacheKeyPrefix(): string {
    return `enchantedparks:${this.destinationId}`;
  }

  protected async _init(): Promise<void> {
    if (!this.subdomain) {
      throw new Error(
        `${this.constructor.name} requires a subdomain to be configured ` +
        `(set ${this.constructor.name.toUpperCase()}_SUBDOMAIN or ENCHANTEDPARKS_SUBDOMAIN in .env)`,
      );
    }
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
  @cache({ttlSeconds: 60 * 60 * 12})
  async scrapeSchedule(category: string): Promise<ScheduleEntry[]> {
    const today = new Date();
    const end = new Date(today.getTime() + 90 * 24 * 60 * 60 * 1000);
    // Anchor the date-range window on the destination's local calendar day
    // rather than UTC. `toISOString().slice(0,10)` was off by ±1 day across
    // the local-midnight boundary, which could drop a day from the query
    // range (e.g. at 11pm UTC for an America/Chicago park, the local date
    // is already the next day but UTC is still on the current day).
    const startStr = formatDate(today, this.timezone);
    const endStr = formatDate(end, this.timezone);

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

  // ===== Attraction scraping =====

  /**
   * Fetch and parse the rides listing for one PARK. Returns [] if the
   * fetch fails so a missing waterpark page doesn't take out the whole
   * destination.
   */
  @cache({ttlSeconds: 60 * 60 * 24})
  async scrapeAttractions(ridesPath: string): Promise<AttractionStub[]> {
    try {
      const resp = await this.fetchAttractionsPage(ridesPath);
      const html = await resp.text();
      return parseAttractionsPage(html);
    } catch {
      return [];
    }
  }

  /**
   * Fetch and parse the dining listing for one PARK. Same page shape as
   * {@link scrapeAttractions} (the WP theme reuses its card markup for every
   * `/rides-and-experiences/<category>/` listing), just pointed at the
   * dining category and linking back to `/rides-and-experiences/dining/…`
   * detail pages instead of `/attractions/…`.
   */
  @cache({ttlSeconds: 60 * 60 * 24})
  async scrapeDining(diningPath: string): Promise<AttractionStub[]> {
    try {
      const resp = await this.fetchAttractionsPage(diningPath);
      const html = await resp.text();
      return parseAttractionsPage(html, 'dining');
    } catch {
      return [];
    }
  }

  /**
   * Fetch and parse the shows listing for one PARK. See
   * {@link parseShowsPage} for why this needs its own parser rather than
   * reusing {@link parseAttractionsPage}.
   */
  @cache({ttlSeconds: 60 * 60 * 24})
  async scrapeShows(showsPath: string): Promise<AttractionStub[]> {
    try {
      const resp = await this.fetchAttractionsPage(showsPath);
      const html = await resp.text();
      return parseShowsPage(html, showsPath);
    } catch {
      return [];
    }
  }

  // ===== Public-API overrides =====

  async getDestinations(): Promise<Entity[]> {
    if (!this.destinationId) return [];
    const dest: Entity = {
      id: this.destinationId,
      name: this.destinationName,
      entityType: 'DESTINATION',
      timezone: this.timezone,
    } as Entity;
    if (this.destinationLocation) {
      (dest as any).location = this.destinationLocation;
    }
    return [dest];
  }

  protected async buildEntityList(): Promise<Entity[]> {
    const parks: Entity[] = [];
    const attractions: Entity[] = [];

    // Resolve waterpark first so we know which slugs belong to it.
    let waterParkSlugs = new Set<string>();
    if (this.waterPark) {
      const wpRides = await this.scrapeAttractions(this.waterPark.ridesPath);
      waterParkSlugs = new Set(wpRides.map(r => r.slug));
      const wpEntity: Entity = {
        id: this.waterPark.id,
        name: this.waterPark.name,
        entityType: 'PARK',
        parentId: this.destinationId,
        destinationId: this.destinationId,
        timezone: this.timezone,
      } as Entity;
      if (this.waterPark.location) {
        (wpEntity as any).location = this.waterPark.location;
      }
      parks.push(wpEntity);
      for (const r of wpRides) {
        const entity: Entity = {
          id: `enchantedparks_attraction_${this.waterPark.code}_${r.slug}`,
          name: r.name,
          entityType: 'ATTRACTION',
          parentId: this.waterPark.id,
          parkId: this.waterPark.id,
          destinationId: this.destinationId,
          timezone: this.timezone,
        } as Entity;
        const loc = this.lookupAttractionLocation(r.name);
        if (loc) (entity as any).location = loc;
        attractions.push(entity);
      }
    }

    if (this.themePark) {
      const tpRides = await this.scrapeAttractions(this.themePark.ridesPath);
      const tpEntity: Entity = {
        id: this.themePark.id,
        name: this.themePark.name,
        entityType: 'PARK',
        parentId: this.destinationId,
        destinationId: this.destinationId,
        timezone: this.timezone,
      } as Entity;
      if (this.themePark.location) {
        (tpEntity as any).location = this.themePark.location;
      }
      parks.push(tpEntity);
      for (const r of tpRides) {
        // The master attractions page lists every ride including the waterpark
        // ones. Skip slugs already claimed by the waterpark page so they don't
        // double-emit.
        if (waterParkSlugs.has(r.slug)) continue;
        const entity: Entity = {
          id: `enchantedparks_attraction_${this.themePark.code}_${r.slug}`,
          name: r.name,
          entityType: 'ATTRACTION',
          parentId: this.themePark.id,
          parkId: this.themePark.id,
          destinationId: this.destinationId,
          timezone: this.timezone,
        } as Entity;
        const loc = this.lookupAttractionLocation(r.name);
        if (loc) (entity as any).location = loc;
        attractions.push(entity);
      }

      if (this.themePark.diningPath) {
        const dining = await this.scrapeDining(this.themePark.diningPath);
        for (const d of dining) {
          const entity: Entity = {
            id: `enchantedparks_restaurant_${this.themePark.code}_${d.slug}`,
            name: d.name,
            entityType: 'RESTAURANT',
            parentId: this.themePark.id,
            parkId: this.themePark.id,
            destinationId: this.destinationId,
            timezone: this.timezone,
          } as Entity;
          const loc = this.lookupAttractionLocation(d.name);
          if (loc) (entity as any).location = loc;
          attractions.push(entity);
        }
      }

      if (this.themePark.showsPath) {
        const shows = await this.scrapeShows(this.themePark.showsPath);
        for (const s of shows) {
          const entity: Entity = {
            id: `enchantedparks_show_${this.themePark.code}_${s.slug}`,
            name: s.name,
            entityType: 'SHOW',
            parentId: this.themePark.id,
            parkId: this.themePark.id,
            destinationId: this.destinationId,
            timezone: this.timezone,
          } as Entity;
          const loc = this.lookupAttractionLocation(s.name);
          if (loc) (entity as any).location = loc;
          attractions.push(entity);
        }
      }
    }

    return [...parks, ...attractions];
  }

  // ===== Live ride status =====

  /**
   * Fetch one page of the operator's live attraction feed. Cached 1min at the
   * HTTP layer — every subclass POSTs the same query/body, so the shared HTTP
   * cache serves all six parks from a single network round-trip per page.
   * `retries: 0` — a transient miss just yields no live update this tick.
   */
  @http({cacheSeconds: 60, retries: 0, healthCheckArgs: ['']})
  async fetchFeatures(nextToken: string | null): Promise<HTTPObj> {
    return {
      method: 'POST',
      url: this.liveStatusEndpoint,
      headers: {
        'x-api-key': this.liveStatusApiKey,
        'content-type': 'application/json',
      },
      // Coerce an empty token (e.g. from the health check's args) to null so
      // the feed returns the first page rather than erroring on an empty string.
      body: {query: LIST_FEATURES_QUERY, variables: {nextToken: nextToken || null}},
      options: {json: true},
    } as any as HTTPObj;
  }

  /**
   * All live attraction records across every site, following pagination.
   * Returns [] on any failure so live-data build degrades to "no update"
   * rather than throwing.
   */
  @cache({ttlSeconds: 60})
  async getFeatures(): Promise<LiveFeature[]> {
    if (!this.liveStatusEndpoint || !this.liveStatusApiKey) return [];
    const out: LiveFeature[] = [];
    let nextToken: string | null = null;
    let guard = 0;
    try {
      do {
        const resp = await this.fetchFeatures(nextToken);
        const data = await resp.json();
        const box = data?.data?.listFeatures;
        if (!box) break;
        for (const it of box.items ?? []) {
          if (!it?.name) continue;
          out.push({
            name: it.name,
            parentName: it.parentName ?? '',
            operationalStatus: it.operationalStatus ?? '',
          });
        }
        nextToken = box.nextToken ?? null;
      } while (nextToken && ++guard < 20);
    } catch {
      return [];
    }
    return out;
  }

  /**
   * Rebuild the (entity id, name) pairs for this destination's attractions,
   * using the same id formula as {@link buildEntityList} so live data attaches
   * to the entities already emitted. Restaurants and shows are excluded — the
   * live feed only carries attractions.
   */
  private async getAttractionStubs(): Promise<Array<{id: string; name: string}>> {
    const stubs: Array<{id: string; name: string}> = [];

    let waterParkSlugs = new Set<string>();
    if (this.waterPark) {
      const wpRides = await this.scrapeAttractions(this.waterPark.ridesPath);
      waterParkSlugs = new Set(wpRides.map(r => r.slug));
      for (const r of wpRides) {
        stubs.push({id: `enchantedparks_attraction_${this.waterPark.code}_${r.slug}`, name: r.name});
      }
    }

    if (this.themePark) {
      const tpRides = await this.scrapeAttractions(this.themePark.ridesPath);
      for (const r of tpRides) {
        if (waterParkSlugs.has(r.slug)) continue;
        stubs.push({id: `enchantedparks_attraction_${this.themePark.code}_${r.slug}`, name: r.name});
      }
    }

    return stubs;
  }

  protected async buildLiveData(): Promise<LiveData[]> {
    // Live per-attraction status from the operator's guest-experience feed.
    // Requires the endpoint/key (from .env) and the site-name mapping.
    if (!this.liveStatusEndpoint || !this.liveStatusApiKey) return [];
    if (!this.liveStatusSites?.length) return [];

    const features = await this.getFeatures();
    if (!features.length) return [];

    const rides = await this.getAttractionStubs();
    return matchFeaturesToLiveData(features, this.liveStatusSites, rides);
  }

  protected async buildSchedules(): Promise<EntitySchedule[]> {
    const out: EntitySchedule[] = [];
    if (this.themePark) {
      const schedule = await this.scrapeSchedule(this.themePark.scheduleCategory);
      out.push({id: this.themePark.id, schedule} as EntitySchedule);
    }
    if (this.waterPark) {
      const schedule = await this.scrapeSchedule(this.waterPark.scheduleCategory);
      out.push({id: this.waterPark.id, schedule} as EntitySchedule);
    }
    return out;
  }
}

export {EnchantedParks};

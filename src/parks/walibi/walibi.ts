/**
 * Walibi / Bellewaerde / Compagnie des Alpes parks
 *
 * 4 parks sharing the same API pattern: each park has its own domain,
 * API shortcode, and API key. Rides with a queue board are keyed on the
 * CMS wait-time id; everything else — the rest of the rides, and every
 * restaurant — is keyed on its CMS path (attr_xxx, dining_xxx).
 *
 * Wait times are in seconds (divided by 60 for minutes).
 */

import {Destination, DestinationConstructor} from '../../destination.js';
import config from '../../config.js';
import {cache} from '../../cache.js';
import {http, HTTPObj} from '../../http.js';
import {inject} from '../../injector.js';
import {destinationController} from '../../destinationRegistry.js';
import type {Entity, LiveData, EntitySchedule} from '@themeparks/typelib';
import {constructDateTime, hostnameFromUrl} from '../../datetime.js';
import {createStatusMap} from '../../statusMap.js';

const mapStatus = createStatusMap({
  OPERATING: ['open', 'Open'],
  CLOSED: ['closed', 'Closed', 'closed_indefinitely', 'temporary_closed', 'full_and_closed', 'custom', 'unknown_status', 'not_operational'],
  DOWN: ['full', 'Full', 'Down'],
  REFURBISHMENT: ['maintenance', 'Maintenance'],
}, {parkName: 'Walibi', defaultStatus: 'OPERATING'});

/** Statuses that should be excluded from live data entirely */
const SKIP_STATUSES = new Set(['not_operational']);

/**
 * CMS path slugs that must be keyed on the path rather than on
 * `waitingTimeName`, because the feed hands their wait-time id to another POI
 * as well.
 *
 * Walibi Holland's two Walibi Express stations are 150m apart and share one
 * queue board, so the CMS gives both rows
 * `460e803c-6f87-442c-86b6-3cd80280beaf`. Two entities under one id means one
 * is silently discarded: Station 2 has never existed on the wiki.
 *
 * Listed explicitly rather than resolved by a first-wins or last-wins rule,
 * because the winner has to be Station 1 and neither rule can guarantee that.
 * Station 1 holds the shared id on the wiki today, and the feed happens to
 * list Station 2 first — so first-wins would rename the live record and
 * orphan its history, and last-wins would do the same the day the feed
 * reorders. Naming the loser is the only order-independent answer.
 *
 * The wait feed carries a single row for the shared id, which stays with
 * Station 1. Station 2 publishes without live data, like any path-keyed ride.
 */
const PATH_KEYED_ATTRACTIONS = new Set([
  'walibi-express-station-2',
]);

// ── Types ──────────────────────────────────────────────────────

interface AttractionPOI {
  title: string;
  latitude?: number;
  longitude?: number;
  waitingTimeName?: string;
  path?: string;
}

interface WaitTimeEntry {
  id: string;
  status: string;
  time?: number | string;
}

// ── Base class ─────────────────────────────────────────────────

@config
class WalibiBase extends Destination {
  @config apiKey: string = '';
  @config baseURL: string = '';

  /** API shortcode (e.g., 'who', 'blw', 'wra', 'wbe') */
  apiShortcode: string = '';
  /** Culture/language code for API requests */
  culture: string = 'en';
  /** Locales merged into the attraction list on top of `culture` (see getAttractions) */
  mergeCultures: string[] = ['nl', 'fr', 'en'];
  /** Destination-level entity ID */
  destinationSlug: string = '';
  /** Park-level entity ID */
  parkSlug: string = '';
  /** Park display name */
  parkName: string = '';
  /** Park coordinates */
  parkLat: number = 0;
  parkLng: number = 0;

  constructor(options?: DestinationConstructor) {
    super(options);
  }

  getCacheKeyPrefix(): string {
    return `walibi:${this.destinationSlug}`;
  }

  /**
   * Extract the last path segment from a CMS path as a stable slug.
   *
   * The CMS derives that segment from the display name without sanitising it,
   * so it can carry characters the entity id charset (`/^[\w.-]+$/`) rejects —
   * "Pêche & Mignon" arrives as `p-che-&-mignon`, which trips the dev
   * harness's id check (`src/testRunner.ts`) and takes the whole Walibi
   * Belgium entity list down with it.
   *
   * Rewrite only runs that contain a rejected character, absorbing the hyphens
   * immediately around them so `p-che-&-mignon` lands on `p-che-mignon` rather
   * than `p-che---mignon`. A slug that already satisfies `/^[\w.-]+$/` matches
   * nothing and comes through byte-identical — by construction, not by luck.
   *
   * That guarantee is the point: the CMS emits trailing hyphens
   * (`stardocks-caf-`, `wild-rock-caf-`) and doubled ones (`cafe--rouge`),
   * all legal and all live entity ids. Collapsing or trimming hyphens
   * unconditionally would rename them, and would let `cafe--rouge` and
   * `cafe-rouge` collide into one entity with nothing to detect it.
   */
  private pathSlug(path: string | undefined): string | null {
    if (!path) return null;
    const segment = path.split('/').pop();
    if (!segment) return null;
    // A non-empty segment always sanitises to a non-empty slug: a rejected run
    // becomes a hyphen, which the charset accepts.
    return segment.replace(/-*[^\w.-]+-*/g, '-');
  }

  // ── Header injection ─────────────────────────────────────────

  @inject({
    eventName: 'httpRequest',
    hostname: function (this: WalibiBase) { return hostnameFromUrl(this.baseURL); },
  })
  async injectHeaders(req: HTTPObj): Promise<void> {
    req.headers = {
      ...req.headers,
      'x-api-key': this.apiKey,
    };
  }

  // ── HTTP Methods ─────────────────────────────────────────────

  @http({cacheSeconds: 86400})
  async fetchAttractions(culture: string = this.culture): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.baseURL}api/${this.apiShortcode}/${culture}/attractions.v1.json`,
      options: {json: true},
    } as any as HTTPObj;
  }

  @http({cacheSeconds: 86400})
  async fetchRestaurants(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.baseURL}api/${this.apiShortcode}/${this.culture}/restaurants.v1.json`,
      options: {json: true},
    } as any as HTTPObj;
  }

  @http({cacheSeconds: 60})
  async fetchWaitTimes(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.baseURL}api/${this.apiShortcode}/waitingtimes.v1.json`,
      options: {json: true},
    } as any as HTTPObj;
  }

  @http({cacheSeconds: 86400})
  async fetchCalendar(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.baseURL}api/${this.apiShortcode}/nl/openinghours.v1.json`,
      options: {json: true},
    } as any as HTTPObj;
  }

  // ── Cached Data ──────────────────────────────────────────────

  /**
   * The CMS serves one attractions feed per locale and those feeds are
   * maintained independently, so they drift. Walibi Belgium's `nl` and `en`
   * feeds both omit VAMPIRE (waitingTimeName 34) while `fr` lists it, which is
   * how the drift was found — that park is now configured on `fr`, so the
   * merge is no longer what recovers VAMPIRE. What it does recover today is Le
   * Galion and Tam Tam Aventure on Walibi Rhône-Alpes, absent from `fr` but
   * listed elsewhere; and it makes the next such gap a non-event.
   *
   * Merge keyed on waitingTimeName — the only id stable across locales; title
   * and path are both locale-specific. The configured culture is authoritative
   * for names and coordinates; a fallback locale can only ever add a ride the
   * primary feed never listed, never overwrite one. Entries without a
   * waitingTimeName are ignored here — buildEntityList drops them anyway.
   */
  @cache({ttlSeconds: 86400, cacheVersion: 2})
  async getAttractions(): Promise<AttractionPOI[]> {
    const attractions = [...await this.fetchAttractionList(this.culture)];
    const seen = new Set(attractions.map(a => a.waitingTimeName).filter(Boolean));

    for (const culture of this.mergeCultures) {
      if (culture === this.culture) continue;

      for (const poi of await this.fetchAttractionList(culture)) {
        if (!poi.waitingTimeName || seen.has(poi.waitingTimeName)) continue;
        seen.add(poi.waitingTimeName);
        attractions.push(poi);
        console.warn(`[${this.constructor.name}] "${poi.title}" (${poi.waitingTimeName}) is missing from the '${this.culture}' feed, taken from '${culture}'`);
      }
    }

    return attractions;
  }

  /**
   * One locale's attraction feed.
   *
   * A *fallback* locale that fails is skipped — the merge is a bonus and must
   * not be able to sink the poll. The *configured* locale is not optional: a
   * transient 5xx there has to propagate so the cycle is skipped, exactly as
   * it did before the merge existed. Swallowing it would publish a clean,
   * empty, wrong park and pin that `[]` in the 24h cache for every process
   * sharing it.
   *
   * A locale the CMS doesn't serve answers 200 with `[]`, not 404, so an
   * unknown locale costs a request and adds nothing rather than throwing.
   */
  private async fetchAttractionList(culture: string): Promise<AttractionPOI[]> {
    try {
      const resp = await this.fetchAttractions(culture);
      const data = await resp.json();
      return Array.isArray(data) ? data : [];
    } catch (err) {
      if (culture === this.culture) throw err;
      return [];
    }
  }

  // cacheVersion 2: the restaurants feed follows `culture`, and Walibi Belgium
  // moved nl -> fr. Without the bump the park would serve `fr` attractions
  // next to `nl` restaurant names and coordinates for up to 24h after deploy.
  @cache({ttlSeconds: 86400, cacheVersion: 2})
  async getRestaurants(): Promise<AttractionPOI[]> {
    const resp = await this.fetchRestaurants();
    return await resp.json() || [];
  }

  @cache({ttlSeconds: 60})
  async getWaitTimes(): Promise<WaitTimeEntry[]> {
    const resp = await this.fetchWaitTimes();
    return await resp.json() || [];
  }

  // ── Entity Building ──────────────────────────────────────────

  async getDestinations(): Promise<Entity[]> {
    return [{
      id: this.destinationSlug,
      name: this.parkName,
      entityType: 'DESTINATION',
      timezone: this.timezone,
      location: {latitude: this.parkLat, longitude: this.parkLng},
    } as Entity];
  }

  protected async buildEntityList(): Promise<Entity[]> {
    const [attractions, restaurants] = await Promise.all([
      this.getAttractions(),
      this.getRestaurants(),
    ]);

    const parkEntity: Entity = {
      id: this.parkSlug,
      name: this.parkName,
      entityType: 'PARK',
      parentId: this.destinationSlug,
      destinationId: this.destinationSlug,
      timezone: this.timezone,
      location: {latitude: this.parkLat, longitude: this.parkLng},
    } as Entity;

    // A ride with a queue board is keyed on its wait-time id — those are live
    // wiki records and must not shift. Only rides that have one carry the
    // field, so the rest fall back to the CMS path, exactly as restaurants do.
    // A POI listed in PATH_KEYED_ATTRACTIONS gives up its shared wait-time id
    // and takes the same path fallback.
    const attrEntities = attractions
      .map(a => {
        const slug = this.pathSlug(a.path);
        const waitTimeId = slug !== null && PATH_KEYED_ATTRACTIONS.has(slug)
          ? null
          : a.waitingTimeName;
        const id = waitTimeId || (slug && `attr_${slug}`);
        if (!id) return null;

        const entity: Entity = {
          id,
          name: a.title,
          entityType: 'ATTRACTION',
          parentId: this.parkSlug,
          destinationId: this.destinationSlug,
          timezone: this.timezone,
        } as Entity;
        if (a.latitude && a.longitude) {
          (entity as any).location = {
            latitude: Number(a.latitude),
            longitude: Number(a.longitude),
          };
        }
        return entity;
      })
      .filter((e): e is Entity => e !== null);

    // Restaurants use CMS path slug as entity ID (no UUID available)
    const diningEntities = restaurants
      .filter(r => this.pathSlug(r.path))
      .map(r => {
        const entity: Entity = {
          id: `dining_${this.pathSlug(r.path)}`,
          name: r.title,
          entityType: 'RESTAURANT',
          parentId: this.parkSlug,
          destinationId: this.destinationSlug,
          timezone: this.timezone,
        } as Entity;
        if (r.latitude && r.longitude) {
          (entity as any).location = {
            latitude: Number(r.latitude),
            longitude: Number(r.longitude),
          };
        }
        return entity;
      });

    return [parkEntity, ...attrEntities, ...diningEntities];
  }

  // ── Live Data ────────────────────────────────────────────────

  protected async buildLiveData(): Promise<LiveData[]> {
    const [attractions, waitTimes] = await Promise.all([
      this.getAttractions(),
      this.getWaitTimes(),
    ]);

    const orphans: string[] = [];

    const live = waitTimes
      .map(entry => {
        // Match wait time entry to attraction via waitingTimeName
        const attraction = attractions.find(a => a.waitingTimeName === entry.id);
        if (!attraction) {
          if (!this.warnedOrphanWaitTimes.has(entry.id)) {
            this.warnedOrphanWaitTimes.add(entry.id);
            orphans.push(entry.id);
          }
          return null;
        }

        if (SKIP_STATUSES.has(entry.status)) return null;
        const status = mapStatus(entry.status);

        const ld: LiveData = {
          id: entry.id, // UUID from waitingTimeName — matches entity ID directly
          status,
        } as LiveData;

        if (status === 'OPERATING' && entry.time !== undefined) {
          const seconds = Number(entry.time || 0);
          ld.queue = {
            STANDBY: {waitTime: seconds > 0 ? Math.floor(seconds / 60) : 0},
          };
        }

        return ld;
      })
      .filter((x): x is LiveData => x !== null);

    this.warnOrphanWaitTimes(orphans);
    return live;
  }

  /**
   * A wait time whose id matches no attraction in any locale cannot be
   * published — we have no name for it. That used to happen silently.
   *
   * Most of these are permanent feed junk (Bellewaerde alone carries ~68
   * unmapped ids), so one line per id would bury a genuinely new CMS gap in a
   * wall of noise. Summarise instead: one line per poll listing only ids not
   * already reported, so the steady state is silent and a new gap is a short
   * line of its own.
   */
  private warnOrphanWaitTimes(ids: string[]): void {
    if (!ids.length) return;
    const locales = [...new Set([this.culture, ...this.mergeCultures])].join(', ');
    const shown = ids.slice(0, 10).join(', ');
    const rest = ids.length > 10 ? ` (+${ids.length - 10} more)` : '';
    console.warn(`[${this.constructor.name}] ${ids.length} wait time id(s) match no attraction in [${locales}] — not published: ${shown}${rest}`);
  }

  private readonly warnedOrphanWaitTimes = new Set<string>();

  // ── Schedules ────────────────────────────────────────────────

  /**
   * Read a day's `customOpeningHourToDisplay` override.
   *
   * The CMS holds two answers for a day's hours. `openingHour`/`closingHour`
   * carry the season default; `customOpeningHourToDisplay` is the per-day
   * override, and it is what the calendar widget on every page of the park
   * site renders. When the two disagree it is the structured pair that is
   * stale: on 28–31 August 2026 Walibi Belgium was still advertising a summer
   * `closingHour` of 20:00 while the override, the day's `events` asset
   * (`open-10-18h`) and that asset's own title all said 18:00.
   *
   * This is the same precedence the park's own calendar renderer applies —
   * `clientlib-shared` takes `customOpeningHourToDisplay` outright whenever it
   * is non-empty and only falls back to the structured pair when it is not.
   *
   * Parsed strictly as `HH:MM - HH:MM`, and only that. The field is free text
   * an editor types, and they do: Walibi Holland's 31 October row carries
   * "Early bird tickets uitverkocht - binnenkort komen de reguliere tickets
   * beschikbaar" in it. Anything that is not exactly two times returns null
   * and leaves the structured hours in place — a shape we half-understand is
   * worse than the season default we already publish.
   *
   * A window that does not move forwards is rejected for the same reason.
   * Both times are pinned to the same calendar date by the caller, so
   * "19:00 - 01:00" would publish a close eighteen hours before its own open.
   * An after-midnight close cannot be told apart from a transposed one
   * ("18:00 - 10:00") or a half-finished edit ("18:00 - 18:00") — this field
   * carries no next-day flag, unlike the explicit `closesNextDay` the
   * Universal and Fantawild night events hang their roll-over on. So we do
   * not guess: all three fall back.
   *
   * Bellewaerde, Walibi Holland and Walibi Rhône-Alpes send this field empty
   * on every open day, so today this only ever fires for Walibi Belgium.
   */
  private parseDisplayHours(value: unknown): {opening: string; closing: string} | null {
    if (typeof value !== 'string') return null;
    // Dash class covers the ASCII hyphen plus U+2010–U+2015 and the minus
    // sign: the CMS stores whatever the editor's keyboard or paste produced.
    const match = /^\s*(\d{1,2}):([0-5]\d)\s*[-‐-―−]\s*(\d{1,2}):([0-5]\d)\s*$/.exec(value);
    if (!match) return null;
    const [openHour, closeHour] = [Number(match[1]), Number(match[3])];
    if (openHour > 23 || closeHour > 23) return null;
    // Compare minutes-of-day, not hours: "10:30 - 10:15" runs backwards while
    // its hours are equal, and a bare hour compare would let it through.
    const openMins = openHour * 60 + Number(match[2]);
    const closeMins = closeHour * 60 + Number(match[4]);
    if (closeMins <= openMins) return null;
    return {
      opening: `${String(openHour).padStart(2, '0')}:${match[2]}`,
      closing: `${String(closeHour).padStart(2, '0')}:${match[4]}`,
    };
  }

  /**
   * Warn once per distinct unreadable override.
   *
   * The fallback path is silent by design, and it lands on `closingHour` —
   * the field this whole method exists because it goes stale. A new CMS
   * shape would therefore revert us to a known-suspect value with nothing to
   * show for it. One line per distinct string, mirroring
   * `warnOrphanWaitTimes`: steady state stays quiet.
   */
  private warnUnreadableDisplayHours(value: string): void {
    if (this.warnedDisplayHours.has(value)) return;
    this.warnedDisplayHours.add(value);
    console.warn(
      `[${this.constructor.name}] unreadable customOpeningHourToDisplay, using season default: ${JSON.stringify(value)}`,
    );
  }

  private readonly warnedDisplayHours = new Set<string>();

  protected async buildSchedules(): Promise<EntitySchedule[]> {
    let calData: any;
    try {
      const resp = await this.fetchCalendar();
      calData = await resp.json();
    } catch {
      return [];
    }

    if (!calData?.calendar) return [];

    const schedule: Array<{date: string; type: string; openingTime: string; closingTime: string}> = [];

    for (const year of Object.keys(calData.calendar)) {
      const yearData = calData.calendar[year];
      if (!yearData?.months) continue;

      for (const monthKey of Object.keys(yearData.months)) {
        const month = yearData.months[monthKey];
        const monthNum = month.monthNumber;
        if (!month.days) continue;

        for (const dayKey of Object.keys(month.days)) {
          const day = month.days[dayKey];
          if (day.closed || day.soldOut) continue;

          const dateStr = `${year}-${String(monthNum).padStart(2, '0')}-${String(dayKey).padStart(2, '0')}`;

          // Resolve the hours before testing them, so an override can carry a
          // day the structured pair has left empty. The override gives both
          // times, so it stands on its own.
          const raw = day.customOpeningHourToDisplay;
          const displayed = this.parseDisplayHours(raw);
          if (!displayed && typeof raw === 'string' && raw.trim() !== '') {
            this.warnUnreadableDisplayHours(raw);
          }
          const openingHour = displayed?.opening ?? day.openingHour;
          const closingHour = displayed?.closing ?? day.closingHour;
          if (!openingHour || !closingHour) continue;

          schedule.push({
            date: dateStr,
            type: 'OPERATING',
            openingTime: constructDateTime(dateStr, openingHour, this.timezone),
            closingTime: constructDateTime(dateStr, closingHour, this.timezone),
          });
        }
      }
    }

    return [{id: this.parkSlug, schedule} as EntitySchedule];
  }
}

// ── Park subclasses ────────────────────────────────────────────

@destinationController({category: ['Compagnie des Alpes', 'Walibi']})
export class WalibiHolland extends WalibiBase {
  constructor(options?: DestinationConstructor) {
    super(options);
    this.addConfigPrefix('WALIBIHOLLAND');
    this.baseURL = this.baseURL || 'https://www.walibi.nl/';
    this.apiShortcode = 'who';
    this.culture = 'en';
    this.destinationSlug = 'walibiholland';
    this.parkSlug = 'walibihollandpark';
    this.parkName = 'Walibi Holland';
    this.timezone = 'Europe/Amsterdam';
    this.parkLat = 52.44014;
    this.parkLng = 5.76749;
  }
}

@destinationController({category: ['Compagnie des Alpes', 'Bellewaerde']})
export class Bellewaerde extends WalibiBase {
  constructor(options?: DestinationConstructor) {
    super(options);
    this.addConfigPrefix('BELLEWAERDE');
    this.baseURL = this.baseURL || 'https://www.bellewaerde.be/';
    this.apiShortcode = 'blw';
    this.culture = 'nl';
    this.destinationSlug = 'bellewaerde';
    this.parkSlug = 'bellewaerdepark';
    this.parkName = 'Bellewaerde';
    this.timezone = 'Europe/Brussels';
    this.parkLat = 50.84647412354691;
    this.parkLng = 2.9502020602188184;
  }
}

@destinationController({category: ['Compagnie des Alpes', 'Walibi']})
export class WalibiRhoneAlpes extends WalibiBase {
  constructor(options?: DestinationConstructor) {
    super(options);
    this.addConfigPrefix('WALIBIRHONEALPES');
    this.baseURL = this.baseURL || 'https://www.walibi.fr/';
    this.apiShortcode = 'wra';
    this.culture = 'fr';
    this.destinationSlug = 'walibirhonealpes';
    this.parkSlug = 'walibirhonealpespark';
    this.parkName = 'Walibi Rhône-Alpes';
    this.timezone = 'Europe/Paris';
    this.parkLat = 45.620003;
    this.parkLng = 5.568677;
  }
}

@destinationController({category: ['Compagnie des Alpes', 'Walibi']})
export class WalibiBelgium extends WalibiBase {
  constructor(options?: DestinationConstructor) {
    super(options);
    this.addConfigPrefix('WALIBIBELGIUM');
    this.baseURL = this.baseURL || 'https://www.walibi.be/';
    this.apiShortcode = 'wbe';
    // Wavre is francophone and the `fr` feed is the better maintained one —
    // it is the only locale that lists VAMPIRE. Restaurant path slugs and
    // attraction waitingTimeNames are identical across locales, so this
    // changes display names only, not entity ids.
    this.culture = 'fr';
    this.destinationSlug = 'walibibelgium';
    this.parkSlug = 'walibibelgiumpark';
    this.parkName = 'Walibi Belgium';
    this.timezone = 'Europe/Brussels';
    this.parkLat = 50.701895;
    this.parkLng = 4.5914887;
  }
}

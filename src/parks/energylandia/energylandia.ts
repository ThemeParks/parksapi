/**
 * Energylandia — Zator, Poland
 *
 * Three unrelated backends, one park:
 *
 *  - Entities and schedules live in the park's Firebase project (Firestore),
 *    read over the REST API. The app authenticates anonymously, so we do the
 *    same: there are no credentials to hold, just the public web API key.
 *  - Wait times come from a separate, standalone host that is not part of
 *    Firebase at all. It serves a flat JSON array with Polish field names and
 *    is joined back onto Firestore attractions by `queueTimeId`.
 *  - Geo coordinates come from Proximiio, the mapping vendor behind the app's
 *    park map. Firestore carries no lat/lng at all — only a `proximiioId`
 *    pointing into Proximiio's feature set.
 *
 * @module energylandia
 */

import {Destination, type DestinationConstructor} from '../../destination.js';
import {cache, CacheLib} from '../../cache.js';
import {http, type HTTPObj} from '../../http.js';
import {inject} from '../../injector.js';
import config from '../../config.js';
import {destinationController} from '../../destinationRegistry.js';
import type {Entity, LiveData, EntitySchedule, LocalisedString} from '@themeparks/typelib';
import {constructDateTime} from '../../datetime.js';

const TOKEN_CACHE_KEY = 'energylandia:idToken';
const DESTINATION_ID = 'energylandia';
const PARK_ID = 'energylandia-park';

/**
 * Upper bound for a believable wait time, matching the existing bound in
 * `gentingskyworlds.ts`. This is a sanity guard against a garbage value, NOT a
 * plausibility filter: the feed genuinely publishes odd-but-real numbers (one
 * ride has been observed reporting 310, which the official app displays
 * verbatim as "310 min"), and silently suppressing those would misreport the
 * park while also hiding a real multi-hour queue on a busy day.
 */
const MAX_PLAUSIBLE_WAIT_MINUTES = 600;

/**
 * Coordinates for attractions whose `proximiioId` in Firestore points at a
 * feature that no longer exists.
 *
 * These three rides ARE mapped in Proximiio — the features were recreated with
 * new ids and the CMS was never repointed, so the stored id resolves to
 * nothing. The values below are the real published positions, read from those
 * live Proximiio features by title, not estimated or interpolated.
 *
 * Keyed by Firestore document id, which is stable and opaque, rather than by
 * name (which carries a catalogue number the park re-sequences) or by the
 * stale proximiioId (which is the broken thing).
 *
 * This is a fallback, consulted only when the Proximiio lookup misses, so it
 * disappears on its own the moment the park repoints the CMS. Revisit if it
 * ever grows past a handful of entries — a long list would mean the CMS
 * references have rotted generally and the join needs rethinking, not more
 * hardcoding.
 */
export const FALLBACK_LOCATIONS: Record<string, LatLng> = {
  // 220. Mini Track’ Tour Ride
  JqDuKAgRzSP54oRShbuv: {latitude: 49.999318, longitude: 19.402042},
  // 219. Candy Critters
  Z3eRroYWJQBqbiiyWwW7: {latitude: 49.999518, longitude: 19.402044},
  // 217. Candy Carousel
  rg9yNdn5nN3ziBBEWiIt: {latitude: 49.999481, longitude: 19.402669},
};

// ============================================================================
// Firestore REST value types
// ============================================================================

type FsValue = {
  stringValue?: string;
  integerValue?: string;
  doubleValue?: number;
  booleanValue?: boolean;
  nullValue?: null;
  arrayValue?: {values?: FsValue[]};
  mapValue?: {fields?: Record<string, FsValue>};
  timestampValue?: string;
};

type FsDoc = {
  name: string;
  fields?: Record<string, FsValue>;
};

/** One row of the standalone wait-time feed. Field names are Polish. */
type EnergylandiaWaitRow = {
  /** Queue counter id — joins to a Firestore attraction's `queueTimeId`. */
  ID_ATRAKCJI?: number | string;
  /** Operator-facing label, e.g. "141 PEPSI HYPERION". Not guest-facing. */
  ATRAKCJA?: string;
  /** Wait in whole minutes. */
  CZAS_OCZEKIWANIA?: number | string;
};

/** One entry of the `calendar/periods` document. */
type CalendarPeriod = {
  openFrom?: string;
  openTo?: string;
  days: string[];
};

/** A GeoJSON feature from Proximiio's `/geo/features` collection. */
type ProximiioFeature = {
  /** `"<organizationId>:<featureId>"` — matches Firestore's `proximiioId` verbatim. */
  id?: string;
  geometry?: {type?: string; coordinates?: unknown};
};

export type LatLng = {latitude: number; longitude: number};

// ============================================================================
// Pure helpers (exported so they are testable without a live backend)
// ============================================================================

export function fsString(v?: FsValue): string | undefined {
  return v?.stringValue;
}

export function fsBool(v?: FsValue): boolean | undefined {
  return v?.booleanValue;
}

/**
 * Read an identifier that Firestore may hold as either a string or an integer.
 *
 * `queueTimeId` is genuinely both in this collection — 39 attractions store it
 * as `integerValue` and 50 as `stringValue`, of which 47 are the empty string.
 * Reading only `stringValue` silently drops every numeric one, which are
 * precisely the attractions that carry a live queue counter, and the result
 * looks like a working park with almost no wait times rather than like a bug.
 *
 * The empty string is treated as absent, never coerced: `Number('')` is 0 and
 * would collide with the real counter id 0.
 */
export function fsId(v?: FsValue): string | undefined {
  if (v?.stringValue !== undefined) {
    const s = v.stringValue.trim();
    return s === '' ? undefined : s;
  }
  if (v?.integerValue !== undefined) {
    const s = String(v.integerValue).trim();
    return s === '' ? undefined : s;
  }
  if (v?.doubleValue !== undefined && Number.isFinite(v.doubleValue)) {
    return String(v.doubleValue);
  }
  return undefined;
}

/**
 * Decode a Firestore string map (`{PL: {stringValue}, EN: {…}}`) into a
 * LocalisedString.
 *
 * Energylandia keys languages in uppercase (PL, EN, DE, …) but
 * `getLocalizedString()` matches lowercase ISO codes, so keys are lowered here
 * — without this every lookup misses and falls through to whichever entry
 * happens to be first.
 */
export function fsLocalised(v?: FsValue): LocalisedString | undefined {
  const fields = v?.mapValue?.fields;
  if (!fields) return undefined;
  const out: Record<string, string> = {};
  for (const [lang, val] of Object.entries(fields)) {
    const s = val?.stringValue;
    if (typeof s === 'string' && s.trim()) out[lang.toLowerCase()] = s;
  }
  return Object.keys(out).length ? (out as LocalisedString) : undefined;
}

/**
 * Strip the park's leading catalogue number from a display name
 * ("35. Formuła Autodrom" → "Formuła Autodrom").
 *
 * The number is an internal ordering artifact that is already carried
 * separately in the document's `number` field, so keeping it in the name would
 * duplicate data and read badly downstream. Only a leading `<digits>.` is
 * removed, so a name that legitimately starts with a number and no dot (for
 * example a themed ride name) is left untouched.
 */
export function stripCatalogueNumber(name: string): string {
  return name.replace(/^\s*\d+\.\s*/, '').trim();
}

/**
 * Normalise a raw wait value into minutes, or undefined when it cannot be
 * trusted.
 *
 * `Number('')` is 0, so an empty string must be rejected before coercion or an
 * unreported wait becomes a fake walk-on — the coercion trap this repo bans
 * `isNaN()` over.
 */
export function parseWaitMinutes(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  if (n < 0 || n >= MAX_PLAUSIBLE_WAIT_MINUTES) return undefined;
  return n;
}

/**
 * Flatten `calendar/periods` into a date → hours map.
 *
 * Verified against the live document: across 242 dated days no date appears in
 * more than one period, so no precedence rule is needed and a later period
 * overwriting an earlier one is not a real case. Periods carrying no days are
 * unused CMS placeholders and are skipped, as are `00:00`–`00:00` entries,
 * which mark a closed period rather than a midnight-to-midnight opening.
 */
export function buildScheduleIndex(periods: CalendarPeriod[]): Map<string, {open: string; close: string}> {
  const index = new Map<string, {open: string; close: string}>();
  for (const period of periods) {
    const open = period.openFrom;
    const close = period.openTo;
    if (!open || !close) continue;
    if (open === '00:00' && close === '00:00') continue;
    for (const day of period.days || []) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(day)) index.set(day, {open, close});
    }
  }
  return index;
}

/**
 * Index Proximiio features by id, keeping only those that resolve to a single
 * point.
 *
 * The collection is mostly not attractions: of 1036 features, 625 are
 * LineStrings (the walking-path network used for wayfinding) and 3 are
 * Polygons. Only Point features carry a usable position, and a LineString's
 * `coordinates` is an array of pairs — reading `coordinates[0]`/`[1]` off one
 * would yield an array where a number is expected and silently produce a
 * garbage location rather than an error.
 *
 * GeoJSON orders coordinates `[longitude, latitude]`, which is the reverse of
 * how they are consumed downstream. Getting this backwards puts the park in
 * the Indian Ocean, so the mapping is explicit here rather than positional at
 * the call site.
 */
export function buildLocationIndex(features: ProximiioFeature[]): Map<string, LatLng> {
  const index = new Map<string, LatLng>();
  for (const feature of features) {
    if (!feature?.id) continue;
    if (feature.geometry?.type !== 'Point') continue;
    const coords = feature.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) continue;
    const [longitude, latitude] = coords;
    if (typeof latitude !== 'number' || typeof longitude !== 'number') continue;
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
    // Reject the null-island placeholder and out-of-range values outright;
    // an exactly-zero pair is far more likely to be missing data than a real
    // position, and this park is nowhere near it.
    if (latitude === 0 && longitude === 0) continue;
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) continue;
    index.set(feature.id, {latitude, longitude});
  }
  return index;
}

/**
 * Park-local `YYYY-MM-DD` and `HH:mm` for an instant, used to decide whether
 * the park is currently within its published operating window.
 */
export function parkLocalDateTime(now: Date, timezone: string): {date: string; time: string} {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  // Intl renders midnight as "24" in some ICU versions; normalise so string
  // comparison against an "HH:mm" window stays correct.
  const hour = get('hour') === '24' ? '00' : get('hour');
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${hour}:${get('minute')}`,
  };
}

/**
 * Is the park inside its published operating window right now?
 *
 * Returns undefined when the date is absent from the calendar, which is
 * different from "closed": an unpublished date is unknown, and the caller
 * should not manufacture a status from it.
 *
 * Windows that end before they start (a past-midnight close) are treated as
 * running into the next day. No such window exists in the current calendar —
 * the latest close is 23:00 — but a plain `open <= now <= close` comparison
 * would silently invert if the park ever added one.
 */
export function isWithinOperatingWindow(
  index: Map<string, {open: string; close: string}>,
  date: string,
  time: string,
): boolean | undefined {
  const today = index.get(date);
  if (!today) return undefined;
  if (today.close < today.open) return time >= today.open || time <= today.close;
  return time >= today.open && time <= today.close;
}

// ============================================================================
// Destination
// ============================================================================

@destinationController({category: 'Energylandia'})
export class Energylandia extends Destination {
  /** Firebase web API key (public by design — it identifies, it does not authorise). */
  @config apiKey: string = '';
  /** Firebase project id backing the park's CMS. */
  @config projectId: string = '';
  /**
   * Base URL of the standalone wait-time feed. Config-only and intentionally
   * absent from this repo: it is a bare host with no vendor branding, and
   * publishing it here would put it on the public record. With it unset the
   * park still emits entities and schedules, just no wait times.
   */
  @config waitTimesUrl: string = '';
  /** Base URL of the Proximiio API that backs the app's park map. */
  @config proximiioBaseUrl: string = '';
  /**
   * Proximiio application token. A static JWT with no `exp` claim — it
   * identifies the park's Proximiio application rather than a user, so there is
   * no refresh flow to implement. With it unset, entities are emitted without
   * coordinates rather than not at all.
   */
  @config proximiioToken: string = '';
  @config timezone: string = 'Europe/Warsaw';

  constructor(options?: DestinationConstructor) {
    super(options);
    this.addConfigPrefix('ENERGYLANDIA');
  }

  private get firestoreBase(): string {
    return `https://firestore.googleapis.com/v1/projects/${this.projectId}/databases/(default)/documents`;
  }

  private get identityBase(): string {
    return 'https://identitytoolkit.googleapis.com/v1/accounts';
  }

  // ==========================================================================
  // Authentication
  // ==========================================================================

  /**
   * Mint an anonymous Firebase account and return its id token.
   *
   * The app signs in anonymously, so there is no credential to configure and
   * nothing secret to hold. Cached for 50 minutes against the token's 1 hour
   * lifetime; each cache miss mints a fresh throwaway account, which is what
   * every first-launch install of the app does anyway.
   *
   * Throws rather than returning empty on failure — a thrown error is not
   * cached, so a transient outage costs one retry instead of locking the park
   * out for the full TTL.
   */
  @cache({ttlSeconds: 60 * 50, key: TOKEN_CACHE_KEY})
  async getIdToken(): Promise<string> {
    if (!this.apiKey) throw new Error('Energylandia requires an API key to be configured');

    const resp = await this.fetchAnonymousSignUp();
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data?.idToken) {
      throw new Error(`Energylandia auth failed: ${resp.status} ${JSON.stringify(data)}`);
    }
    return String(data.idToken);
  }

  @http({retries: 1})
  async fetchAnonymousSignUp(): Promise<HTTPObj> {
    return {
      method: 'POST',
      url: `${this.identityBase}:signUp?key=${this.apiKey}`,
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({returnSecureToken: true}),
      options: {json: false},
      tags: ['auth'],
    } as any as HTTPObj;
  }

  // ==========================================================================
  // Injectors
  // ==========================================================================

  @inject({
    eventName: 'httpRequest',
    hostname: 'firestore.googleapis.com',
    tags: {$nin: ['auth']},
    priority: 1,
  } as any)
  async injectAuthToken(req: HTTPObj): Promise<void> {
    const token = await this.getIdToken();
    req.headers = {...req.headers, 'authorization': `Bearer ${token}`};
  }

  /**
   * Drop a cached token the moment Firestore rejects it, so the next attempt
   * mints a new one instead of replaying a dead token for the rest of the TTL.
   */
  @inject({
    eventName: 'httpError',
    hostname: 'firestore.googleapis.com',
    tags: {$nin: ['auth']},
  } as any)
  async handleUnauthorized(req: HTTPObj): Promise<void> {
    const status = req.response?.status;
    if (status !== 401 && status !== 403) return;
    CacheLib.delete(TOKEN_CACHE_KEY);
    req.response = undefined as any;
  }

  // ==========================================================================
  // HTTP fetches
  // ==========================================================================

  @http({cacheSeconds: 300, retries: 2})
  async fetchCollectionPage(collection: string, pageToken: string | null): Promise<HTTPObj> {
    const params = new URLSearchParams({pageSize: '300'});
    if (pageToken) params.set('pageToken', pageToken);
    return {
      method: 'GET',
      url: `${this.firestoreBase}/${collection}?${params.toString()}`,
      options: {json: true},
    } as any as HTTPObj;
  }

  /**
   * Fetch the standalone wait-time feed.
   *
   * Cached 60s to match the app's own poll interval. The origin declares
   * `Content-Type: text/html` while serving JSON, so the body is read as text
   * and parsed explicitly rather than relying on content-type sniffing.
   */
  @http({cacheSeconds: 60, retries: 1})
  async fetchWaitTimes(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: this.waitTimesUrl,
      options: {json: false},
    } as any as HTTPObj;
  }

  // ==========================================================================
  // Cached readers
  // ==========================================================================

  /**
   * Read an entire Firestore collection, following `nextPageToken`.
   *
   * Pagination is not optional here: `attractions` exceeds the 300-document
   * page size, so a single-page read silently returns a truncated catalogue
   * that looks perfectly valid.
   */
  private async readCollection(collection: string): Promise<FsDoc[]> {
    const out: FsDoc[] = [];
    let pageToken: string | null = null;
    // Bounded rather than `while (true)`: a server that echoed a token back
    // unchanged would otherwise spin forever.
    for (let i = 0; i < 25; i++) {
      const resp: HTTPObj = await this.fetchCollectionPage(collection, pageToken);
      const data: any = await resp.json();
      if (Array.isArray(data?.documents)) out.push(...(data.documents as FsDoc[]));
      const next = data?.nextPageToken;
      if (!next || next === pageToken) break;
      pageToken = next;
    }
    return out;
  }

  @cache({ttlSeconds: 60 * 30})
  async getAttractionDocs(): Promise<FsDoc[]> {
    return this.readCollection('attractions');
  }

  /**
   * Fetch one page of Proximiio map features.
   *
   * Cached 12 hours: this is the park's physical layout, which changes when a
   * ride is built, not on any operational timescale.
   */
  @http({cacheSeconds: 60 * 60 * 12, retries: 2})
  async fetchProximiioFeatures(from: number, size: number): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.proximiioBaseUrl.replace(/\/+$/, '')}/v7/geo/features?from=${from}&size=${size}`,
      headers: {
        'authorization': `Bearer ${this.proximiioToken}`,
        'accept': 'application/json',
      },
      options: {json: true},
      tags: ['proximiio'],
    } as any as HTTPObj;
  }

  /**
   * Attraction coordinates, keyed by the same `"<org>:<feature>"` id Firestore
   * stores in `proximiioId`.
   *
   * Returns an empty map on any failure so a Proximiio outage costs
   * coordinates, never the whole entity list — locations are the one part of
   * an entity the wiki can survive without.
   */
  @cache({ttlSeconds: 60 * 60 * 12})
  async getLocationIndex(): Promise<Record<string, LatLng>> {
    if (!this.proximiioBaseUrl || !this.proximiioToken) return {};

    const size = 250;
    const features: ProximiioFeature[] = [];
    try {
      // ~1036 features today. Loop until a short page rather than trusting the
      // `record-total` header, so a change in total between pages cannot cause
      // a partial read that still looks complete.
      for (let page = 0; page < 20; page++) {
        const resp = await this.fetchProximiioFeatures(page * size, size);
        const data: any = await resp.json();
        const batch: ProximiioFeature[] = Array.isArray(data?.features) ? data.features : [];
        features.push(...batch);
        if (batch.length < size) break;
      }
    } catch (err: any) {
      console.warn(`[${this.constructor.name}] Proximiio unavailable: ${err?.message ?? err}`);
      return {};
    }

    // Returned as a plain object, not a Map: @cache round-trips through JSON
    // and a Map would deserialise as an empty object (see CLAUDE.md — cache
    // only JSON-safe types).
    return Object.fromEntries(buildLocationIndex(features));
  }

  @cache({ttlSeconds: 60 * 60 * 6})
  async getCalendarPeriods(): Promise<CalendarPeriod[]> {
    const docs = await this.readCollection('calendar');
    // The collection holds unrelated documents (a birthday-promotion map among
    // them); only `periods` carries operating hours.
    const doc = docs.find((d) => d.name.endsWith('/periods'));
    const values = doc?.fields?.periods?.arrayValue?.values || [];
    return values.map((entry) => {
      const f = entry?.mapValue?.fields || {};
      return {
        openFrom: fsString(f.openFrom),
        openTo: fsString(f.openTo),
        days: (f.days?.arrayValue?.values || [])
          .map((d) => d?.stringValue)
          .filter((d): d is string => typeof d === 'string'),
      };
    });
  }

  /**
   * Current wait times keyed by `queueTimeId`.
   *
   * Returns an empty map rather than throwing when the feed is unreachable, so
   * a wait-time outage degrades to status-only live data instead of taking the
   * whole park's emission down.
   */
  async getWaitTimes(): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!this.waitTimesUrl) return out;

    let rows: EnergylandiaWaitRow[];
    try {
      const resp = await this.fetchWaitTimes();
      const body = await resp.text();
      const parsed = JSON.parse(body);
      if (!Array.isArray(parsed)) return out;
      rows = parsed as EnergylandiaWaitRow[];
    } catch (err: any) {
      console.warn(`[${this.constructor.name}] wait-time feed unavailable: ${err?.message ?? err}`);
      return out;
    }

    for (const row of rows) {
      const id = row?.ID_ATRAKCJI;
      if (id === undefined || id === null || id === '') continue;
      const minutes = parseWaitMinutes(row.CZAS_OCZEKIWANIA);
      if (minutes === undefined) continue;
      out.set(String(id), minutes);
    }
    return out;
  }

  // ==========================================================================
  // Entities
  // ==========================================================================

  /**
   * Attractions the park currently publishes.
   *
   * `active` is the CMS's own visibility flag — the app queries
   * `where('active','==',true)` — and covers retired and unbuilt rides that are
   * still in the collection. `type` separates rides from the restaurants,
   * shops, games and shows sharing the collection; only rides are in scope.
   */
  private async getActiveAttractions(): Promise<FsDoc[]> {
    const docs = await this.getAttractionDocs();
    return docs.filter((d) => {
      const f = d.fields || {};
      return fsBool(f.active) === true && fsString(f.type) === 'attraction';
    });
  }

  async getDestinations(): Promise<Entity[]> {
    return [{
      id: DESTINATION_ID,
      name: 'Energylandia',
      entityType: 'DESTINATION',
      timezone: this.timezone,
      location: {latitude: 49.9906, longitude: 19.4136},
    } as Entity];
  }

  protected async buildEntityList(): Promise<Entity[]> {
    const [attractions, locations] = await Promise.all([
      this.getActiveAttractions(),
      this.getLocationIndex(),
    ]);

    const parkEntity: Entity = {
      id: PARK_ID,
      name: 'Energylandia',
      entityType: 'PARK',
      parentId: DESTINATION_ID,
      destinationId: DESTINATION_ID,
      timezone: this.timezone,
      location: {latitude: 49.9906, longitude: 19.4136},
    } as Entity;

    const rides: Entity[] = [];
    for (const doc of attractions) {
      const f = doc.fields || {};
      const localised = fsLocalised(f.name);
      if (!localised) continue;
      const name = stripCatalogueNumber(this.getLocalizedString(localised));
      if (!name) continue;

      // Prefer the live Proximiio position; fall back to a pinned coordinate
      // only when the stored proximiioId resolves to nothing, so a repointed
      // CMS silently takes over again. A ride with neither is still emitted —
      // it is real and still reports wait times, it just has no location.
      const docId = firestoreDocId(doc);
      const proximiioId = fsId(f.proximiioId);
      const location = (proximiioId ? locations[proximiioId] : undefined)
        ?? FALLBACK_LOCATIONS[docId];

      rides.push({
        id: entityIdFromDoc(doc),
        name,
        entityType: 'ATTRACTION',
        parentId: PARK_ID,
        destinationId: DESTINATION_ID,
        parkId: PARK_ID,
        timezone: this.timezone,
        location,
      } as Entity);
    }

    return [parkEntity, ...rides];
  }

  // ==========================================================================
  // Live data
  // ==========================================================================

  /**
   * Live status and wait times.
   *
   * Two independent signals are combined. `open` comes from Firestore and is
   * the park's own per-ride switch; the wait feed is a separate host keyed by
   * `queueTimeId`. A ride flagged closed is reported CLOSED with no queue even
   * if a stale number is still sitting in the feed, because the CMS flag is the
   * park's deliberate statement and the counter is just whatever the hardware
   * last reported.
   *
   * Attractions with no matching feed row are still emitted with a status —
   * that is how the ~26 operator-only counter rows in the feed (queue counters,
   * FAST-PASS lanes, spares) are excluded without needing a blocklist: they
   * have no Firestore attraction to attach to, and drop out of the join.
   */
  protected async buildLiveData(): Promise<LiveData[]> {
    const [attractions, waits, periods] = await Promise.all([
      this.getActiveAttractions(),
      this.getWaitTimes(),
      this.getCalendarPeriods(),
    ]);

    const {date, time} = parkLocalDateTime(new Date(), this.timezone);
    const parkOpen = isWithinOperatingWindow(buildScheduleIndex(periods), date, time);

    // The park's published hours are the only live open/closed signal it has.
    // Firestore's per-attraction `open` flag looks like one but is not: it
    // tracks `active` almost exactly (every active attraction is flagged open,
    // every inactive one closed), so it never changes over a day and trusting
    // it would report all 89 rides OPERATING at 3am and through the closed
    // season. An unpublished date returns undefined and is treated as open, so
    // a calendar gap degrades to the previous behaviour rather than blacking
    // out a park that is actually running.
    const outsideOperatingHours = parkOpen === false;

    const out: LiveData[] = [];
    for (const doc of attractions) {
      const f = doc.fields || {};
      const id = entityIdFromDoc(doc);

      if (outsideOperatingHours || fsBool(f.open) !== true) {
        out.push({id, status: 'CLOSED'} as LiveData);
        continue;
      }

      const queueTimeId = fsId(f.queueTimeId);
      const minutes = queueTimeId !== undefined ? waits.get(queueTimeId) : undefined;

      if (minutes === undefined) {
        // Open per the CMS but no usable counter reading: report OPERATING
        // without a queue rather than inventing a zero-minute wait.
        out.push({id, status: 'OPERATING'} as LiveData);
        continue;
      }

      out.push({
        id,
        status: 'OPERATING',
        queue: {STANDBY: {waitTime: minutes}},
      } as LiveData);
    }

    return out;
  }

  // ==========================================================================
  // Schedules
  // ==========================================================================

  protected async buildSchedules(): Promise<EntitySchedule[]> {
    const periods = await this.getCalendarPeriods();
    const index = buildScheduleIndex(periods);

    const schedule = [...index.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, hours]) => ({
        date,
        type: 'OPERATING',
        openingTime: constructDateTime(date, hours.open, this.timezone),
        closingTime: constructDateTime(date, hours.close, this.timezone),
      }));

    return [{id: PARK_ID, schedule} as EntitySchedule];
  }
}

/** The document id portion of a Firestore document path. */
function firestoreDocId(doc: FsDoc): string {
  return doc.name.split('/').pop() || doc.name;
}

/** Stable entity id derived from the Firestore document path. */
function entityIdFromDoc(doc: FsDoc): string {
  return `${DESTINATION_ID}-${firestoreDocId(doc)}`;
}

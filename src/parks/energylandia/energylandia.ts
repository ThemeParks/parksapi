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
 *  - Showtimes come from a `shows` collection of their own, keyed by weekday
 *    rather than by date, so they are a recurring pattern that has to be read
 *    against the operating calendar rather than published as-is.
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
import type {Entity, LiveData, EntitySchedule, LocalisedString, LiveTimeSlot} from '@themeparks/typelib';
import {constructDateTime, addMinutes} from '../../datetime.js';

const TOKEN_CACHE_KEY = 'energylandia:idToken';
/**
 * Where the long-lived Firebase refresh token lives. Kept apart from the id
 * token so a 401 can drop the short-lived credential without discarding the
 * identity and forcing a brand new anonymous account to be minted.
 */
const REFRESH_TOKEN_CACHE_KEY = 'energylandia:refreshToken';
/** Firebase refresh tokens do not expire on a schedule; renew monthly. */
const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;
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

/**
 * One performance in a show's weekly timetable.
 *
 * `venueId` is the Firestore id of the attraction the show plays at, and is
 * genuinely optional: 63 of 259 published slots omit the field entirely. Those
 * are not broken references — every one of them still names its venue in
 * `place`, so the venue is always known even when the link to its document is
 * not. Treat a missing `venueId` as "not linked", never as "no venue".
 */
type ShowSlot = {
  /** `HH:mm`, park-local. */
  time: string;
  venueId?: string;
  place?: LocalisedString;
};

/** Weekday keys exactly as the CMS spells them in a `timetable` map. */
export const WEEKDAYS = [
  'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
] as const;

export type Weekday = typeof WEEKDAYS[number];

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
  let n: number;
  if (typeof raw === 'number') {
    n = raw;
  } else if (typeof raw === 'string') {
    // Trim before the emptiness test: the feed pads values, and Number(' ')
    // is 0 just as Number('') is, so an unpadded check lets whitespace become
    // a fabricated zero-minute walk-on.
    const t = raw.trim();
    if (t === '') return undefined;
    n = Number(t);
  } else {
    // Booleans, arrays and objects all coerce through Number() to something
    // finite (Number(false) and Number([]) are both 0), so reject by type
    // rather than letting them reach the range check.
    return undefined;
  }
  if (!Number.isFinite(n)) return undefined;
  // Wait times are whole minutes; a fraction means the feed changed shape.
  if (!Number.isInteger(n)) return undefined;
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
 * The park-local weekday for an instant, as the CMS spells it.
 *
 * Separate from `parkLocalDateTime` rather than folded into it: that function's
 * exact `{date, time}` shape is asserted by its tests, and a show timetable is
 * keyed by weekday alone. Derived from the same timezone rather than from
 * `Date.getDay()`, which would read the collector host's day and put the park on
 * the wrong timetable for the hours either side of local midnight.
 */
export function parkLocalWeekday(now: Date, timezone: string): Weekday {
  const name = new Intl.DateTimeFormat('en-US', {timeZone: timezone, weekday: 'long'})
    .format(now)
    .toLowerCase();
  // en-US 'long' weekdays are exactly the CMS's keys; assert rather than assume,
  // so an ICU change surfaces here instead of silently emptying every timetable.
  if (!(WEEKDAYS as readonly string[]).includes(name)) {
    throw new Error(`Unrecognised weekday '${name}' for timezone ${timezone}`);
  }
  return name as Weekday;
}

/**
 * Read one weekday's performances out of a show's `timetable` map.
 *
 * Slots are sorted by time. The CMS stores them in entry order, which is not
 * chronological — one observed show lists 16:30 before 13:30 — and an unsorted
 * list makes "the day's last performance" the wrong entry, which is what decides
 * whether the show still counts as running.
 *
 * A slot with no usable `HH:mm` is dropped rather than repaired: every one of
 * the 259 published slots parses today, so a malformed time means the shape
 * changed and guessing at it would publish a performance that does not happen.
 *
 * The time is range-checked, not merely shape-checked. `\d{2}:\d{2}` accepts
 * "25:99", which `constructDateTime` would then resolve by rolling over into
 * the following day — publishing a performance at an hour the park never
 * stated, on a date it was never scheduled.
 */
export function parseShowSlots(timetable: FsValue | undefined, weekday: Weekday): ShowSlot[] {
  const values = timetable?.mapValue?.fields?.[weekday]?.arrayValue?.values || [];
  const slots: ShowSlot[] = [];
  for (const entry of values) {
    const f = entry?.mapValue?.fields || {};
    const time = fsString(f.time)?.trim();
    if (!time || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) continue;
    slots.push({
      time,
      venueId: fsId(f.attractionId),
      place: fsLocalised(f.place),
    });
  }
  return slots.sort((a, b) => a.time.localeCompare(b.time));
}

/**
 * A show's stated running time in minutes, or undefined when it is unusable.
 *
 * The CMS holds this as a string ("15", "20", "120"). Rejected outright rather
 * than coerced when empty, because `Number('')` is 0 and a zero-length
 * performance would collapse every end time onto its start.
 */
export function parseDurationMinutes(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const t = raw.trim();
  if (t === '') return undefined;
  const n = Number(t);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return undefined;
  // A show running over 12 hours is a data error, not a show.
  if (n <= 0 || n > 12 * 60) return undefined;
  return n;
}

/**
 * Turn one weekday's slots into showtimes for a specific date.
 *
 * The feed never populates `timeEnd` — all 259 slots hold an explicit null — so
 * the end time is derived from the show's own stated `duration`. That is the
 * park's own number, not an assumption about how long a show runs; when it is
 * missing or unusable the end time is left null rather than invented.
 *
 * The end is rendered back through the same `constructDateTime` the start uses,
 * rather than taken straight off the shifted Date. Emitting `.toISOString()`
 * there is correct to the instant but writes it as UTC, so a single showtime
 * would carry `…T12:45:00+02:00` alongside `…T11:00:00.000Z` — two formats for
 * one pair of timestamps. Round-tripping through the park's local clock also
 * makes a performance that runs past midnight land on the next date, and keeps
 * a DST boundary handled by the same code that handles it for the start.
 */
export function buildShowtimes(
  slots: ShowSlot[],
  date: string,
  timezone: string,
  durationMinutes?: number,
): LiveTimeSlot[] {
  return slots.map((slot) => {
    const startTime = constructDateTime(date, slot.time, timezone);
    let endTime: string | null = null;
    if (durationMinutes !== undefined) {
      const end = addMinutes(new Date(startTime), durationMinutes);
      const local = parkLocalDateTime(end, timezone);
      endTime = constructDateTime(local.date, local.time, timezone);
    }
    return {type: 'PERFORMANCE_TIME', startTime, endTime};
  });
}

/**
 * A show is OPERATING while it still has a performance to come or one running,
 * and CLOSED once the day's last has finished.
 *
 * Reporting a show OPERATING all day would keep the evening's final parade
 * listed as running at closing time. A slot with no end time falls back to its
 * start, so a show without a stated duration goes CLOSED the moment its last
 * performance begins rather than lingering for ever.
 */
export function showStatusFromShowtimes(
  showtimes: LiveTimeSlot[],
  nowMs: number,
): 'OPERATING' | 'CLOSED' {
  return showtimes.some((slot) => {
    const start = slot.startTime ? new Date(slot.startTime).getTime() : NaN;
    if (!Number.isFinite(start)) return false;
    const end = slot.endTime ? new Date(slot.endTime).getTime() : start;
    return (Number.isFinite(end) ? end : start) >= nowMs;
  }) ? 'OPERATING' : 'CLOSED';
}

/**
 * The single venue a show plays at across its whole week, or undefined when it
 * moves between venues.
 *
 * Twelve of the thirteen published shows sit at exactly one venue all week; the
 * exception ("Meeting with Mascots") rotates between three. Pinning a location
 * on a show that moves would put it at whichever venue happened to be listed
 * first, so a roaming show is left without one.
 *
 * Slots that omit `venueId` are ignored rather than treated as disagreement:
 * the field is simply absent on 63 slots whose `place` still names the same
 * venue as their siblings, so counting them as "different" would strip the
 * location from shows that never move.
 */
export function resolveShowVenueId(slots: ShowSlot[]): string | undefined {
  const venues = new Set<string>();
  for (const slot of slots) {
    if (slot.venueId) venues.add(slot.venueId);
  }
  return venues.size === 1 ? [...venues][0] : undefined;
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

  private get secureTokenBase(): string {
    return 'https://securetoken.googleapis.com/v1';
  }

  // ==========================================================================
  // Authentication
  // ==========================================================================

  /**
   * A Firebase id token for the park's project, valid ~1 hour.
   *
   * The app signs in anonymously, so there is no credential to configure and
   * nothing secret to hold. But anonymous sign-up MINTS A PERMANENT ACCOUNT in
   * the park's Firebase project, so treating it as the renewal mechanism is
   * abusive: at a 50 minute TTL that is ~29 accounts per day per collector
   * host, ~10k a year, accumulating for ever in a third party's user list and
   * billable to them as monthly active users. An app install mints one account
   * and then *refreshes* it; this now does the same.
   *
   * The refresh token is long-lived and is cached separately for 30 days, so
   * steady state is one account per host that renews itself. A fresh account is
   * minted only when there is no usable refresh token — first run, or after the
   * park revokes it.
   *
   * Throws rather than returning empty on failure — a thrown error is not
   * cached, so a transient outage costs one retry instead of locking the park
   * out for the full TTL.
   */
  @cache({ttlSeconds: 60 * 50, key: TOKEN_CACHE_KEY})
  async getIdToken(): Promise<string> {
    if (!this.apiKey) throw new Error('Energylandia requires an API key to be configured');

    // Renew the existing identity when we can.
    const refreshToken = CacheLib.get(REFRESH_TOKEN_CACHE_KEY) as string | undefined;
    if (refreshToken) {
      try {
        const resp = await this.fetchTokenRefresh(String(refreshToken));
        const data = await resp.json().catch(() => ({}));
        const idToken = data?.id_token;
        if (idToken) {
          // Firebase may hand back a rotated refresh token; keep whichever is
          // current or the next renewal falls back to minting an account.
          if (data.refresh_token) {
            CacheLib.set(REFRESH_TOKEN_CACHE_KEY, String(data.refresh_token), REFRESH_TOKEN_TTL_SECONDS);
          }
          return String(idToken);
        }
      } catch (err: any) {
        // A revoked or expired refresh token is expected eventually; fall
        // through and mint once rather than failing the whole poll.
        console.warn(`[${this.constructor.name}] token refresh failed, signing up again: ${err?.message ?? err}`);
      }
      CacheLib.delete(REFRESH_TOKEN_CACHE_KEY);
    }

    const data = await this.signUpAnonymously();
    if (data.refreshToken) {
      CacheLib.set(REFRESH_TOKEN_CACHE_KEY, String(data.refreshToken), REFRESH_TOKEN_TTL_SECONDS);
    }
    return String(data.idToken);
  }

  /**
   * Mint a new anonymous account. Deliberately separate from `getIdToken` so
   * the one call that creates state is easy to find and to count.
   */
  private async signUpAnonymously(): Promise<{idToken: string; refreshToken?: string}> {
    let data: any;
    try {
      const resp = await this.fetchAnonymousSignUp();
      data = await resp.json().catch(() => ({}));
    } catch (err: any) {
      // makeRequest rejects on a non-2xx, so the Identity Toolkit error code
      // (ADMIN_ONLY_OPERATION, OPERATION_NOT_ALLOWED, TOO_MANY_ATTEMPTS…) only
      // reaches us via the rejection. Surface it — it is the difference
      // between "retry later" and "anonymous auth has been switched off".
      throw new Error(`Energylandia anonymous sign-up failed: ${err?.message ?? err}`);
    }
    if (!data?.idToken) {
      throw new Error(`Energylandia anonymous sign-up returned no idToken: ${JSON.stringify(data)}`);
    }
    return data;
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

  /** Exchange a refresh token for a fresh id token, creating no new account. */
  @http({retries: 1})
  async fetchTokenRefresh(refreshToken: string): Promise<HTTPObj> {
    return {
      method: 'POST',
      url: `${this.secureTokenBase}/token?key=${this.apiKey}`,
      headers: {'content-type': 'application/x-www-form-urlencoded'},
      body: new URLSearchParams({grant_type: 'refresh_token', refresh_token: refreshToken}).toString(),
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
   * Drop a cached id token the moment Firestore says it is stale, so the next
   * attempt renews instead of replaying a dead token for the rest of the TTL.
   *
   * ONLY 401. A 403 is a permission verdict — a security rule denying the read,
   * or anonymous auth switched off — and no amount of re-authenticating fixes
   * it. Treating it as staleness was actively harmful: clearing `req.response`
   * makes http.ts compute the request as retryable, so every retry re-entered
   * injectAuthToken on a now-empty cache and, before this park kept a refresh
   * token, minted a fresh anonymous account each time. A permanent 403 turned
   * into thousands of sign-ups a day against the park's Firebase project.
   *
   * The refresh token is deliberately left in place: the identity is fine, it
   * is the one-hour credential that expired.
   */
  @inject({
    eventName: 'httpError',
    hostname: 'firestore.googleapis.com',
    tags: {$nin: ['auth']},
  } as any)
  async handleUnauthorized(req: HTTPObj): Promise<void> {
    if (req.response?.status !== 401) return;
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

    // Firestore answers 200 with `{}` both for a genuinely empty collection and
    // for one that does not exist, so zero documents is indistinguishable from
    // a renamed collection, a wrong project id, or a security rule that now
    // denies the read. None of those are survivable states for a park whose
    // entire catalogue and calendar live here, and the failure is silent: the
    // result caches, `buildEntityList` emits only DESTINATION and PARK, and
    // `buildSchedules` wipes the published operating hours — all from a
    // perfectly healthy-looking 200.
    //
    // Throwing means the poll emits nothing and the previous data ages
    // honestly, which is the correct trade when the alternative is deleting a
    // live park from a public API. A thrown error is never cached, so recovery
    // is automatic on the next poll.
    if (out.length === 0) {
      throw new Error(
        `Energylandia Firestore collection '${collection}' returned no documents — ` +
        `refusing to publish an empty catalogue (renamed collection, wrong project, or denied read?)`,
      );
    }

    return out;
  }

  @cache({ttlSeconds: 60 * 30})
  async getAttractionDocs(): Promise<FsDoc[]> {
    return this.readCollection('attractions');
  }

  /**
   * The `shows` collection, which is where performances live — NOT the handful
   * of `type: 'show'` documents in `attractions`, which are the theatres and
   * amphitheatres the performances play in.
   */
  @cache({ttlSeconds: 60 * 30})
  async getShowDocs(): Promise<FsDoc[]> {
    return this.readCollection('shows');
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
   * THROWS on failure, deliberately. This method is `@cache`d, and a cache
   * stores whatever the function *resolves* to — so catching in here and
   * returning `{}` would write an empty index under a 12 hour TTL, stripping
   * coordinates from every attraction for half a day, across process restarts
   * and every other collector host, because of one transient Proximiio blip.
   * A thrown error is never cached, so the next poll simply retries. The
   * caller is responsible for tolerating the throw — see `getLocationIndexSafe`
   * and the same split in `flamingoland.ts`, where the `.catch` lives at the
   * call site for exactly this reason.
   */
  @cache({ttlSeconds: 60 * 60 * 12})
  async getLocationIndex(): Promise<Record<string, LatLng>> {
    const size = 250;
    const features: ProximiioFeature[] = [];
    // ~1036 features today. Loop until a short page rather than trusting the
    // `record-total` header, so a change in total between pages cannot cause
    // a partial read that still looks complete.
    for (let page = 0; page < 20; page++) {
      const resp = await this.fetchProximiioFeatures(page * size, size);
      const data: any = await resp.json();
      // A 200 whose body has no `features` array is a shape change or an error
      // page, not an empty page. Breaking on it would cache a truncated index
      // as though it were the whole park, so fail loudly instead.
      if (!Array.isArray(data?.features)) {
        throw new Error(`Proximiio page ${page} returned no features array`);
      }
      features.push(...data.features);
      if (data.features.length < size) break;
    }

    // Returned as a plain object, not a Map: @cache round-trips through JSON
    // and a Map would deserialise as an empty object (see CLAUDE.md — cache
    // only JSON-safe types).
    return Object.fromEntries(buildLocationIndex(features));
  }

  /**
   * `getLocationIndex` with the failure absorbed, for callers that would rather
   * publish an attraction without a location than not publish it at all.
   *
   * The catch lives here rather than inside the cached method so the empty
   * result is never persisted — see the note on `getLocationIndex`.
   */
  async getLocationIndexSafe(): Promise<Record<string, LatLng>> {
    if (!this.proximiioBaseUrl || !this.proximiioToken) return {};
    try {
      return await this.getLocationIndex();
    } catch (err: any) {
      console.warn(`[${this.constructor.name}] Proximiio unavailable: ${err?.message ?? err}`);
      return {};
    }
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
      // Normalise identically to fsId(), which trims the Firestore side —
      // otherwise a padded feed id never matches its attraction and the wait
      // is silently dropped.
      const id = row?.ID_ATRAKCJI === undefined || row?.ID_ATRAKCJI === null
        ? undefined
        : String(row.ID_ATRAKCJI).trim();
      if (!id) continue;
      const minutes = parseWaitMinutes(row.CZAS_OCZEKIWANIA);
      if (minutes === undefined) continue;
      out.set(id, minutes);
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
    return this.getActiveDocsOfType('attraction');
  }

  /**
   * Documents in `attractions` the park currently publishes, of one `type`.
   *
   * The collection mixes rides, restaurants, shops, games, show venues and
   * unlabelled service points (park entrances, the map pin), so `type` is what
   * separates them. 316 documents today, of which 89 are rides and 72 are
   * restaurants.
   */
  private async getActiveDocsOfType(type: string): Promise<FsDoc[]> {
    const docs = await this.getAttractionDocs();
    return docs.filter((d) => {
      const f = d.fields || {};
      return fsBool(f.active) === true && fsString(f.type) === type;
    });
  }

  /**
   * Shows the park currently publishes: 13 of the 157 documents in the
   * collection. The other 144 are retired or unbuilt and carry `active: false`,
   * exactly as with attractions.
   */
  private async getActiveShows(): Promise<FsDoc[]> {
    const docs = await this.getShowDocs();
    return docs.filter((d) => fsBool(d.fields?.active) === true);
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

  /**
   * Where a document sits, preferring the live Proximiio position and falling
   * back to a pinned coordinate only when the stored `proximiioId` resolves to
   * nothing, so a repointed CMS silently takes over again.
   */
  private locationForDoc(
    doc: FsDoc,
    locations: Record<string, LatLng>,
  ): LatLng | undefined {
    const proximiioId = fsId(doc.fields?.proximiioId);
    return (proximiioId ? locations[proximiioId] : undefined)
      ?? FALLBACK_LOCATIONS[firestoreDocId(doc)];
  }

  protected async buildEntityList(): Promise<Entity[]> {
    const [attractions, restaurants, shows, locations] = await Promise.all([
      this.getActiveAttractions(),
      this.getActiveDocsOfType('restaurant'),
      this.getActiveShows(),
      this.getLocationIndexSafe(),
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

    /** The display name a document should carry, or undefined if it has none. */
    const nameFor = (doc: FsDoc): string | undefined => {
      const localised = fsLocalised(doc.fields?.name);
      if (!localised) return undefined;
      return stripCatalogueNumber(this.getLocalizedString(localised)) || undefined;
    };

    const rides: Entity[] = [];
    for (const doc of attractions) {
      const name = nameFor(doc);
      if (!name) continue;

      // A ride with no location is still emitted — it is real and still reports
      // wait times, it just has no coordinates.
      rides.push({
        id: entityIdFromDoc(doc),
        name,
        entityType: 'ATTRACTION',
        parentId: PARK_ID,
        destinationId: DESTINATION_ID,
        parkId: PARK_ID,
        timezone: this.timezone,
        location: this.locationForDoc(doc, locations),
      } as Entity);
    }

    const dining: Entity[] = [];
    for (const doc of restaurants) {
      const name = nameFor(doc);
      if (!name) continue;
      dining.push({
        id: entityIdFromDoc(doc),
        name,
        entityType: 'RESTAURANT',
        parentId: PARK_ID,
        destinationId: DESTINATION_ID,
        parkId: PARK_ID,
        timezone: this.timezone,
        location: this.locationForDoc(doc, locations),
      } as Entity);
    }

    // Shows are located via the venue they play at, since a show document has no
    // proximiioId of its own — only the theatre it runs in does. A show that
    // moves between venues during the week gets no location rather than an
    // arbitrary one; see resolveShowVenueId.
    const attractionsById = new Map(
      (await this.getAttractionDocs()).map((doc) => [firestoreDocId(doc), doc]),
    );
    const performances: Entity[] = [];
    for (const doc of shows) {
      const name = nameFor(doc);
      if (!name) continue;

      const weeklySlots = WEEKDAYS.flatMap((day) => parseShowSlots(doc.fields?.timetable, day));
      const venueId = resolveShowVenueId(weeklySlots);
      const venueDoc = venueId ? attractionsById.get(venueId) : undefined;

      performances.push({
        id: showEntityIdFromDoc(doc),
        name,
        entityType: 'SHOW',
        parentId: PARK_ID,
        destinationId: DESTINATION_ID,
        parkId: PARK_ID,
        timezone: this.timezone,
        location: venueDoc ? this.locationForDoc(venueDoc, locations) : undefined,
      } as Entity);
    }

    return [parkEntity, ...rides, ...dining, ...performances];
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
    const [attractions, shows, waits, periods] = await Promise.all([
      this.getActiveAttractions(),
      this.getActiveShows(),
      this.getWaitTimes(),
      this.getCalendarPeriods(),
    ]);

    const now = new Date();
    const {date, time} = parkLocalDateTime(now, this.timezone);
    const schedule = buildScheduleIndex(periods);
    const parkOpen = isWithinOperatingWindow(schedule, date, time);

    // The park's published hours are the only live open/closed signal it has.
    // Firestore's per-attraction `open` flag looks like one but is not: it
    // tracks `active` almost exactly (every active attraction is flagged open,
    // every inactive one closed), so it never changes over a day and trusting
    // it would report all 89 rides OPERATING at 3am and through the closed
    // season.
    //
    // An unpublished date means CLOSED, not unknown. The calendar is sparse on
    // purpose: it lists only the days the park operates, so of the 242 dated
    // days spanning 2026-01-02..2027-01-31 there are 153 gaps, and those gaps
    // ARE the closed season and the midweek closures. Reading a gap as "open"
    // published all 89 rides as OPERATING at 3am on Christmas Day.
    //
    // The one case that must not be read as closed is an EMPTY calendar, which
    // is a source failure (renamed collection, wrong project, a 200 with no
    // documents) rather than a statement about any particular day. Blacking out
    // a running park on a Firestore glitch is worse than briefly over-reporting
    // it as open, so that degrades to open and is logged.
    let outsideOperatingHours: boolean;
    if (schedule.size === 0) {
      console.warn(
        `[${this.constructor.name}] operating calendar is empty — treating the park as open ` +
        `rather than closing every attraction on what is probably a source failure`,
      );
      outsideOperatingHours = false;
    } else {
      outsideOperatingHours = parkOpen !== true;
    }

    // A wait-feed outage is otherwise invisible: every ride still gets an
    // OPERATING row, the write still lands, and `lastUpdated` still moves, so
    // a staleness dashboard sees a perfectly healthy park publishing no queue
    // times at all. The host is genuinely slow — an 11-second response was
    // observed in normal operation — so this is a real state, not a
    // hypothetical. Say so once per build rather than failing the emission.
    if (!outsideOperatingHours && this.waitTimesUrl && waits.size === 0) {
      console.warn(
        `[${this.constructor.name}] park is within operating hours but the wait-time feed ` +
        `returned no usable rows — publishing status without queue times`,
      );
    }

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

    out.push(...this.buildShowLiveData(shows, date, now, outsideOperatingHours));

    return out;
  }

  /**
   * Today's performances for each published show.
   *
   * The timetable is keyed by WEEKDAY, not by date — it is a recurring weekly
   * pattern with no notion of the calendar. On its own it would happily publish
   * Saturday's parade on a Saturday in the closed season, so it is gated on the
   * operating calendar exactly as wait times are: outside published hours a show
   * is CLOSED and emits no times at all, rather than advertising performances
   * for a day the park is shut.
   *
   * A show with no slots for today is CLOSED with an empty timetable rather than
   * omitted, so a show that runs only at weekends still reports honestly on a
   * Tuesday instead of vanishing from the feed.
   */
  private buildShowLiveData(
    shows: FsDoc[],
    date: string,
    now: Date,
    outsideOperatingHours: boolean,
  ): LiveData[] {
    const weekday = parkLocalWeekday(now, this.timezone);
    const nowMs = now.getTime();
    const out: LiveData[] = [];

    for (const doc of shows) {
      const id = showEntityIdFromDoc(doc);

      if (outsideOperatingHours) {
        out.push({id, status: 'CLOSED'} as LiveData);
        continue;
      }

      const slots = parseShowSlots(doc.fields?.timetable, weekday);
      if (slots.length === 0) {
        out.push({id, status: 'CLOSED'} as LiveData);
        continue;
      }

      const duration = parseDurationMinutes(fsString(doc.fields?.duration));
      const showtimes = buildShowtimes(slots, date, this.timezone, duration);

      out.push({
        id,
        status: showStatusFromShowtimes(showtimes, nowMs),
        showtimes,
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

/**
 * Stable entity id for a show.
 *
 * Namespaced by collection because a Firestore document id is only unique
 * *within* its collection: `shows/abc` and `attractions/abc` are different
 * documents, and an unprefixed id would let a show silently overwrite a ride.
 * Attractions keep their existing unprefixed ids, which are already published.
 */
function showEntityIdFromDoc(doc: FsDoc): string {
  return `${DESTINATION_ID}-show-${firestoreDocId(doc)}`;
}

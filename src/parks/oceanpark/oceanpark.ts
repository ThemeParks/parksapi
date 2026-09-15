/**
 * Ocean Park Hong Kong
 *
 * The official mobile app (and its API at sop.oceanpark.com.hk) was suspended
 * along with the app itself — every endpoint now returns a permanent 502 from
 * Ocean Park's own gateway. All data is instead scraped from the public website
 * (www.oceanpark.com.hk), which server-renders attraction/dining data —
 * including live wait times — as an embedded React Server Component (RSC) JSON
 * payload. No auth, no token, same page anyone gets in a browser.
 *
 * Entity IDs changed as a result: the app's numeric IDs don't exist in the
 * website's data at all, so entities are keyed on the website's own stable
 * identifiers (CMS node UUIDs for attractions, URL slugs elsewhere).
 *
 * Coordinate data: unchanged — map.oceanpark.com.hk still exposes pixel
 * positions via reference_points.json + per-category JSON files. Each map
 * entry now carries a `url` field pointing at the canonical website page, so
 * entities are joined to coordinates by URL slug instead of the old numeric
 * extEntityCode.
 *
 * Known gaps vs. the old app-based implementation (the website simply doesn't
 * expose these): FastPass/paid-return-time flags, pregnancy/wet-ride warnings,
 * and per-attraction "Summit closes early" special hours. Shopping and food
 * kiosk locations are also left out — no entity-type precedent for them and
 * the site gives them no numeric ID or UUID, only a title.
 *
 * Scraping resilience: this is a screen-scrape of a third-party site that can
 * change structure without notice, so every extraction point is defensive —
 * malformed individual items are dropped (and logged) rather than crashing
 * the whole build, and independent upstream sources (attractions, dining,
 * shows, schedule, coordinates) each fail in isolation so one flaky endpoint
 * degrades rather than zeroes out the destination's output.
 *
 * WAF: www.oceanpark.com.hk (attractions page, dining page, and both
 * /api/main/* schedule routes) 403s every request with no/generic
 * User-Agent, serving a "System Maintenance" page instead of the real SSR
 * content — Node's http client sends no default UA. That 403 propagates
 * through getAttractionItems()/getDailyScheduleItems() as a rejected
 * promise, which buildEntityList/buildLiveData's per-source .catch()
 * quietly downgrades to "no attractions/shows this cycle" — so without a
 * browser-like UA this destination silently reports zero attractions and
 * zero shows on every single sync, not just an occasional flaky one.
 * map.oceanpark.com.hk (coordinates) isn't behind the same WAF and works
 * with no UA at all. See Nigloland for the same pattern.
 */

import {Destination, DestinationConstructor} from '../../destination.js';
import config from '../../config.js';
import {cache} from '../../cache.js';
import {http, HTTPObj} from '../../http.js';
import {inject} from '../../injector.js';
import {destinationController} from '../../destinationRegistry.js';
import {formatDate, constructDateTime, hostnameFromUrl} from '../../datetime.js';
import {TagBuilder} from '../../tags/index.js';
import type {Entity, LiveData, EntitySchedule, ScheduleEntry} from '@themeparks/typelib';
import {AttractionTypeEnum} from '@themeparks/typelib';

// ── Constants ───────────────────────────────────────────────────────────────

const TIMEZONE = 'Asia/Hong_Kong';
const DESTINATION_ID = 'oceanparkresort';
const PARK_ID = 'oceanpark';
const DEFAULT_LAT = 22.2465;
const DEFAULT_LNG = 114.1748;

/** The website reports "no restriction" as max height 300cm / min height 0cm. */
const HEIGHT_NO_LIMIT_CM = 300;

/** Map category slugs that contain entity pixel positions */
const MAP_CATEGORIES = ['attractions', 'animals', 'dining', 'transportations', 'shows', 'shops'] as const;

/** How many days ahead to probe for published park hours. */
const SCHEDULE_DAYS = 60;

/**
 * Real RSC payloads for these pages run a few hundred KB. Anything wildly
 * larger is either a bug upstream, a WAF/CDN interstitial swapped in for the
 * real page, or a truncated response — bail out before attempting to scan it
 * rather than risk pathological scan cost on adversarial/corrupted input.
 */
const MAX_SCRAPE_HTML_LENGTH = 2_000_000;

/**
 * A normal page has a few dozen flight-payload chunks. Far more
 * self.__next_f.push() occurrences than that means the document is
 * malformed — cap the number of candidates tried so a document packed with
 * unterminated push() tokens can't force many full-document rescans.
 */
const MAX_PUSH_ATTEMPTS = 100;

// ── Website JSON shapes (embedded RSC payloads / Next.js API routes) ────────

interface OceanParkNodeUrl {
  label: string;
  url: string;
}

interface OceanParkTag {
  id?: string;
  label?: string;
}

interface OceanParkQueueTime {
  text?: string | null;
}

/** An attraction card from the /attractions listing page. */
interface OceanParkAttractionItem {
  nodeId: string;
  nodeUrl: OceanParkNodeUrl;
  attractionTypes?: OceanParkTag[];
  height?: {min?: number; max?: number};
  queueTime?: OceanParkQueueTime | null;
}

/** A restaurant card from the "Restaurants" tab's pageItems. */
interface OceanParkRestaurantItem {
  nodeUrl: OceanParkNodeUrl;
}

interface OceanParkDiningTab {
  tab: {id: string; label: string};
  pageItems?: OceanParkRestaurantItem[];
}

interface OceanParkScheduleItem {
  title: string;
  timeSlot?: string[];
  locations?: {location?: {id?: string}}[];
}

interface OceanParkDailyScheduleResponse {
  items?: OceanParkScheduleItem[];
}

interface OceanParkParkOpeningHoursResponse {
  parkOpeningHoursValue?: string;
}

interface OceanParkReferencePoint {
  pixelX: number;
  pixelY: number;
  latitude: number;
  longitude: number;
}

interface OceanParkMapEntity {
  name?: string;
  api_key?: string;
  url?: string;
  x?: number;
  y?: number;
}

interface AffineCoeffs {
  a: number; b: number; c: number; // lat = a*x + b*y + c
  d: number; e: number; f: number; // lng = d*x + e*y + f
}

/** A group of same-slug schedule entries collapsed to one show identity. */
interface ShowGroup {
  title: string;
  items: OceanParkScheduleItem[];
  alias?: string;
  mapKey?: string;
}

// Every title the park has published for one physical show, so that a
// seasonal rename keeps the show's entity id instead of minting a new one
// and stranding its history (#561).
//
// This is data, not a heuristic: a title belongs to a family only if it is
// listed here. When the park invents a new edition name, the feed publishes
// it under its own id and warnIfTableLooksStale() says so in the logs; the
// fix is to add the new title to `titles` below. `id` must be the slug of
// the show's bare name — a test asserts it for every family.
//
// `location` is the zone id the feed tags the show with (`aqua-city`, not
// the display name "Aqua City Lagoon"); it is only ever used to log that a
// show turned up somewhere unexpected.
// Seasonal IDs change once; consumers must migrate historical IDs separately.
// Sources: Ocean Park's events/{pandastic-summer-birthday-celebration,
// ocean-park-sanrio-characters-marine-wonders,wondrous-winter-gala-christmas,
// summer-splash-2025} and park-experience/wondrous-winter-gala-cny pages.
/** One physical show, and every title the park has published for it. */
interface ShowAlias {
  id: string;
  mapKey: string;
  location: string;
  titles: string[];
}

export const SHOW_ALIASES: ShowAlias[] = [{
  id: 'gala-of-lights', mapKey: 'galaoflights', location: 'aqua-city',
  titles: [
    'Gala of Lights',
    'Gala Of Lights: Sanrio characters’ Whimsical Celebration',
    'Gala Of Lights – Pandastic Birthday Edition',
    'Gala Of Lights – New Year Celebration',
    'Gala Of Lights - Winter Celebration',
    'Gala Of Lights -- Panda Birthday Edition',
  ],
}];

/**
 * Everything before a title's first subtitle separator. Used ONLY to decide
 * whether to log that SHOW_ALIASES looks stale — it can never change an
 * entity id. A separator is a colon, or a dash run with whitespace on both
 * sides; a colon flanked by digits is a clock ("Chill Out Party 19:30
 * Special"), not a subtitle. NFKD first so the fullwidth punctuation a CJK
 * CMS emits folds onto the ASCII forms this scans for.
 */
const SUBTITLE_SEPARATOR =
  /(?<!\d):(?!\d)|\s[-\u2010\u2011\u2012\u2013\u2014\u2015\u2212]+\s/;

function titleHead(title: string): string {
  const text = title.normalize('NFKD').trim();
  const at = text.search(SUBTITLE_SEPARATOR);
  return at < 0 ? text : text.slice(0, at).trim();
}

/** Zone ids on a schedule row, tolerating every shape the feed has served. */
function rowVenues(item: OceanParkScheduleItem): string[] {
  if (!Array.isArray(item?.locations)) return [];
  return item.locations
    .map(l => l?.location?.id)
    .filter((id): id is string => typeof id === 'string' && id !== '');
}

/**
 * Resolve one schedule row onto a curated show family, or undefined if it
 * belongs to none.
 *
 * Identity comes from the curated list and nothing else. A title is this
 * show if a human wrote that title down here; otherwise it is its own show.
 * There is deliberately no rule that infers a family from a title nobody has
 * vouched for: the park renames these shows about twice a year, so the cost
 * of getting it wrong — silently folding a genuinely new production into an
 * existing entity, or renaming one — outweighs the cost of a two-line edit
 * to the table each season. What this does instead is say, loudly, when the
 * table looks stale, so the edit actually gets made.
 *
 * The zone a row names is reported, never enforced. Refusing a family on a
 * zone mismatch cost three separate defects across two review rounds. The
 * zone is upstream prose; the title is the identity.
 */
function showAlias(item: OceanParkScheduleItem, aliases: ShowAlias[]) {
  const slug = slugify(item.title);

  // `a.id === slug` is matched as well as the curated titles, so a family
  // whose `titles` omits its own bare name still resolves — the id IS the
  // bare name by construction.
  const family = aliases.find(a => a.id === slug || a.titles.some(t => slugify(t) === slug));
  if (!family) {
    warnIfTableLooksStale(item, aliases, slug);
    return undefined;
  }

  const venues = rowVenues(item);
  if (venues.length > 0 && !venues.includes(family.location)) {
    console.warn(
      `[OceanPark] show "${item.title}" resolves to "${family.id}" but is staged at ${venues.join('/')}, not ${family.location}; check whether the park has reused the name`,
    );
  }
  return family;
}

/**
 * Log-only. A title whose head names a curated family, but which is not
 * itself listed, is almost always that show's next seasonal edition — which
 * means it is about to publish under a new entity id and strand the old
 * one's history. That is issue #561 recurring, and the whole reason this
 * table exists, so it must not happen quietly.
 *
 * This deliberately does not act on the guess. Adding the title to
 * SHOW_ALIASES is a human's call, and a two-line edit.
 */
function warnIfTableLooksStale(item: OceanParkScheduleItem, aliases: ShowAlias[], slug: string): void {
  const headSlug = slugify(titleHead(item.title));
  if (!headSlug || headSlug === slug) return;
  const family = aliases.find(a => a.id === headSlug);
  console.warn(family
    ? `[OceanPark] show "${item.title}" looks like a new edition of "${family.id}" but is not in SHOW_ALIASES; it will publish as "show_${slug}" and strand the old id until the title is added`
    : `[OceanPark] subtitled show "${item.title}" belongs to no curated family; publishing as "show_${slug}", which will change if the subtitle changes`);
}

// ── Pure Functions ──────────────────────────────────────────────────────────

/** Stringify `err` for a log line without throwing on non-Error values. */
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Find the balanced closing bracket matching `str[openIdx]`, honouring JSON
 * string quoting so brackets inside string literals (e.g. `[`/`]` in prose)
 * don't throw off the count.
 */
export function findMatchingBracket(str: string, openIdx: number, openChar: string, closeChar: string): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = openIdx; i < str.length; i++) {
    const c = str[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === openChar) depth++;
    else if (c === closeChar) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** Locate `"marker":[...]` in `text` and parse the array. */
export function findJsonArray(text: string, marker: string): unknown[] | null {
  const markerIdx = text.indexOf(marker);
  if (markerIdx === -1) return null;
  let i = markerIdx + marker.length;
  while (text[i] === ' ') i++;
  if (text[i] !== '[') return null;
  const end = findMatchingBracket(text, i, '[', ']');
  if (end === -1) return null;
  try {
    return JSON.parse(text.slice(i, end)) as unknown[];
  } catch {
    return null;
  }
}

/**
 * Extract a JSON array embedded in a Next.js React Server Component "flight"
 * payload: `self.__next_f.push([1,"...escaped string..."])`.
 *
 * The push() argument is itself valid JSON — `[1, "<escaped string>"]` — so
 * parsing it directly yields a correctly unescaped inner string (quotes,
 * unicode, etc. all handled by JSON.parse) rather than hand-rolled backslash
 * stripping. `marker` (e.g. `"items":`) then locates the target array within
 * that unescaped string.
 *
 * `validate` optionally rejects a marker match whose array doesn't look like
 * the expected shape (e.g. a same-named `"items"` array from an unrelated nav
 * widget earlier in the document) and keeps scanning for another push() chunk
 * instead of returning the wrong data.
 *
 * Bounded by MAX_SCRAPE_HTML_LENGTH / MAX_PUSH_ATTEMPTS: an unbounded scan
 * over a malformed or adversarially truncated document (every
 * findMatchingBracket failure re-scans to end-of-string) is quadratic in the
 * number of unterminated push() occurrences — these caps keep worst case
 * bounded instead of blocking the process for tens of seconds on a mangled
 * upstream response.
 */
export function extractRscArray(
  html: string,
  marker: string,
  validate?: (arr: unknown[]) => boolean,
): unknown[] | null {
  if (html.length > MAX_SCRAPE_HTML_LENGTH) return null;

  const pushToken = 'self.__next_f.push(';
  let searchFrom = 0;
  let attempts = 0;

  for (;;) {
    if (++attempts > MAX_PUSH_ATTEMPTS) return null;
    const pushIdx = html.indexOf(pushToken, searchFrom);
    if (pushIdx === -1) return null;
    const argStart = pushIdx + pushToken.length;

    if (html[argStart] !== '[') { searchFrom = argStart + 1; continue; }
    const argEnd = findMatchingBracket(html, argStart, '[', ']');
    if (argEnd === -1) { searchFrom = argStart + 1; continue; }
    searchFrom = argEnd;

    let payload: unknown;
    try {
      payload = JSON.parse(html.slice(argStart, argEnd));
    } catch {
      continue;
    }
    if (!Array.isArray(payload) || typeof payload[1] !== 'string') continue;

    const arr = findJsonArray(payload[1], marker);
    if (arr && (!validate || validate(arr))) return arr;
  }
}

/** First element looks like an object with `key` — a cheap shape check to reject a same-named array from the wrong widget. */
function firstItemHasKey(key: string): (arr: unknown[]) => boolean {
  return (arr) => arr.length === 0 || (typeof arr[0] === 'object' && arr[0] !== null && key in (arr[0] as object));
}

/**
 * An attraction item needs a stable identity (nodeId) and a name/slug source
 * (nodeUrl) to be usable — both are dereferenced unguarded downstream, so a
 * card missing either must be dropped here rather than crash the whole
 * entity list or live-data build, or collide with another item on the
 * fallback id "attraction_undefined".
 */
function isValidAttractionItem(item: OceanParkAttractionItem): boolean {
  const ok = !!item?.nodeId && !!item?.nodeUrl?.url && !!item?.nodeUrl?.label;
  if (!ok) console.warn(`[OceanPark] skipping malformed attraction item: ${JSON.stringify(item).slice(0, 200)}`);
  return ok;
}

/** Last non-empty path segment of a URL (query string/fragment stripped) — Ocean Park's canonical entity slug. */
export function slugFromUrl(url: string): string {
  const clean = url.split('?')[0].split('#')[0];
  const parts = clean.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

/** Deterministic slug for entities the website gives no id/URL for (shows). */
export function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Choose the display title for a merged show. An edition title ("Gala Of
 * Lights - Winter Celebration") says more than the bare name the id is built
 * from, so it wins. Ties break lexically, so the same set of rows always
 * yields the same name regardless of the order the feed listed them in.
 */
function pickEditionTitle(titles: string[], alias: ShowAlias): string {
  // Every row in a family's group is a curated title, so the only choice is
  // between the bare name and an edition of it.
  const isBare = (t: string) => slugify(t) === alias.id;
  return [...titles].sort((a, b) =>
    Number(isBare(a)) - Number(isBare(b)) || (a < b ? -1 : a > b ? 1 : 0),
  )[0];
}

/**
 * Group schedule items by slug rather than by raw title. slugify() collapses
 * differently-punctuated titles (e.g. "Whiskers & Friends" / "Whiskers,
 * Friends") onto the same id, so grouping by title alone would let two
 * distinct shows silently share one entity/live-data id and clobber each
 * other. The first title seen for a slug wins; a different title landing on
 * an already-claimed slug is dropped (logged) rather than silently merged,
 * except for rows of the same curated show family, which are merged and
 * named by pickEditionTitle() rather than by whichever row arrived first.
 * A title that normalizes to an empty slug is dropped the same way.
 *
 * Used by both buildEntityList and buildLiveData so the two always agree on
 * exactly which id each show maps to.
 */
export function groupShowsBySlug(
  scheduleItems: OceanParkScheduleItem[],
  aliases: ShowAlias[] = SHOW_ALIASES,
): Map<string, ShowGroup> {
  const bySlug = new Map<string, ShowGroup>();

  // One resolution per title, so every row of a show agrees and a warning is
  // logged once rather than once per performance.
  const aliasByTitle = new Map<string, ShowAlias | undefined>();

  for (const item of scheduleItems) {
    if (typeof item?.title !== 'string') {
      console.warn(`[OceanPark] skipping schedule row with no usable title: ${JSON.stringify(item)?.slice(0, 120)}`);
      continue;
    }
    const key = slugify(item.title);
    if (!aliasByTitle.has(key)) aliasByTitle.set(key, showAlias(item, aliases));
    const alias = aliasByTitle.get(key);
    const slug = alias?.id ?? slugify(item.title);
    if (!slug) {
      console.warn(`[OceanPark] skipping show with empty slug after normalisation: "${item.title}"`);
      continue;
    }

    const existing = bySlug.get(slug);
    if (!existing) {
      bySlug.set(slug, {title: item.title, items: [item], alias: alias?.id, mapKey: alias?.mapKey});
    // An identical title always belongs to the same group, whatever the alias
    // resolution did, so a row can never be dropped for disagreeing with its
    // own twin. Compare against the rows, not the display title, which
    // pickEditionTitle may already have rewritten.
    } else if ((alias && existing.alias === alias.id) || existing.items.some(i => i.title === item.title)) {
      existing.items.push(item);
      if (alias) existing.title = pickEditionTitle(existing.items.map(i => i.title), alias);
    } else {
      console.warn(
        `[OceanPark] show "${item.title}" collides on slug "${slug}" with already-seen "${existing.title}"; dropping the later one to avoid a duplicate entity id`,
      );
    }
  }

  return bySlug;
}

/**
 * Parse "10 mins" / " 0  mins" style queue text into minutes. Requires the
 * number to actually be adjacent to "min" so incidental digits elsewhere in
 * a status string (e.g. a future "Reopens at 5pm") can't be misread as a
 * wait time.
 *
 * Returns null for missing/unparseable text — the website uses an explicit
 * `null` queueTime for attractions with no queue mechanic (walkthroughs,
 * animal exhibits), which we can't distinguish from "currently closed"
 * without a live signal, so both cases fall through to null here.
 */
export function parseQueueMinutes(text: string | null | undefined): number | null {
  if (text == null) return null;
  const m = text.match(/(\d+)\s*min/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Parse one `timeSlot` entry from the daily-schedule feed.
 *
 * Nearly every entry is a single start time ("13:00:00"). Event-tab items are
 * sometimes a continuous window instead ("11:00:00-17:00:00" — the
 * halloween-2026 tab's Bulu Boo Trick-or-Treat Party), which is a range, not
 * a start time. Handing that string straight to constructDateTime() built an
 * Invalid Date and threw a bare RangeError out of buildLiveData(), so one
 * event item took every attraction wait time down with it on every sync.
 *
 * Returns null for anything that is not a valid time or time range, so no
 * unvalidated feed text ever reaches date construction. A range whose end is
 * not after its start is nonsense (the park does not run past midnight), so
 * the end is discarded and only the start kept.
 */
export function parseShowTimeSlot(raw: unknown): {start: string; end?: string} | null {
  if (typeof raw !== 'string') return null;

  // The dash class matches the one titles are split on, plus the tilde forms
  // Hong Kong listings use for a range. A separator this misses does not cost
  // the end time, it costs the whole slot: the unsplit string fails the clock
  // check and the performance vanishes from live data.
  const parts = raw.normalize('NFKD').trim()
    .split(/\s*[-\u2010\u2011\u2012\u2013\u2014\u2015\u2212~\u301c\uff5e]+\s*/);
  if (parts.length > 2) return null;

  const start = normaliseClockTime(parts[0]);
  if (!start) return null;
  if (parts.length === 1) return {start};

  const end = normaliseClockTime(parts[1]);
  if (!end) {
    // Keep the start. The end is the optional half, and "18:00:00-24:00:00"
    // — the ordinary CMS spelling for a midnight close, which the clock
    // check rejects for h > 23 — would otherwise delete the performance
    // outright and publish the show as CLOSED while it is running. The
    // out-of-order-end branch below already makes exactly this trade.
    console.warn(`[OceanPark] unparseable end in timeSlot ${JSON.stringify(raw)}; keeping the start only`);
    return {start};
  }
  if (end <= start) {
    console.warn(`[OceanPark] range timeSlot "${raw}" ends at or before it starts; keeping the start only`);
    return {start};
  }

  return {start, end};
}

/** "13:5" style sloppiness is rejected; "13:05" and "13:05:00" both normalise to "13:05:00". */
function normaliseClockTime(text: string): string | null {
  const m = text.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;

  const h = Number(m[1]);
  const min = Number(m[2]);
  const sec = m[3] === undefined ? 0 : Number(m[3]);
  if (h > 23 || min > 59 || sec > 59) return null;

  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(min)}:${pad(sec)}`;
}

/** Parse a "10:00 am - 7:00 pm" style range into 24h HH:mm strings. */
export function parseHourRange(text: string): {open: string; close: string} | null {
  const m = text.match(/(\d{1,2}):(\d{2})\s*([ap]m)\s*-\s*(\d{1,2}):(\d{2})\s*([ap]m)/i);
  if (!m) return null;

  const to24h = (hourStr: string, ampm: string): string => {
    let hour = parseInt(hourStr, 10) % 12;
    if (ampm.toLowerCase() === 'pm') hour += 12;
    return String(hour).padStart(2, '0');
  };

  return {
    open: `${to24h(m[1], m[3])}:${m[2]}`,
    close: `${to24h(m[4], m[6])}:${m[5]}`,
  };
}

/**
 * Add `days` to a YYYY-MM-DD calendar date string via pure calendar
 * arithmetic (Date.UTC normalises month/day overflow), with no dependency on
 * the host process's local timezone. Deliberately not the shared
 * addDays()+formatDate(tz) pattern used elsewhere in the codebase — that
 * pattern steps the day-of-month in the *host's* local timezone before
 * converting to the target timezone, which can misfire by a day around a
 * host-timezone DST transition. Building 60 schedule dates makes that a much
 * bigger surface here than a single-date adjustment.
 */
export function addDaysToDateString(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  // utc-date-ok: built from a parsed YYYY-MM-DD via Date.UTC, so this shifts a
  // supplied calendar day rather than reading one off the clock.
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * Compute affine transform coefficients from a set of reference points.
 * Solves lat = a*x + b*y + c and lng = d*x + e*y + f using least-squares
 * normal equations (Cramer's rule on the 3×3 system).
 */
export function computeAffineTransform(refPoints: OceanParkReferencePoint[]): AffineCoeffs | null {
  let sumX = 0, sumY = 0, sumXX = 0, sumXY = 0, sumYY = 0;
  let sumLat = 0, sumXLat = 0, sumYLat = 0;
  let sumLng = 0, sumXLng = 0, sumYLng = 0;
  const n = refPoints.length;

  for (const p of refPoints) {
    const {pixelX: x, pixelY: y, latitude: lat, longitude: lng} = p;
    sumX += x; sumY += y;
    sumXX += x * x; sumXY += x * y; sumYY += y * y;
    sumLat += lat; sumXLat += x * lat; sumYLat += y * lat;
    sumLng += lng; sumXLng += x * lng; sumYLng += y * lng;
  }

  const M: [number, number, number][] = [
    [sumXX, sumXY, sumX],
    [sumXY, sumYY, sumY],
    [sumX,  sumY,  n],
  ];

  const det = (m: [number, number, number][]) =>
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);

  const D = det(M);
  if (!Number.isFinite(D) || Math.abs(D) < 1e-10) return null;

  const cramer = (rhs: number[]): [number, number, number] => {
    const M0: [number, number, number][] = [[rhs[0], M[0][1], M[0][2]], [rhs[1], M[1][1], M[1][2]], [rhs[2], M[2][1], M[2][2]]];
    const M1: [number, number, number][] = [[M[0][0], rhs[0], M[0][2]], [M[1][0], rhs[1], M[1][2]], [M[2][0], rhs[2], M[2][2]]];
    const M2: [number, number, number][] = [[M[0][0], M[0][1], rhs[0]], [M[1][0], M[1][1], rhs[1]], [M[2][0], M[2][1], rhs[2]]];
    return [det(M0) / D, det(M1) / D, det(M2) / D];
  };

  const [a, b, c] = cramer([sumXLat, sumYLat, sumLat]);
  const [d, e, f] = cramer([sumXLng, sumYLng, sumLng]);
  return {a, b, c, d, e, f};
}

// ── Implementation ──────────────────────────────────────────────────────────

@destinationController({category: 'Ocean Park'})
export class OceanParkHongKong extends Destination {
  @config baseURL: string = '';
  @config mapURL: string = '';
  @config userAgent: string = '';

  timezone = TIMEZONE;

  constructor(options?: DestinationConstructor) {
    super(options);
    this.addConfigPrefix('OCEANPARK');
  }

  getCacheKeyPrefix(): string {
    return 'oceanpark';
  }

  // ── Auth / WAF ────────────────────────────────────────────────────────────

  /**
   * www.oceanpark.com.hk 403s any request without a browser-like User-Agent
   * (see file header). map.oceanpark.com.hk is unaffected, so this is scoped
   * to baseURL's host only.
   */
  @inject({
    eventName: 'httpRequest',
    hostname: function (this: OceanParkHongKong) {
      return hostnameFromUrl(this.baseURL);
    },
  })
  async injectUserAgent(req: HTTPObj): Promise<void> {
    if (!this.userAgent) {
      throw new Error(
        'OceanParkHongKong requires OCEANPARK_USERAGENT to be set (browser-like UA — www.oceanpark.com.hk WAF-blocks default clients)',
      );
    }
    req.headers = {
      ...req.headers,
      'user-agent': this.userAgent,
    };
  }

  // ── HTTP Fetch Methods ────────────────────────────────────────────────────

  /** SSR attractions listing — embeds live queue times. Short cache since wait times refresh often. */
  @http({cacheSeconds: 60})
  async fetchAttractionsPage(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.baseURL}/en/a-day-at-the-park/attractions`,
      options: {json: false},
    } as any as HTTPObj;
  }

  /** SSR dining/shopping listing (Restaurants / Food Kiosks / Shopping tabs). Static-ish, long cache. */
  @http({cacheSeconds: 3600})
  async fetchDiningPage(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.baseURL}/en/a-day-at-the-park/dining-shopping/restaurants`,
      options: {json: false},
    } as any as HTTPObj;
  }

  /** Today's stage/animal programme times. Same-origin Next.js API route, no auth. */
  @http({cacheSeconds: 1800})
  async fetchDailySchedule(date: string): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.baseURL}/api/main/daily-schedule?date=${encodeURIComponent(date)}`,
      options: {json: true},
    } as any as HTTPObj;
  }

  /** Park open/close hours for a single date, as free text (e.g. "10:00 am - 7:00 pm"). */
  @http({cacheSeconds: 3600})
  async fetchParkOpeningHours(date: string): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.baseURL}/api/main/park-opening-hours?date=${encodeURIComponent(date)}`,
      options: {json: true},
    } as any as HTTPObj;
  }

  /** Fetch reference points (pixel → lat/lng anchors) from the map subdomain. */
  @http({cacheSeconds: 86400})
  async fetchReferencePoints(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.mapURL}/assets/data/reference_points.json`,
      options: {json: true},
    } as any as HTTPObj;
  }

  /** Fetch entity pixel positions for a given map category. */
  @http({cacheSeconds: 86400})
  async fetchMapCategoryData(category: string): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.mapURL}/assets/data/${category}.json`,
      options: {json: true},
    } as any as HTTPObj;
  }

  // ── Parsed Accessors ──────────────────────────────────────────────────────

  /**
   * @cache here (matching fetchAttractionsPage's 60s TTL) avoids redoing the
   * RSC bracket-scan + JSON.parse on every buildLiveData() poll when the
   * underlying HTML is already an HTTP-layer cache hit.
   *
   * Returns the raw parsed list, not yet validated per-item — buildEntityList
   * and buildLiveData each filter with isValidAttractionItem() at their own
   * consumption point (matching the restaurant-item pattern below) so a
   * malformed card can't crash either builder's .map()/loop.
   */
  @cache({ttlSeconds: 60})
  async getAttractionItems(): Promise<OceanParkAttractionItem[]> {
    const resp = await this.fetchAttractionsPage();
    const html = await resp.text();
    const items = extractRscArray(html, '"items":', firstItemHasKey('nodeId')) as OceanParkAttractionItem[] | null;
    if (!items) {
      console.warn('[OceanPark] attractions page RSC data not found; entity list and wait times will be empty this cycle');
      return [];
    }
    return items;
  }

  /** See getAttractionItems() — same caching/dropped-item rationale, restaurant items validated where they're flattened out of tabs in buildEntityList. */
  @cache({ttlSeconds: 3600})
  async getDiningTabs(): Promise<OceanParkDiningTab[]> {
    const resp = await this.fetchDiningPage();
    const html = await resp.text();
    const tabs = extractRscArray(html, '"items":', firstItemHasKey('tab')) as OceanParkDiningTab[] | null;
    if (!tabs) {
      console.warn('[OceanPark] dining page RSC data not found; restaurant list will be empty this cycle');
      return [];
    }
    return tabs;
  }

  async getDailyScheduleItems(date: string): Promise<OceanParkScheduleItem[]> {
    const resp = await this.fetchDailySchedule(date);
    const body: OceanParkDailyScheduleResponse = await resp.json();
    // Array.isArray, not `?? []`: the feed has to be assumed capable of
    // serving `items` as an object, a number or a bare `0`, and `0 ?? []`
    // keeps the zero. Both builders iterate this, and buildLiveData does so
    // after its per-source catch has already run, so a non-array here takes
    // every attraction wait time down with it.
    return Array.isArray(body?.items) ? body.items : [];
  }

  async getParkOpeningHoursValue(date: string): Promise<string | null> {
    const resp = await this.fetchParkOpeningHours(date);
    const body: OceanParkParkOpeningHoursResponse = await resp.json();
    return body?.parkOpeningHoursValue ?? null;
  }

  /**
   * Build a serialisable coordinate map keyed by URL slug, plus namespaced
   * unique show names and map API keys (many shows have no URL), by:
   * 1. Fetching reference points and computing an affine pixel→geo transform.
   * 2. Fetching each map category and projecting each entity's pixel position.
   *
   * Returned as an array of [key, value] pairs.
   *
   * No @cache here — degenerate input must throw so the underlying @http
   * fetchers (24h TTL each) keep retrying instead of pinning every entity
   * to its default location for a day. Callers are expected to catch and
   * fall back to no-coords on transient failure.
   */
  async getCoordinateMapEntries(): Promise<[string, {latitude: number; longitude: number}][]> {
    const refResp = await this.fetchReferencePoints();
    const refPoints: OceanParkReferencePoint[] = await refResp.json();
    if (!Array.isArray(refPoints) || refPoints.length < 3) {
      throw new Error(
        `OceanPark: reference points payload invalid (got ${Array.isArray(refPoints) ? `${refPoints.length} entries` : typeof refPoints})`,
      );
    }

    const coeffs = computeAffineTransform(refPoints);
    if (!coeffs) {
      throw new Error('OceanPark: affine transform degenerate (collinear or duplicate reference points)');
    }
    const entries: [string, {latitude: number; longitude: number}][] = [];

    const categoryResponses = await Promise.all(
      MAP_CATEGORIES.map((category) => this.fetchMapCategoryData(category)),
    );
    for (const [index, resp] of categoryResponses.entries()) {
      const entities: OceanParkMapEntity[] = await resp.json();
      if (!Array.isArray(entities)) continue;

      // Only a number or a non-blank numeric string is a pixel. Number()
      // alone would turn null, "" , false and [] into 0 — a real position at
      // the top-left of the map — which is the coercion trap the codebase
      // bans isNaN() for.
      const pixel = (v: unknown): number =>
        typeof v === 'number' ? v
          : typeof v === 'string' && v.trim() !== '' ? Number(v)
            : NaN;
      const project = (e: OceanParkMapEntity) => ({
        latitude:  coeffs.a * pixel(e.x) + coeffs.b * pixel(e.y) + coeffs.c,
        longitude: coeffs.d * pixel(e.x) + coeffs.e * pixel(e.y) + coeffs.f,
      });
      // A pixel is a number or a non-blank numeric string. Number() alone
      // would turn null, "", false and [] into 0 — a real position at the
      // top-left of the map — which is the coercion trap this codebase bans
      // isNaN() for. The projection is range-checked as well as finite-
      // checked: Number.isFinite accepts a sentinel pixel that projects to
      // latitude -934, and nothing downstream validates a lat/lng before it
      // reaches the wiki.
      const onEarth = (c: {latitude: number; longitude: number}) =>
        Math.abs(c.latitude) <= 90 && Math.abs(c.longitude) <= 180;
      const placed = entities.filter(e =>
        Number.isFinite(pixel(e.x)) && Number.isFinite(pixel(e.y)) && onEarth(project(e)));

      // A key that names more than one DISTINCT position cannot identify a
      // show — the feed really does list two different "Roving Band" entries.
      // Uniqueness is judged after the coordinate filter and after collapsing
      // verbatim duplicate rows, so a coordinate-less or repeated row cannot
      // suppress a perfectly good one.
      //
      // Shows only. The other categories keep the long-standing last-wins
      // behaviour: `animals` and `shops` already ship duplicate URL slugs, so
      // suppressing them would take a pin away from an attraction the day the
      // feed duplicates one, and this change has no business touching the
      // categories it was not written for.
      const claims = new Map<string, Set<string>>();
      const claim = (key: string, e: OceanParkMapEntity) => {
        const at = JSON.stringify(project(e));
        claims.set(key, (claims.get(key) ?? new Set()).add(at));
      };

      if (MAP_CATEGORIES[index] === 'shows') {
        for (const e of placed) {
          // Guard the slug, not the raw name: a CJK-only name slugifies to ""
          // and would publish the wildcard key "show-name:". Guard the type
          // too — slugify() calls .normalize(), so a localised {en, zh} name
          // would throw and take every coordinate in the park down with it.
          const named = typeof e.name === 'string' ? slugify(e.name) : '';
          if (named) claim(`show-name:${named}`, e);
          if (typeof e.api_key === 'string' && e.api_key) claim(`show-key:${e.api_key}`, e);
          // A show's URL slug gets its own namespace rather than the shared
          // one. Otherwise an ambiguous show suppressed here could still be
          // served a pin that another category published under the same bare
          // slug, and the disambiguation would be undone by the next loop.
          if (typeof e.url === 'string' && e.url) claim(`show-url:${slugFromUrl(e.url)}`, e);
        }
      } else {
        // typeof, not truthiness: slugFromUrl calls .split, so a non-string
        // url throws out of here and the caller's catch defaults every
        // coordinate in the park.
        for (const e of placed) if (typeof e.url === 'string' && e.url) claim(slugFromUrl(e.url), e);
      }

      const ambiguousMayWin = MAP_CATEGORIES[index] !== 'shows';
      for (const [key, positions] of claims) {
        if (!key || (positions.size !== 1 && !ambiguousMayWin)) continue;
        entries.push([key, JSON.parse([...positions][positions.size - 1])]);
      }
    }

    return entries;
  }

  // ── Destination ───────────────────────────────────────────────────────────

  async getDestinations(): Promise<Entity[]> {
    return [{
      id: DESTINATION_ID,
      name: 'Ocean Park Hong Kong',
      entityType: 'DESTINATION',
      timezone: TIMEZONE,
      location: {latitude: DEFAULT_LAT, longitude: DEFAULT_LNG},
    } as Entity];
  }

  // ── Entity List ───────────────────────────────────────────────────────────

  protected async buildEntityList(): Promise<Entity[]> {
    const today = formatDate(new Date(), TIMEZONE);

    // Four independent upstream sources (SSR attractions page, SSR dining
    // page, the daily-schedule API route, and the map subdomain) — each
    // isolated with its own .catch() so one flaky source degrades that
    // category to empty rather than throwing away the whole entity list.
    const [attractionItems, diningTabs, scheduleItems, coordEntries] = await Promise.all([
      this.getAttractionItems().catch((err: unknown) => {
        console.warn(`[OceanPark] attractions fetch failed (${errMsg(err)}); no attractions this cycle`);
        return [] as OceanParkAttractionItem[];
      }),
      this.getDiningTabs().catch((err: unknown) => {
        console.warn(`[OceanPark] dining fetch failed (${errMsg(err)}); no restaurants this cycle`);
        return [] as OceanParkDiningTab[];
      }),
      this.getDailyScheduleItems(today).catch((err: unknown) => {
        console.warn(`[OceanPark] daily schedule fetch failed (${errMsg(err)}); no shows this cycle`);
        return [] as OceanParkScheduleItem[];
      }),
      this.getCoordinateMapEntries().catch((err: unknown) => {
        console.warn(`[OceanPark] coordinate map unavailable (${errMsg(err)}); entities will use default location`);
        return [] as [string, {latitude: number; longitude: number}][];
      }),
    ]);

    const coordMap = new Map(coordEntries);

    const park: Entity = {
      id: PARK_ID,
      name: 'Ocean Park',
      entityType: 'PARK',
      parentId: DESTINATION_ID,
      destinationId: DESTINATION_ID,
      timezone: TIMEZONE,
      location: {latitude: DEFAULT_LAT, longitude: DEFAULT_LNG},
    } as Entity;

    const attractionEntities: Entity[] = attractionItems.filter(isValidAttractionItem).map(item => {
      const isTransport = (item.attractionTypes ?? []).some(t => t.id === 'in-park-transportation');
      const coords = coordMap.get(slugFromUrl(item.nodeUrl.url));

      const tags = [];
      const minHeight = item.height?.min ?? 0;
      const maxHeight = item.height?.max ?? HEIGHT_NO_LIMIT_CM;
      if (minHeight > 0) tags.push(TagBuilder.minimumHeight(minHeight, 'cm'));
      if (maxHeight < HEIGHT_NO_LIMIT_CM) tags.push(TagBuilder.maximumHeight(maxHeight, 'cm'));

      const built: Entity = {
        id: `attraction_${item.nodeId}`,
        name: item.nodeUrl.label,
        entityType: 'ATTRACTION',
        attractionType: isTransport ? AttractionTypeEnum.TRANSPORT : AttractionTypeEnum.RIDE,
        parentId: PARK_ID,
        destinationId: DESTINATION_ID,
        timezone: TIMEZONE,
        location: coords ?? {latitude: DEFAULT_LAT, longitude: DEFAULT_LNG},
      } as Entity;

      if (tags.length > 0) built.tags = tags;
      return built;
    });

    const restaurantEntities: Entity[] = diningTabs
      .filter(tab => tab.tab?.id === 'restaurants')
      .flatMap(tab => tab.pageItems ?? [])
      .filter(item => {
        const ok = !!item?.nodeUrl?.url && !!item?.nodeUrl?.label;
        if (!ok) console.warn(`[OceanPark] skipping malformed restaurant item: ${JSON.stringify(item).slice(0, 200)}`);
        return ok;
      })
      .map(item => {
        const slug = slugFromUrl(item.nodeUrl.url);
        const coords = coordMap.get(slug);
        return {
          id: `restaurant_${slug}`,
          name: item.nodeUrl.label,
          entityType: 'RESTAURANT',
          parentId: PARK_ID,
          destinationId: DESTINATION_ID,
          timezone: TIMEZONE,
          location: coords ?? {latitude: DEFAULT_LAT, longitude: DEFAULT_LNG},
        } as Entity;
      });

    // Shows have no id/URL from the website at all — only a title, via the
    // daily-schedule endpoint. groupShowsBySlug() resolves slug collisions
    // once, consistently with buildLiveData. Coordinate lookup is independent
    // of identity: explicit map aliases, unique names, then full-title URL slug.
    const showGroups = groupShowsBySlug(scheduleItems);
    const showEntities: Entity[] = [...showGroups.entries()].map(([slug, group]) => {
      // The group carries its own map key, so this never re-resolves against
      // the module table and can't disagree with the grouping that produced
      // it. The canonical slug is tried before the display title: a merged
      // group's title is an edition name the map has never heard of, while
      // the map does know the bare show name.
      // The curated map key wins: a human checked it against the map. A
      // live name match is the fallback, because upstream owns `name` and a
      // different production can take a family's name — that is worth a pin
      // when nothing better exists, but not worth overriding a vouched-for
      // key. When both exist and disagree, neither order is safe, so say so
      // rather than picking silently.
      const byKey = group.mapKey ? coordMap.get(`show-key:${group.mapKey}`) : undefined;
      const byName = coordMap.get(`show-name:${slug}`);
      if (byKey && byName && (byKey.latitude !== byName.latitude || byKey.longitude !== byName.longitude)) {
        console.warn(
          `[OceanPark] map key "${group.mapKey}" and map name "${slug}" point at different places; using the curated key — check whether the park has reused the name or renumbered the key`,
        );
      }
      const coords = byKey
        ?? byName
        ?? coordMap.get(`show-name:${slugify(group.title)}`)
        ?? coordMap.get(`show-url:${slug}`)
        ?? coordMap.get(`show-url:${slugify(group.title)}`)
        // Last resort, and the only rung that reaches the namespace shared
        // with the other categories: a show whose sole pin was filed under
        // attractions or dining is reachable here and nowhere else.
        ?? coordMap.get(slug)
        ?? coordMap.get(slugify(group.title));
      return {
        id: `show_${slug}`,
        name: group.title,
        entityType: 'SHOW',
        parentId: PARK_ID,
        destinationId: DESTINATION_ID,
        timezone: TIMEZONE,
        location: coords ?? {latitude: DEFAULT_LAT, longitude: DEFAULT_LNG},
      } as Entity;
    });

    return [park, ...attractionEntities, ...restaurantEntities, ...showEntities];
  }

  // ── Live Data ─────────────────────────────────────────────────────────────

  protected async buildLiveData(): Promise<LiveData[]> {
    const today = formatDate(new Date(), TIMEZONE);

    // Two independent sources (SSR attractions page vs. the daily-schedule
    // API route) — isolated so one going down doesn't wipe out live data
    // that came from the other, healthy one.
    const [attractionItems, scheduleItems] = await Promise.all([
      this.getAttractionItems().catch((err: unknown) => {
        console.warn(`[OceanPark] attractions fetch failed (${errMsg(err)}); no attraction wait times this cycle`);
        return [] as OceanParkAttractionItem[];
      }),
      this.getDailyScheduleItems(today).catch((err: unknown) => {
        console.warn(`[OceanPark] daily schedule fetch failed (${errMsg(err)}); no show live data this cycle`);
        return [] as OceanParkScheduleItem[];
      }),
    ]);

    const liveData: LiveData[] = [];

    for (const item of attractionItems.filter(isValidAttractionItem)) {
      const wt = parseQueueMinutes(item.queueTime?.text);

      const ld: LiveData = {
        id: `attraction_${item.nodeId}`,
        // The website gives no explicit open/closed flag — queueTime is the
        // only live signal. No signal (null) means either "no queue
        // mechanic" or "currently closed" and we can't tell which, so it
        // falls through to CLOSED rather than fabricating an OPERATING
        // status with no evidence behind it.
        status: wt !== null ? 'OPERATING' : 'CLOSED',
      } as LiveData;

      if (wt !== null) ld.queue = {STANDBY: {waitTime: wt}};
      liveData.push(ld);
    }

    // Shows — group today's programme entries by slug (same grouping
    // buildEntityList uses, so ids always agree) and emit remaining
    // showtimes. Most entries are a bare start time; event-tab entries can be
    // a start-to-end window instead, which carries a real end time.
    const showGroups = groupShowsBySlug(scheduleItems);
    const now = Date.now();
    for (const [slug, group] of showGroups) {
      const parsed = group.items
        .flatMap(entry => entry.timeSlot ?? [])
        .map(raw => {
          const slot = parseShowTimeSlot(raw);
          if (!slot) {
            console.warn(`[OceanPark] show "${group.title}": unrecognised timeSlot ${JSON.stringify(raw)}; dropping that slot`);
            return null;
          }
          return {
            type: 'Performance Time',
            startTime: constructDateTime(today, slot.start, TIMEZONE),
            ...(slot.end ? {endTime: constructDateTime(today, slot.end, TIMEZONE)} : {}),
          };
        })
        .filter((s): s is {type: string; startTime: string; endTime?: string} => s !== null);

      // Merging a rebranded show can join a bare start time to a range that
      // describes the same performance — every title in the captured corpus
      // sits in exactly one tab, so this is a property of merging rather
      // than something the feed has been seen to do. Dedup on the start
      // alone, keeping whichever entry carries an end time and, between two
      // ends, the later one: keying on both would publish 19:00 twice and
      // drop one of them the second the show began, and first-wins let feed
      // order decide the window.
      // Scoped per group: two different shows may legitimately start at the
      // same time.
      const byStart = new Map<string, {type: string; startTime: string; endTime?: string}>();
      for (const s of parsed) {
        const prev = byStart.get(s.startTime);
        // Prefer the entry carrying an end, and among two ends the later one.
        // First-wins let feed order decide the window, which could publish
        // CLOSED for an event still running.
        if (!prev || !prev.endTime || (s.endTime && s.endTime > prev.endTime)) byStart.set(s.startTime, s);
      }

      const showtimes = [...byStart.values()]
        // Chronological, not feed order, so identical data never publishes a
        // differently ordered array. These are ISO strings at one fixed
        // offset, so lexical order is chronological order.
        .sort((a, b) => (a.startTime < b.startTime ? -1 : a.startTime > b.startTime ? 1 : 0))
        // A window that has started but not yet finished is still running, so
        // an all-day event stays listed until its end time instead of
        // vanishing a second after it opens.
        .filter(s => new Date(s.endTime ?? s.startTime).getTime() >= now);

      const ld: LiveData = {
        id: `show_${slug}`,
        status: showtimes.length > 0 ? 'OPERATING' : 'CLOSED',
      } as LiveData;
      if (showtimes.length > 0) ld.showtimes = showtimes;

      liveData.push(ld);
    }

    return liveData;
  }

  // ── Schedules ─────────────────────────────────────────────────────────────

  protected async buildSchedules(): Promise<EntitySchedule[]> {
    const today = formatDate(new Date(), TIMEZONE);
    const dates = Array.from({length: SCHEDULE_DAYS}, (_, i) => addDaysToDateString(today, i));

    // Promise.allSettled, not Promise.all — 60 independent per-date
    // requests means one transient failure (a single 5xx, a malformed
    // response) must degrade to "one fewer day" rather than reject the
    // entire schedule down to zero days.
    const results = await Promise.allSettled(dates.map(d => this.getParkOpeningHoursValue(d)));

    const scheduleEntries: ScheduleEntry[] = [];
    let failedCount = 0;

    for (let i = 0; i < dates.length; i++) {
      const result = results[i];
      if (result.status === 'rejected') {
        failedCount++;
        continue;
      }

      const hoursText = result.value;
      const range = parseHourRange(hoursText ?? '');
      if (!range) {
        // Empty text means "closed / beyond the published window" — expected
        // and not logged. Non-empty-but-unparseable means the site's hours
        // format changed underneath us; that's worth a log line so it's not
        // silently indistinguishable from a real closure.
        if (hoursText) {
          console.warn(`[OceanPark] unrecognised opening-hours text for ${dates[i]}: "${hoursText}"`);
        }
        continue;
      }

      // A close time numerically "before" the open time on a 24h clock (e.g.
      // "6:00 pm - 12:30 am") means the park closes after midnight the
      // following calendar day, not before it opened the same day.
      const closeDate = range.close <= range.open ? addDaysToDateString(dates[i], 1) : dates[i];

      scheduleEntries.push({
        date: dates[i],
        type: 'OPERATING',
        openingTime: constructDateTime(dates[i], range.open, TIMEZONE),
        closingTime: constructDateTime(closeDate, range.close, TIMEZONE),
      });
    }

    if (failedCount > 0) {
      console.warn(`[OceanPark] ${failedCount}/${dates.length} schedule date requests failed; schedule may have gaps`);
    }

    return [{
      id: PARK_ID,
      schedule: scheduleEntries,
    }];
  }
}

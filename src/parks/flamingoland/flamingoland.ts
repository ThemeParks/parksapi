import {Destination, DestinationConstructor} from '../../destination.js';
import {cache, CacheLib} from '../../cache.js';
import {http, HTTPObj} from '../../http.js';
import {inject} from '../../injector.js';
import config from '../../config.js';
import {destinationController} from '../../destinationRegistry.js';
import {Entity, LiveData, EntitySchedule} from '@themeparks/typelib';
import {decodeHtmlEntities} from '../../htmlUtils.js';
import {TagBuilder} from '../../tags/index.js';
import {constructDateTime} from '../../datetime.js';

const TOKEN_CACHE_KEY = 'flamingoland:idToken';
const DESTINATION_ID = 'flamingoland';
const PARK_ID = 'flamingoland-park';

type FsValue = {
  stringValue?: string;
  integerValue?: string;
  doubleValue?: number;
  booleanValue?: boolean;
  nullValue?: null;
  arrayValue?: {values?: FsValue[]};
  mapValue?: {fields?: Record<string, FsValue>};
  referenceValue?: string;
  timestampValue?: string;
};

type FsDoc = {
  name: string;
  fields?: Record<string, FsValue>;
};

export type Marker = {id: string; title: string; lat: number; lng: number; type: string};
export type SeasonWindow = {start: string; end: string; openHour: number};

export function isoDateInTimezone(date: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const y = parts.find(p => p.type === 'year')?.value;
  const m = parts.find(p => p.type === 'month')?.value;
  const d = parts.find(p => p.type === 'day')?.value;
  return `${y}-${m}-${d}`;
}

export function fsString(v?: FsValue): string | undefined {
  return v?.stringValue;
}
export function fsBool(v?: FsValue): boolean | undefined {
  return v?.booleanValue;
}
export function fsInt(v?: FsValue): number | undefined {
  let n: number | undefined;
  if (v?.integerValue !== undefined) {
    // Reject empty strings up-front — Number('') is 0, which would pollute set
    // membership checks (see CLAUDE.md "Numeric validation" rule).
    if (v.integerValue === '') return undefined;
    n = Number(v.integerValue);
  } else if (v?.doubleValue !== undefined) {
    n = v.doubleValue;
  }
  return n !== undefined && Number.isFinite(n) ? n : undefined;
}

// ===== Pure parsers / pure decision functions (separate so they're testable) =====

// Homepage banner pattern, e.g.
//   <div class="swiper-slide">Today the Theme Park will close at 5PM </div>
// Only "close at" is parsed — a morning "open at" banner exists but its time
// is the opening time, not the closing time, so reusing it would corrupt the
// schedule entry. Returns "HH:mm" 24-hour, or null if no closing banner.
export function parseTodayCloseBanner(html: string): string | null {
  const m = html.match(/Today the Theme Park will close at\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)/i);
  if (!m) return null;
  const hour12 = parseInt(m[1], 10);
  const minute = m[2] ? parseInt(m[2], 10) : 0;
  const isPM = m[3].toUpperCase() === 'PM';
  let hour24 = hour12 % 12;
  if (isPM) hour24 += 12;
  return `${String(hour24).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

// Webshop blurb, e.g. "Open daily from 10am between 21st March and 1st November 2026."
export function parseSeasonWindow(html: string): SeasonWindow | null {
  const m = html.match(
    /Open daily from\s+(\d{1,2})(am|pm)\s+between\s+(\d{1,2})(?:st|nd|rd|th)?\s+(\w+)\s+and\s+(\d{1,2})(?:st|nd|rd|th)?\s+(\w+)\s+(\d{4})/i,
  );
  if (!m) return null;
  const monthIndex = (name: string): number =>
    ['january','february','march','april','may','june','july','august','september','october','november','december'].indexOf(name.toLowerCase());
  const openHour12 = parseInt(m[1], 10);
  const openIsPM = m[2].toLowerCase() === 'pm';
  const openHour = (openHour12 % 12) + (openIsPM ? 12 : 0);
  const startMonth = monthIndex(m[4]);
  const endMonth = monthIndex(m[6]);
  if (startMonth < 0 || endMonth < 0) return null;
  const year = parseInt(m[7], 10);
  const fmt = (mo: number, day: number) => `${year}-${String(mo + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return {
    start: fmt(startMonth, parseInt(m[3], 10)),
    end: fmt(endMonth, parseInt(m[5], 10)),
    openHour,
  };
}

// /map/ page embeds a JS array
//   markersData = [{id: '216', title: 'Splash Battle', lat:.., lng:.., type:'ride'}, …]
export function parseMapMarkers(html: string): Marker[] {
  const out: Marker[] = [];
  // Each marker is a small object literal; capture id, title, lat, lng, type within
  // a single block. The 600-char window comfortably contains one entry.
  const re = /id:\s*'(\d+)',[\s\S]{0,600}?title:\s*'((?:[^'\\]|\\.)*)',[\s\S]{0,400}?lat:\s*(-?\d+(?:\.\d+)?),\s*lng:\s*(-?\d+(?:\.\d+)?)[\s\S]{0,400}?type:\s*'([^']*)'/g;
  for (const m of html.matchAll(re)) {
    const lat = parseFloat(m[3]);
    const lng = parseFloat(m[4]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    out.push({id: m[1], title: m[2].replace(/\\'/g, "'"), lat, lng, type: m[5]});
  }
  return out;
}

// Normalise titles for comparison — Firestore uses curly apostrophes
// ("Children's") while marker titles use straight ones.
function normTitle(s: string): string {
  return s.toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim();
}

// Tiered lookup: 1) parkMapMarkerId 2) exact title (case + apostrophe insensitive)
// 3) marker title that *starts with* the ride title. Where multiple candidates
// match, prefer the marker tagged type='ride' so a fuzzy lookup still picks the
// attraction over a same-named shop / kiosk.
export function findMarkerForRide(
  rideTitle: string,
  markerId: string | undefined,
  markers: Marker[],
): Marker | undefined {
  for (const m of markers) {
    if (markerId && m.id === markerId) return m;
  }
  const key = normTitle(rideTitle);
  let exact: Marker | undefined;
  for (const m of markers) {
    if (normTitle(m.title) !== key) continue;
    if (!exact || (exact.type !== 'ride' && m.type === 'ride')) exact = m;
  }
  if (exact) return exact;
  let prefix: Marker | undefined;
  for (const m of markers) {
    if (!normTitle(m.title).startsWith(key)) continue;
    if (!prefix || (prefix.type !== 'ride' && m.type === 'ride')) prefix = m;
  }
  return prefix;
}

// statusOpen=false → park-level closure (off-season, weather etc) → CLOSED.
// downAllDay=true → operational fault for the whole day → DOWN (ride out of
// service even though park is open).
// underMaintenance=true → planned refurbishment, takes precedence.
export function decideRideStatus(flags: {
  statusOpen: boolean;
  underMaintenance: boolean;
  downAllDay: boolean;
}): 'OPERATING' | 'CLOSED' | 'DOWN' | 'REFURBISHMENT' {
  if (flags.underMaintenance) return 'REFURBISHMENT';
  if (!flags.statusOpen) return 'CLOSED';
  if (flags.downAllDay) return 'DOWN';
  return 'OPERATING';
}

// Iterate from today (or season start, whichever is later) through season end
// inclusive. Today's close uses the scraped value; future days fall back to
// `defaultClose`. The `<=` on endMs keeps the season-end day in the list. The
// `maxDays` cap is a safety net.
export function iterateScheduleDays(opts: {
  todayStr: string;
  season: SeasonWindow;
  todayClose: string | null;
  defaultClose: string;
  timezone: string;
  maxDays?: number;
}): Array<{date: string; type: 'OPERATING'; openingTime: string; closingTime: string}> {
  const out: Array<{date: string; type: 'OPERATING'; openingTime: string; closingTime: string}> = [];
  const startStr = opts.season.start > opts.todayStr ? opts.season.start : opts.todayStr;
  const cursor = new Date(`${startStr}T00:00:00Z`);
  const endMs = Date.parse(`${opts.season.end}T00:00:00Z`);
  const max = opts.maxDays ?? 365;
  const openTime = `${String(opts.season.openHour).padStart(2, '0')}:00`;
  for (let i = 0; i < max && cursor.getTime() <= endMs; i++) {
    const dateStr = `${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, '0')}-${String(cursor.getUTCDate()).padStart(2, '0')}`;
    const closeTime = dateStr === opts.todayStr && opts.todayClose ? opts.todayClose : opts.defaultClose;
    out.push({
      date: dateStr,
      type: 'OPERATING',
      openingTime: constructDateTime(dateStr, openTime, opts.timezone),
      closingTime: constructDateTime(dateStr, closeTime, opts.timezone),
    });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

@destinationController({category: 'Flamingo Land'})
export class FlamingoLand extends Destination {
  @config apiKey: string = '';
  @config projectId: string = '';
  @config androidPackage: string = '';
  @config androidCert: string = '';
  @config email: string = '';
  @config password: string = '';
  @config timezone: string = 'Europe/London';

  constructor(options?: DestinationConstructor) {
    super(options);
    this.addConfigPrefix('FLAMINGOLAND');
  }

  private get firestoreBase(): string {
    return `https://firestore.googleapis.com/v1/projects/${this.projectId}/databases/(default)/documents`;
  }

  private get identityBase(): string {
    return 'https://identitytoolkit.googleapis.com/v1/accounts';
  }

  // ===== Authentication =====

  @cache({ttlSeconds: 60 * 50, key: TOKEN_CACHE_KEY})
  async getIdToken(): Promise<string> {
    if (!this.email || !this.password) {
      throw new Error('Flamingo Land requires FLAMINGOLAND_EMAIL and FLAMINGOLAND_PASSWORD to be set');
    }

    // The mobile app provisions an anonymous-style account on first launch. We
    // mirror that: sign-in first, sign-up only if EMAIL_NOT_FOUND. After the
    // first run the account exists and sign-up is never hit again.
    let resp = await this.fetchSignIn(this.email, this.password);
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      const code = err?.error?.message;
      if (code === 'EMAIL_NOT_FOUND') {
        resp = await this.fetchSignUp(this.email, this.password);
      }
    }
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data?.idToken) {
      throw new Error(`Flamingo Land auth failed: ${resp.status} ${JSON.stringify(data)}`);
    }
    return String(data.idToken);
  }

  @http({retries: 1})
  async fetchSignIn(email: string, password: string): Promise<HTTPObj> {
    return {
      method: 'POST',
      url: `${this.identityBase}:signInWithPassword?key=${this.apiKey}`,
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({email, password, returnSecureToken: true}),
      options: {json: false},
      tags: ['auth'],
    } as any as HTTPObj;
  }

  @http({retries: 1})
  async fetchSignUp(email: string, password: string): Promise<HTTPObj> {
    return {
      method: 'POST',
      url: `${this.identityBase}:signUp?key=${this.apiKey}`,
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({email, password, returnSecureToken: true}),
      options: {json: false},
      tags: ['auth'],
    } as any as HTTPObj;
  }

  // ===== Injectors =====

  @inject({
    eventName: 'httpRequest',
    hostname: {$in: ['firestore.googleapis.com', 'identitytoolkit.googleapis.com']},
  } as any)
  async injectAndroidClientHeaders(req: HTTPObj): Promise<void> {
    if (!this.androidPackage || !this.androidCert) return;
    req.headers = {
      ...req.headers,
      'X-Android-Package': this.androidPackage,
      'X-Android-Cert': this.androidCert,
    };
  }

  @inject({
    eventName: 'httpRequest',
    hostname: 'firestore.googleapis.com',
    tags: {$nin: ['auth']},
    priority: 1,
  } as any)
  async injectAuthToken(req: HTTPObj): Promise<void> {
    const token = await this.getIdToken();
    req.headers = {
      ...req.headers,
      'authorization': `Bearer ${token}`,
    };
  }

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

  // ===== HTTP Fetches =====

  @http({cacheSeconds: 60, retries: 2})
  async fetchCollectionPage(collection: string, pageToken: string | null): Promise<HTTPObj> {
    const params = new URLSearchParams({key: this.apiKey, pageSize: '300'});
    if (pageToken) params.set('pageToken', pageToken);
    return {
      method: 'GET',
      url: `${this.firestoreBase}/${collection}?${params.toString()}`,
      options: {json: true},
    } as any as HTTPObj;
  }

  private async readCollection(collection: string): Promise<FsDoc[]> {
    const out: FsDoc[] = [];
    let pageToken: string | null = null;
    // Firestore paginates — loop until exhausted. 300 per page matches app behaviour.
    // Small collections (all of Flamingo Land's data is <100 docs) mean usually a single page.
    for (let i = 0; i < 20; i++) {
      const resp = await this.fetchCollectionPage(collection, pageToken);
      const data = await resp.json();
      if (data?.documents) out.push(...(data.documents as FsDoc[]));
      pageToken = data?.nextPageToken || null;
      if (!pageToken) break;
    }
    return out;
  }

  @cache({ttlSeconds: 60})
  async getRides(): Promise<FsDoc[]> {
    return this.readCollection('rides_data');
  }

  @cache({ttlSeconds: 3600})
  async getRideCategories(): Promise<FsDoc[]> {
    return this.readCollection('ride_categories');
  }

  @http({cacheSeconds: 60 * 60, retries: 2})
  async fetchHomepage(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: 'https://www.flamingoland.co.uk/',
      options: {json: false},
    } as any as HTTPObj;
  }

  @http({cacheSeconds: 60 * 60 * 12, retries: 2})
  async fetchWebshopOverview(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: 'https://webshop.flamingoland.co.uk/Exhibitions/Overview/',
      options: {json: false},
    } as any as HTTPObj;
  }

  @http({cacheSeconds: 60 * 60 * 24, retries: 2})
  async fetchMapPage(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: 'https://www.flamingoland.co.uk/map/',
      options: {json: false},
    } as any as HTTPObj;
  }

  @cache({ttlSeconds: 60 * 60 * 24})
  async scrapeMarkers(): Promise<Marker[]> {
    const resp = await this.fetchMapPage();
    return parseMapMarkers(await resp.text());
  }

  // ===== Schedule scraping =====

  @cache({ttlSeconds: 60 * 30})
  async scrapeTodayCloseTime(): Promise<string | null> {
    const resp = await this.fetchHomepage();
    return parseTodayCloseBanner(await resp.text());
  }

  // Returns ISO date strings (not Date objects) so the @cache layer can
  // JSON-roundtrip safely.
  @cache({ttlSeconds: 60 * 60 * 12})
  async scrapeSeasonWindow(): Promise<SeasonWindow | null> {
    const resp = await this.fetchWebshopOverview();
    return parseSeasonWindow(await resp.text());
  }

  // ===== Shared filter =====

  // Filters rides_data to entries that represent real attractions (excludes
  // zone documents like "Dino-Stone Park" / "Children's Planet" which appear
  // in rides_data but have no map presence). Used by both buildEntityList
  // and buildLiveData so the two stay in sync.
  @cache({ttlSeconds: 60})
  async getAttractionRideIds(): Promise<string[]> {
    const [rides, categories, markers] = await Promise.all([
      this.getRides(),
      this.getRideCategories(),
      this.scrapeMarkers().catch(() => [] as Marker[]),
    ]);

    const validCategoryIds = new Set<number>();
    for (const cat of categories) {
      const id = fsInt(cat.fields?.id);
      if (id !== undefined) validCategoryIds.add(id);
    }

    const out: string[] = [];
    for (const doc of rides) {
      const id = doc.name.split('/').pop() || '';
      const title = fsString(doc.fields?.title);
      const catId = fsInt(doc.fields?.categoriesId);
      if (!id || !title) continue;
      if (catId !== undefined && validCategoryIds.size > 0 && !validCategoryIds.has(catId)) continue;
      // Defensive: if the marker scrape failed entirely (markers empty), fall
      // back to keeping every ride doc rather than dropping the lot.
      if (markers.length > 0) {
        const markerId = fsString(doc.fields?.parkMapMarkerId);
        if (!findMarkerForRide(decodeHtmlEntities(title), markerId || undefined, markers)) continue;
      }
      out.push(id);
    }
    return out;
  }

  // ===== Entities =====

  async getDestinations(): Promise<Entity[]> {
    return [{
      id: DESTINATION_ID,
      name: 'Flamingo Land Resort',
      entityType: 'DESTINATION',
      timezone: this.timezone,
      location: {latitude: 54.21112, longitude: -0.80845},
    } as Entity];
  }

  protected async buildEntityList(): Promise<Entity[]> {
    const [rides, validIdList, markers] = await Promise.all([
      this.getRides(),
      this.getAttractionRideIds(),
      this.scrapeMarkers().catch(() => [] as Marker[]),
    ]);
    const validIds = new Set(validIdList);

    const parkEntity: Entity = {
      id: PARK_ID,
      name: 'Flamingo Land',
      entityType: 'PARK',
      parentId: DESTINATION_ID,
      destinationId: DESTINATION_ID,
      timezone: this.timezone,
      location: {latitude: 54.21112, longitude: -0.80845},
    } as Entity;

    const attractions: Entity[] = [];
    for (const doc of rides) {
      const id = doc.name.split('/').pop() || '';
      if (!validIds.has(id)) continue;
      const title = fsString(doc.fields?.title);
      if (!title) continue;

      const entity: Entity = {
        id,
        name: decodeHtmlEntities(title),
        entityType: 'ATTRACTION',
        parentId: PARK_ID,
        parkId: PARK_ID,
        destinationId: DESTINATION_ID,
        timezone: this.timezone,
      } as Entity;

      const markerId = fsString(doc.fields?.parkMapMarkerId);
      const marker = findMarkerForRide(decodeHtmlEntities(title), markerId || undefined, markers);
      if (marker) {
        (entity as any).location = {latitude: marker.lat, longitude: marker.lng};
      }

      // The `restrictions` field on each ride doc carries the minimum height in cm
      // (e.g. 91.44 = 36"). Zero / missing means no restriction.
      const minHeightCm = fsInt(doc.fields?.restrictions);
      if (minHeightCm !== undefined && minHeightCm > 0) {
        (entity as any).tags = [TagBuilder.minimumHeight(Math.round(minHeightCm), 'cm')];
      }

      attractions.push(entity);
    }

    return [parkEntity, ...attractions];
  }

  // ===== Live Data =====

  protected async buildLiveData(): Promise<LiveData[]> {
    const [rides, categories, validIdList] = await Promise.all([
      this.getRides(),
      this.getRideCategories(),
      this.getAttractionRideIds(),
    ]);
    const validIds = new Set(validIdList);

    // Only rides whose category has showQueueTime=true emit waitTime; others are status-only.
    const queueCategories = new Set<number>();
    for (const cat of categories) {
      if (fsBool(cat.fields?.showQueueTime)) {
        const id = fsInt(cat.fields?.id);
        if (id !== undefined) queueCategories.add(id);
      }
    }

    const out: LiveData[] = [];
    for (const doc of rides) {
      const id = doc.name.split('/').pop() || '';
      if (!validIds.has(id)) continue;
      const title = fsString(doc.fields?.title);
      if (!title) continue;

      const status = decideRideStatus({
        statusOpen: fsBool(doc.fields?.statusOpen) ?? false,
        underMaintenance: fsBool(doc.fields?.underMaintenance) ?? false,
        downAllDay: fsBool(doc.fields?.downAllDay) ?? false,
      });
      const catId = fsInt(doc.fields?.categoriesId);

      const ld: LiveData = {id, status} as LiveData;

      if (status === 'OPERATING' && catId !== undefined && queueCategories.has(catId)) {
        const wt = fsInt(doc.fields?.queue_time);
        if (wt !== undefined && Number.isFinite(wt)) {
          ld.queue = {STANDBY: {waitTime: wt}};
        }
      }

      out.push(ld);
    }
    return out;
  }

  // ===== Schedules =====

  // No schedule API exists. The mobile app's Firestore source carries rides only,
  // and Remote Config has no published template. Two scrape sources fill the gap:
  // - homepage banner gives today's actual closing time
  // - webshop overview gives the season window ("Open daily from 10am between …")
  // Future in-season days fall back to a 10am–5pm default; we don't predict early
  // closures past today.
  protected async buildSchedules(): Promise<EntitySchedule[]> {
    const [season, todayClose] = await Promise.all([
      this.scrapeSeasonWindow().catch(() => null),
      this.scrapeTodayCloseTime().catch(() => null),
    ]);
    if (!season) return [{id: PARK_ID, schedule: []} as EntitySchedule];

    const schedule = iterateScheduleDays({
      todayStr: isoDateInTimezone(new Date(), this.timezone),
      season,
      todayClose,
      defaultClose: '17:00',
      timezone: this.timezone,
    });
    return [{id: PARK_ID, schedule} as EntitySchedule];
  }
}

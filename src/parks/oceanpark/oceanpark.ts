/**
 * Ocean Park Hong Kong
 *
 * Single destination with one park. Attractions, shows, and dining are fetched
 * from a mobile API (sop.oceanpark.com.hk) that requires a short-lived bearer
 * token ("optoken") in each request header.
 *
 * Coordinate data: The park app exposes a map at map.oceanpark.com.hk with
 * entity pixel positions. Reference points (pixel → lat/lng anchors) are
 * fetched and used to compute an affine transform so all entity coordinates
 * can be derived from their pixel positions.
 */

import crypto from 'crypto';
import {Destination, DestinationConstructor} from '../../destination.js';
import config from '../../config.js';
import {cache} from '../../cache.js';
import {http, HTTPObj} from '../../http.js';
import {inject} from '../../injector.js';
import {destinationController} from '../../destinationRegistry.js';
import {hostnameFromUrl, formatInTimezone, formatDate} from '../../datetime.js';
import {TagBuilder} from '../../tags/index.js';
import type {Entity, LiveData, EntitySchedule} from '@themeparks/typelib';
import {AttractionTypeEnum} from '@themeparks/typelib';

// ── Constants ───────────────────────────────────────────────────────────────

const TIMEZONE = 'Asia/Hong_Kong';
const DESTINATION_ID = 'oceanparkresort';
const PARK_ID = 'oceanpark';
const DEFAULT_LAT = 22.2465;
const DEFAULT_LNG = 114.1748;

/** Ocean Park entity sort IDs */
const SORT_ID = {
  TRANSPORT: 7,
  RIDES: 8,
  SHOWS: 15,
  DINING: 17,
} as const;

/** Map category slugs that contain entity pixel positions */
const MAP_CATEGORIES = ['attractions', 'animals', 'dining', 'transportations', 'shows', 'shops'] as const;

// ── API Interfaces ──────────────────────────────────────────────────────────

interface OceanParkTokenResponse {
  data?: {
    token?: string;
    tokenExpire?: number; // Unix ms expiry
  };
}

interface OceanParkCondition {
  conditionDesc?: string;
  description?: string;
}

interface OceanParkOperatingHour {
  openDate: string; // 'YYYY-MM-DD'
  openTime?: number; // Unix ms
  closeTime?: number; // Unix ms
}

interface OceanParkPflowInfo {
  entityStatus?: string; // 'open' | 'close' | etc.
  entityWaitTime?: number | null;
  operatingHourList?: OceanParkOperatingHour[];
}

interface OceanParkEntity {
  id: number;
  name: string;
  typeId?: number;
  extEntityCode?: string | number;
  conditionList?: Array<string | OceanParkCondition>;
  raFacilityType?: string;
  pflowInfo?: OceanParkPflowInfo;
}

interface OceanParkEntityListResponse {
  data?: {
    data?: OceanParkEntity[];
  };
}

interface OceanParkTimeSlot {
  startTime: number; // Unix ms
  endTime: number; // Unix ms
}

interface OceanParkActivity {
  timeList?: OceanParkTimeSlot[];
}

interface OceanParkEntityDetail {
  relateList?: Array<{type: string; [key: string]: unknown}>;
  activityList?: OceanParkActivity[];
}

interface OceanParkEntityDetailResponse {
  data?: OceanParkEntityDetail;
}

interface OceanParkParkDay {
  openDate: string; // 'YYYY-MM-DD'
  parkStatus: string; // 'open' | 'close' | etc.
  parkOpenTime?: string; // Unix ms as string
  parkCloseTime?: string; // Unix ms as string
  parkingOpenTime?: string;
  parkingCloseTime?: string;
  summitStaus?: string; // Note: typo in API
  summitCloseTime?: string;
}

interface OceanParkScheduleResponse {
  data?: {
    parkOperatingHourList?: OceanParkParkDay[];
  };
}

interface OceanParkReferencePoint {
  pixelX: number;
  pixelY: number;
  latitude: number;
  longitude: number;
}

interface OceanParkMapEntity {
  api_key?: string | number;
  x?: number;
  y?: number;
}

interface AffineCoeffs {
  a: number; b: number; c: number; // lat = a*x + b*y + c
  d: number; e: number; f: number; // lng = d*x + e*y + f
}

// ── Pure Functions ──────────────────────────────────────────────────────────

/**
 * Compute affine transform coefficients from a set of reference points.
 * Solves lat = a*x + b*y + c and lng = d*x + e*y + f using least-squares
 * normal equations (Cramer's rule on the 3×3 system).
 */
function computeAffineTransform(refPoints: OceanParkReferencePoint[]): AffineCoeffs {
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

/**
 * Parse height restriction values from a conditionList.
 * Supports patterns: "Height: 140cm" (min) and "Between 100cm and 140cm" (max).
 */
function parseHeightTag(conditionList: Array<string | OceanParkCondition>): {min: number | null; max: number | null} {
  let min: number | null = null;
  let max: number | null = null;

  for (const cond of conditionList) {
    const text = typeof cond === 'string' ? cond : (cond.conditionDesc ?? cond.description ?? '');

    const minMatch = text.match(/Height:\s*(\d+)\s*cm/i);
    if (minMatch) min = parseInt(minMatch[1], 10);

    const maxMatch = text.match(/Between\s*\d+\s*cm.*?and\s*(\d+)\s*cm/i);
    if (maxMatch) max = parseInt(maxMatch[1], 10);
  }

  return {min, max};
}

// ── Implementation ──────────────────────────────────────────────────────────

@destinationController({category: 'Ocean Park'})
@config
export class OceanParkHongKong extends Destination {
  @config baseURL: string = 'https://sop.oceanpark.com.hk';
  @config mapURL: string = 'https://map.oceanpark.com.hk';
  @config parkId: number = 1;

  timezone = TIMEZONE;

  constructor(options?: DestinationConstructor) {
    super(options);
    this.addConfigPrefix('OCEANPARK');
  }

  getCacheKeyPrefix(): string {
    return 'oceanpark';
  }

  // ── Initialisation ────────────────────────────────────────────────────────

  /** Pre-warm the token cache before entity/live data calls fire in parallel. */
  protected async _init(): Promise<void> {
    await this.getToken();
  }

  // ── Authentication ────────────────────────────────────────────────────────

  /**
   * Stable device UUID — generated once, persisted in SQLite for 3 months.
   * Ocean Park's API uses this to associate tokens with a logical device.
   */
  @cache({ttlSeconds: 60 * 60 * 24 * 90})
  async getDeviceId(): Promise<string> {
    return crypto.randomUUID();
  }

  /** Raw HTTP call to the token endpoint — tagged 'auth' to exclude from injection. */
  @http({tags: ['auth']} as any)
  async fetchToken(): Promise<HTTPObj> {
    const deviceId = await this.getDeviceId();
    return {
      method: 'POST',
      url: `${this.baseURL}/api/common/user/token`,
      body: JSON.stringify({pId: this.parkId, lang: 'en', deviceId}),
      headers: {'content-type': 'application/json'},
      options: {json: false},
      tags: ['auth'],
    } as any as HTTPObj;
  }

  /**
   * Auth token with dynamic TTL.
   * Returns an object with `token` + `ttl` so @cache can read the expiry.
   * Use getToken() to obtain just the token string.
   */
  @cache({callback: (result: {token: string; ttl: number}) => result.ttl})
  async getTokenData(): Promise<{token: string; ttl: number}> {
    const resp = await this.fetchToken();
    const body: OceanParkTokenResponse = await resp.json();
    const token = body?.data?.token;
    const tokenExpire = body?.data?.tokenExpire;

    if (!token) throw new Error('OceanPark: failed to obtain auth token');

    const ttl = tokenExpire
      ? Math.max((tokenExpire - Date.now()) / 1000, 60)
      : 60 * 60 * 23;

    return {token, ttl};
  }

  /** Returns the current valid auth token. */
  async getToken(): Promise<string> {
    return (await this.getTokenData()).token;
  }

  /**
   * Inject the optoken header into every request to the main API domain,
   * except for the token endpoint itself (excluded via tags filter).
   */
  @inject({
    eventName: 'httpRequest',
    hostname: function(this: OceanParkHongKong) { return hostnameFromUrl(this.baseURL); },
    tags: {$nin: ['auth']},
  } as any)
  async injectToken(req: HTTPObj): Promise<void> {
    const token = await this.getToken();
    req.headers = {
      ...req.headers,
      'optoken': token,
      'content-type': 'application/json',
    };
  }

  // ── HTTP Fetch Methods ────────────────────────────────────────────────────

  /**
   * Fetch the entity list for a given sortId.
   * sortId 7 = transport, 8 = rides, 15 = shows, 17 = dining.
   * Short cache (60s) since this also carries live wait-time data.
   */
  @http({cacheSeconds: 60} as any)
  async fetchEntityList(sortId: number): Promise<HTTPObj> {
    return {
      method: 'POST',
      url: `${this.baseURL}/api/common/entity/list`,
      body: JSON.stringify({pId: this.parkId, lang: 'en', sortId}),
      options: {json: false},
    } as any as HTTPObj;
  }

  /**
   * Fetch detailed info for a single entity (FastPass links, show schedule).
   * Long cache (1h) since this data changes infrequently.
   */
  @http({cacheSeconds: 3600} as any)
  async fetchEntityDetail(entityId: number): Promise<HTTPObj> {
    return {
      method: 'POST',
      url: `${this.baseURL}/api/common/entity/detail`,
      body: JSON.stringify({pId: this.parkId, lang: 'en', entityId}),
      options: {json: false},
    } as any as HTTPObj;
  }

  /** Fetch 30-day park operating schedule. Refreshed every hour. */
  @http({cacheSeconds: 3600} as any)
  async fetchParkSchedule(): Promise<HTTPObj> {
    const today = formatDate(new Date(), TIMEZONE);
    const end = formatDate(new Date(Date.now() + 30 * 24 * 3600 * 1000), TIMEZONE);
    return {
      method: 'POST',
      url: `${this.baseURL}/api/common/park/list`,
      body: JSON.stringify({pId: this.parkId, lang: 'en', startDate: today, endDate: end}),
      options: {json: false},
    } as any as HTTPObj;
  }

  /** Fetch reference points (pixel → lat/lng anchors) from the map subdomain. */
  @http({cacheSeconds: 86400} as any)
  async fetchReferencePoints(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.mapURL}/assets/data/reference_points.json`,
      options: {json: true},
    } as any as HTTPObj;
  }

  /** Fetch entity pixel positions for a given map category. */
  @http({cacheSeconds: 86400} as any)
  async fetchMapCategoryData(category: string): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.mapURL}/assets/data/${category}.json`,
      options: {json: true},
    } as any as HTTPObj;
  }

  // ── Cached Accessors ──────────────────────────────────────────────────────

  @cache({ttlSeconds: 60})
  async getEntityList(sortId: number): Promise<OceanParkEntity[]> {
    const resp = await this.fetchEntityList(sortId);
    const body: OceanParkEntityListResponse = await resp.json();
    return body?.data?.data ?? [];
  }

  @cache({ttlSeconds: 3600})
  async getEntityDetail(entityId: number): Promise<OceanParkEntityDetail> {
    const resp = await this.fetchEntityDetail(entityId);
    const body: OceanParkEntityDetailResponse = await resp.json();
    return body?.data ?? {};
  }

  @cache({ttlSeconds: 3600})
  async getParkSchedule(): Promise<OceanParkParkDay[]> {
    const resp = await this.fetchParkSchedule();
    const body: OceanParkScheduleResponse = await resp.json();
    return body?.data?.parkOperatingHourList ?? [];
  }

  /**
   * Build a serialisable map from api_key → {latitude, longitude} by:
   * 1. Fetching reference points and computing an affine pixel→geo transform.
   * 2. Fetching each map category and projecting each entity's pixel position.
   *
   * Returned as an array of [key, value] pairs so @cache can serialise it.
   * Cached for 24 hours — map data is essentially static.
   */
  @cache({ttlSeconds: 86400})
  async getCoordinateMapEntries(): Promise<[string, {latitude: number; longitude: number}][]> {
    const refResp = await this.fetchReferencePoints();
    const refPoints: OceanParkReferencePoint[] = await refResp.json();
    if (!Array.isArray(refPoints) || refPoints.length < 3) return [];

    const coeffs = computeAffineTransform(refPoints);
    const entries: [string, {latitude: number; longitude: number}][] = [];

    for (const category of MAP_CATEGORIES) {
      const resp = await this.fetchMapCategoryData(category);
      const entities: OceanParkMapEntity[] = await resp.json();
      if (!Array.isArray(entities)) continue;

      for (const e of entities) {
        if (e.api_key != null && e.x != null && e.y != null) {
          entries.push([
            String(e.api_key),
            {
              latitude:  coeffs.a * e.x + coeffs.b * e.y + coeffs.c,
              longitude: coeffs.d * e.x + coeffs.e * e.y + coeffs.f,
            },
          ]);
        }
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
    const [rides, transport, shows, dining, coordEntries] = await Promise.all([
      this.getEntityList(SORT_ID.RIDES),
      this.getEntityList(SORT_ID.TRANSPORT),
      this.getEntityList(SORT_ID.SHOWS),
      this.getEntityList(SORT_ID.DINING),
      this.getCoordinateMapEntries(),
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

    // Fetch details for rides + transport to check for FastPass (relateList)
    const attractions = [...rides, ...transport];
    const details = await Promise.all(
      attractions.map(e => this.getEntityDetail(e.id).catch(() => ({} as OceanParkEntityDetail))),
    );

    const attractionEntities: Entity[] = attractions.map((entity, i) => {
      const isTransport = entity.typeId === SORT_ID.TRANSPORT;
      const coords = coordMap.get(String(entity.extEntityCode));
      const detail = details[i];
      const tags = [];

      if (coords) {
        tags.push(TagBuilder.location(coords.latitude, coords.longitude, 'Attraction Location'));
      }

      const conditionList = entity.conditionList ?? [];
      const {min, max} = parseHeightTag(conditionList);
      if (min !== null) tags.push(TagBuilder.minimumHeight(min, 'cm'));
      if (max !== null) tags.push(TagBuilder.maximumHeight(max, 'cm'));

      const hasPregnantWarning = conditionList.some(c => {
        const text = typeof c === 'string' ? c : (c.conditionDesc ?? c.description ?? '');
        return /pregnant/i.test(text);
      });
      if (hasPregnantWarning) tags.push(TagBuilder.unsuitableForPregnantPeople());

      if (entity.raFacilityType === 'Wet Rides') tags.push(TagBuilder.mayGetWet());

      const hasFastPass = Array.isArray(detail?.relateList) &&
        detail.relateList.some(r => r.type === 'ticket');
      if (hasFastPass) tags.push(TagBuilder.paidReturnTime());

      const built: Entity = {
        id: `attraction_${entity.id}`,
        name: entity.name,
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

    const showEntities: Entity[] = shows.map(entity => {
      const coords = coordMap.get(String(entity.extEntityCode));
      return {
        id: `show_${entity.id}`,
        name: entity.name,
        entityType: 'SHOW',
        parentId: PARK_ID,
        destinationId: DESTINATION_ID,
        timezone: TIMEZONE,
        location: coords ?? {latitude: DEFAULT_LAT, longitude: DEFAULT_LNG},
      } as Entity;
    });

    const restaurantEntities: Entity[] = dining.map(entity => {
      const coords = coordMap.get(String(entity.extEntityCode));
      return {
        id: `restaurant_${entity.id}`,
        name: entity.name,
        entityType: 'RESTAURANT',
        parentId: PARK_ID,
        destinationId: DESTINATION_ID,
        timezone: TIMEZONE,
        location: coords ?? {latitude: DEFAULT_LAT, longitude: DEFAULT_LNG},
      } as Entity;
    });

    return [park, ...attractionEntities, ...showEntities, ...restaurantEntities];
  }

  // ── Live Data ─────────────────────────────────────────────────────────────

  protected async buildLiveData(): Promise<LiveData[]> {
    const today = formatDate(new Date(), TIMEZONE);

    const [rides, transport, shows] = await Promise.all([
      this.getEntityList(SORT_ID.RIDES),
      this.getEntityList(SORT_ID.TRANSPORT),
      this.getEntityList(SORT_ID.SHOWS),
    ]);

    const liveData: LiveData[] = [];

    // Rides and transport — include wait time and today's operating hours when open
    for (const entity of [...rides, ...transport]) {
      const pflow = entity.pflowInfo ?? {};
      const isOpen = pflow.entityStatus === 'open';
      const waitTime = pflow.entityWaitTime;

      const ld: LiveData = {
        id: `attraction_${entity.id}`,
        status: isOpen ? 'OPERATING' : 'CLOSED',
      } as LiveData;

      if (isOpen && waitTime != null && waitTime >= 0) {
        ld.queue = {STANDBY: {waitTime}};
      }

      const todayHours = (pflow.operatingHourList ?? []).find(
        h => h.openDate === today && h.openTime && h.closeTime,
      );
      if (todayHours) {
        ld.operatingHours = [{
          type: 'Operating',
          startTime: new Date(todayHours.openTime!).toISOString(),
          endTime: new Date(todayHours.closeTime!).toISOString(),
        }];
      }

      liveData.push(ld);
    }

    // Shows — include showtimes from entity detail activityList
    const showDetails = await Promise.all(
      shows.map(e => this.getEntityDetail(e.id).catch(() => ({} as OceanParkEntityDetail))),
    );

    for (let i = 0; i < shows.length; i++) {
      const entity = shows[i];
      const isOpen = entity.pflowInfo?.entityStatus === 'open';
      const detail = showDetails[i];

      const showtimes = (detail.activityList ?? []).flatMap(activity =>
        (activity.timeList ?? []).map(t => ({
          type: 'Performance Time',
          startTime: new Date(t.startTime).toISOString(),
          endTime: new Date(t.endTime).toISOString(),
        })),
      );

      const ld: LiveData = {
        id: `show_${entity.id}`,
        status: isOpen ? 'OPERATING' : 'CLOSED',
      } as LiveData;

      if (showtimes.length > 0) ld.showtimes = showtimes;

      liveData.push(ld);
    }

    return liveData;
  }

  // ── Schedules ─────────────────────────────────────────────────────────────

  protected async buildSchedules(): Promise<EntitySchedule[]> {
    const parkDays = await this.getParkSchedule();
    const scheduleEntries: object[] = [];

    for (const day of parkDays) {
      if (day.parkStatus !== 'open') continue;
      if (!day.parkOpenTime || !day.parkCloseTime) continue;

      scheduleEntries.push({
        date: day.openDate,
        type: 'OPERATING',
        openingTime: formatInTimezone(new Date(Number(day.parkOpenTime)), TIMEZONE, 'iso'),
        closingTime: formatInTimezone(new Date(Number(day.parkCloseTime)), TIMEZONE, 'iso'),
      });

      if (day.parkingOpenTime && day.parkingCloseTime) {
        scheduleEntries.push({
          date: day.openDate,
          type: 'INFORMATIONAL',
          description: 'Parking',
          openingTime: formatInTimezone(new Date(Number(day.parkingOpenTime)), TIMEZONE, 'iso'),
          closingTime: formatInTimezone(new Date(Number(day.parkingCloseTime)), TIMEZONE, 'iso'),
        });
      }

      // The Summit zone closes earlier than the main park on some days
      if (
        day.summitStaus === 'open' &&
        day.summitCloseTime &&
        Number(day.summitCloseTime) < Number(day.parkCloseTime)
      ) {
        scheduleEntries.push({
          date: day.openDate,
          type: 'INFORMATIONAL',
          description: 'The Summit',
          openingTime: formatInTimezone(new Date(Number(day.parkOpenTime)), TIMEZONE, 'iso'),
          closingTime: formatInTimezone(new Date(Number(day.summitCloseTime)), TIMEZONE, 'iso'),
        });
      }
    }

    return [{
      id: PARK_ID,
      schedule: scheduleEntries,
    } as unknown as EntitySchedule];
  }
}

import crypto from 'crypto';
import {Destination, DestinationConstructor} from '../../destination.js';
import {cache} from '../../cache.js';
import {http, HTTPObj} from '../../http.js';
import {inject} from '../../injector.js';
import config from '../../config.js';
import {destinationController} from '../../destinationRegistry.js';
import {hostnameFromUrl} from '../../datetime.js';
import {Entity, LiveData, EntitySchedule} from '@themeparks/typelib';

// ─── Constants ────────────────────────────────────────────────────────────────

const DESTINATION_ID = 'universalsingapore';
const PARK_ID = 'uss.uss';
const PARK_DB_ID = 1; // ParkList.Id for USS
const TIMEZONE = 'Asia/Singapore';

// Categories to fetch for entity building and live data
const ENTITY_CATEGORIES = [1, 2, 3] as const; // Rides, Shows, Meet & Greets

// Map category ID → entityType
const CATEGORY_ENTITY_TYPE: Record<number, Entity['entityType']> = {
  1: 'ATTRACTION', // Rides
  2: 'SHOW',       // Shows
  3: 'ATTRACTION', // Meet & Greets
};

// ─── API types ────────────────────────────────────────────────────────────────

type USSAttraction = {
  AttractionId: number;
  AttractionCategoryId: number;
  Title: string;
  /** Live wait time as string: "15" (minutes) when park open, "10:00AM" (opening time) when closed */
  WaitTime: string;
  isWaitTimeEnable: boolean;
  IsAvailable: boolean;
  AvgTime: number;
  LatLng: string; // "103.8215,1.2539" — lng,lat order
  ReasonCode: string;
};

type USSAttractionListResponse = {
  StatusCode: number;
  Result: USSAttraction[];
};

type USSAuthResponse = {
  StatusCode: number;
  Result: {
    Token: string;
  };
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build timestamp string in YYYYMMDDHHMMSS format (API cache-buster) */
function nowTimestamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    now.getFullYear() +
    pad(now.getMonth() + 1) +
    pad(now.getDate()) +
    pad(now.getHours()) +
    pad(now.getMinutes()) +
    pad(now.getSeconds())
  );
}

/**
 * Parse wait time from the WaitTime string.
 * Returns minutes as a number when the string is numeric ("15" → 15),
 * or null when it's a time-of-day string ("10:00AM" → null).
 */
function parseWaitTime(waitTimeStr: string): number | null {
  const minutes = parseInt(waitTimeStr, 10);
  if (!isNaN(minutes) && minutes >= 0 && String(minutes) === waitTimeStr.trim()) {
    return minutes;
  }
  return null;
}

/**
 * Parse LatLng string in "lng,lat" order.
 * Returns {latitude, longitude} or undefined if malformed.
 */
function parseLatLng(latlng: string): {latitude: number; longitude: number} | undefined {
  const parts = latlng.split(',').map((s) => parseFloat(s.trim()));
  if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
    return {latitude: parts[1], longitude: parts[0]};
  }
  return undefined;
}

/**
 * Dart-compatible ISO 8601 string with microseconds (27 chars).
 * Dart's toIso8601String() emits microseconds; JS only has ms, so we pad with 000.
 * e.g. "2026-04-02T20:03:27.372503Z"
 */
function dartIsoString(): string {
  return new Date().toISOString().replace(/(\.\d{3})Z$/, '$1000Z');
}

/** AES-256-CBC encrypt with PKCS7, fixed key+IV, returns base64 ciphertext */
function aesEncrypt(plaintext: string, key: Buffer, iv: Buffer): string {
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]).toString('base64');
}

// ─── Implementation ───────────────────────────────────────────────────────────

@destinationController({category: 'Universal'})
export class UniversalSingapore extends Destination {
  @config
  apiBase: string = '';

  @config
  appVersion: string = '2.1.2';

  @config
  aesKey: string = '';

  @config
  aesIv: string = '';

  @config
  hmacSecret: string = '';

  timezone = TIMEZONE;

  constructor(options?: DestinationConstructor) {
    super(options);
    this.addConfigPrefix('UNIVERSALSINGAPORE');
  }

  // ─── Authentication ──────────────────────────────────────────────────────

  /** Stable device UUID — generated once, cached for 3 months in SQLite */
  @cache({ttlSeconds: 60 * 60 * 24 * 90})
  async getDeviceId(): Promise<string> {
    return crypto.randomUUID();
  }

  @http({tags: ['auth']} as any)
  async fetchToken(): Promise<HTTPObj> {
    const deviceId = await this.getDeviceId();
    return {
      method: 'POST',
      url: `${this.apiBase}/uniapi/api/v3/Guest/WithoutLogin`,
      body: JSON.stringify({
        deviceType: '1',
        deviceId,
        appVersion: this.appVersion,
        fcmToken: '',
        isNotificationAlert: true,
        languageId: 1,
        IpAddress: '192.168.1.1',
      }),
      headers: {
        'content-type': 'application/json; charset=UTF-8',
        'user-agent': `Universal SG/${this.appVersion}+33 (android)`,
      },
      tags: ['auth'],
    } as any as HTTPObj;
  }

  /** Bearer token cached for 11 hours (token expires in 12h) */
  @cache({ttlSeconds: 60 * 60 * 11})
  async getToken(): Promise<string> {
    const resp = await this.fetchToken();
    const data: USSAuthResponse = await resp.json();
    if (!data?.Result?.Token) {
      throw new Error('USS: failed to obtain auth token');
    }
    return data.Result.Token;
  }

  @inject({
    eventName: 'httpRequest',
    hostname: function(this: UniversalSingapore) { return hostnameFromUrl(this.apiBase); },
    tags: {$nin: ['auth']},
  } as any)
  async injectAuth(req: HTTPObj): Promise<void> {
    const token = await this.getToken();
    req.headers = {
      ...req.headers,
      'Authorization': `Bearer ${token}`,
    };
  }

  /** Build per-request signing headers (USS security scheme) */
  private buildSecurityHeaders(urlPath: string): Record<string, string> {
    const key = Buffer.from(this.aesKey, 'base64');
    const iv = Buffer.from(this.aesIv, 'base64');
    const isoTime = dartIsoString();
    const uuid = crypto.randomUUID();

    // X-Request-Id: AES(fresh-timestamp) — uses its own timestamp
    const requestId = aesEncrypt(dartIsoString(), key, iv);
    // X-Nonce: AES(uuid|isoTime)
    const nonce = aesEncrypt(`${uuid}|${isoTime}`, key, iv);
    // X-Signature: HMAC-SHA256("isoTime|uuid|urlPath")
    const signature = crypto
      .createHmac('sha256', this.hmacSecret)
      .update(`${isoTime}|${uuid}|${urlPath}`, 'utf8')
      .digest('base64');

    return {
      'X-Request-Id': requestId,
      'X-Timestamp': isoTime,
      'X-Nonce': nonce,
      'X-Signature': signature,
    };
  }

  /** Inject signing headers on every request to ama.rwsentosa.com */
  @inject({
    eventName: 'httpRequest',
    hostname: function(this: UniversalSingapore) { return hostnameFromUrl(this.apiBase); },
  } as any)
  async injectSigning(req: HTTPObj): Promise<void> {
    const urlPath = new URL(req.url).pathname.replace(/^\/uniapi/, '');
    const signingHeaders = this.buildSecurityHeaders(urlPath);
    req.headers = {
      ...req.headers,
      ...signingHeaders,
    };
  }

  // ─── HTTP fetch methods ──────────────────────────────────────────────────

  /** Fetch attractions for a given category. Timestamp is a cache-buster. */
  @http({} as any)
  async fetchAttractionList(categoryId: number): Promise<HTTPObj> {
    const ts = nowTimestamp();
    return {
      method: 'GET',
      url: `${this.apiBase}/uniapi/api/v2/Transaction/GetAttractionList/${PARK_DB_ID}/${categoryId}/${ts}`,
      headers: {
        'user-agent': `Universal SG/${this.appVersion}+33 (android)`,
        'content-type': 'application/json; charset=UTF-8',
      },
      options: {json: true},
    } as any as HTTPObj;
  }

  // ─── Cached accessors ────────────────────────────────────────────────────

  /** Entity data — long TTL since attraction names/IDs rarely change */
  @cache({ttlSeconds: 60 * 60 * 12})
  async getAttractionEntities(categoryId: number): Promise<USSAttraction[]> {
    const resp = await this.fetchAttractionList(categoryId);
    const data: USSAttractionListResponse = await resp.json();
    return data?.Result || [];
  }

  /** Live data — short TTL for up-to-date wait times */
  @cache({ttlSeconds: 60})
  async getAttractionLiveData(categoryId: number): Promise<USSAttraction[]> {
    const resp = await this.fetchAttractionList(categoryId);
    const data: USSAttractionListResponse = await resp.json();
    return data?.Result || [];
  }

  // ─── Destination ─────────────────────────────────────────────────────────

  async getDestinations(): Promise<Entity[]> {
    return [
      {
        id: DESTINATION_ID,
        name: 'Universal Studios Singapore',
        entityType: 'DESTINATION',
        timezone: TIMEZONE,
        location: {latitude: 1.2540, longitude: 103.8239},
      } as Entity,
    ];
  }

  // ─── Entity list ─────────────────────────────────────────────────────────

  protected async buildEntityList(): Promise<Entity[]> {
    const parkEntity: Entity = {
      id: PARK_ID,
      name: 'Universal Studios Singapore',
      entityType: 'PARK',
      parentId: DESTINATION_ID,
      destinationId: DESTINATION_ID,
      timezone: TIMEZONE,
      location: {latitude: 1.2540, longitude: 103.8239},
    } as Entity;

    const categoryData = await Promise.all(
      ENTITY_CATEGORIES.map((catId) => this.getAttractionEntities(catId)),
    );

    const attractionEntities: Entity[] = [];

    for (let i = 0; i < ENTITY_CATEGORIES.length; i++) {
      const catId = ENTITY_CATEGORIES[i];
      const entityType = CATEGORY_ENTITY_TYPE[catId];

      for (const attr of categoryData[i]) {
        const entity: Entity = {
          id: String(attr.AttractionId),
          name: attr.Title,
          entityType,
          parentId: PARK_ID,
          destinationId: DESTINATION_ID,
          timezone: TIMEZONE,
        } as Entity;

        const loc = parseLatLng(attr.LatLng);
        if (loc) entity.location = loc;

        attractionEntities.push(entity);
      }
    }

    return [parkEntity, ...attractionEntities];
  }

  // ─── Live data ────────────────────────────────────────────────────────────

  protected async buildLiveData(): Promise<LiveData[]> {
    const categoryData = await Promise.all(
      ENTITY_CATEGORIES.map((catId) => this.getAttractionLiveData(catId)),
    );

    const results: LiveData[] = [];

    for (let i = 0; i < ENTITY_CATEGORIES.length; i++) {
      for (const attr of categoryData[i]) {
        const status = attr.IsAvailable ? 'OPERATING' : 'CLOSED';
        const ld: LiveData = {id: String(attr.AttractionId), status} as LiveData;

        if (attr.isWaitTimeEnable && attr.IsAvailable) {
          // WaitTime is "15" (minutes) when live; fall back to AvgTime if non-numeric
          const waitTime = parseWaitTime(attr.WaitTime) ?? attr.AvgTime ?? undefined;
          ld.queue = {STANDBY: {waitTime: waitTime || undefined}};
        }

        results.push(ld);
      }
    }

    return results;
  }

  // ─── Schedules ────────────────────────────────────────────────────────────

  protected async buildSchedules(): Promise<EntitySchedule[]> {
    // No dated schedule endpoint available in this API — revisit when discovered
    return [];
  }
}

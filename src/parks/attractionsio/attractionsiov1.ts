/**
 * Attractions.io v1 API Integration (Merlin/Legoland parks)
 *
 * Supports 16 parks from the Merlin Entertainments and Legoland group using
 * the Attractions.io v1 API. Provides entity lists, real-time live data, and
 * operating-hour schedules.
 *
 * Authentication flow:
 *   POST {baseURL}installation  →  installation token (cached ~11 months)
 *   All subsequent requests carry:  Authorization: Attractions-Io api-key="…", installation-token="…"
 *
 * Entity data:
 *   GET {baseURL}data  →  202 (still generating) | 303 (redirect to ZIP)
 *   ZIP contains manifest.json (version info) and records.json (all POI data)
 *
 * Live data:
 *   GET https://live-data.attractions.io/{apiKey}.json  (public, no auth)
 *
 * Schedules:
 *   GET {calendarURL}  →  standard calendar JSON
 *
 * @module attractionsio/v1
 */

import {Destination, type DestinationConstructor} from '../../destination.js';
import config from '../../config.js';
import {http, type HTTPObj} from '../../http.js';
import {cache} from '../../cache.js';
import {inject} from '../../injector.js';
import {destinationController} from '../../destinationRegistry.js';
import {CacheLib, database} from '../../cache.js';
import {makeHttpRequest} from '../../httpProxy.js';
import {constructDateTime, addDays, formatInTimezone} from '../../datetime.js';
import {TagBuilder} from '../../tags/index.js';
import type {Entity, LiveData, EntitySchedule} from '@themeparks/typelib';
import AdmZip from 'adm-zip';
import crypto from 'node:crypto';

// ─────────────────────────────────────────────────────────────────────────────
// Language priority order for name extraction
// ─────────────────────────────────────────────────────────────────────────────

const LANG_PRIORITY = ['en-GB', 'en-US', 'en-AU', 'en-CA', 'es-419', 'de-DE', 'it'] as const;

/**
 * Extract a plain string from a name field that may be a string or a
 * multi-language object (e.g. { "en-GB": "Alton Towers", "de-DE": "…" }).
 */
function extractName(name: string | Record<string, string> | undefined): string {
  if (!name) return '';
  if (typeof name === 'string') return name.trim();

  for (const lang of LANG_PRIORITY) {
    if (name[lang]) return name[lang].trim();
  }

  const first = Object.values(name)[0];
  return first ? first.trim() : '';
}

// ─────────────────────────────────────────────────────────────────────────────
// Category names used for entity classification
// ─────────────────────────────────────────────────────────────────────────────

const ATTRACTION_CATEGORIES = [
  'Attractions',
  'Rides',
  'Water Rides',
  'Thrill Rides',
  'Coasters',
  'Intense Thrills',
  'Rides & Shows',
  'Thrills & Mini-Thrills',
  'RIDES',
  'Rides & Attractions',
];

const SHOW_CATEGORIES = ['Shows', 'Show', 'Live Shows'];

const RESTAURANT_CATEGORIES = [
  'Restaurants',
  'Fast Food',
  'Snacks',
  'Healthy Food',
  'Food',
  'Dining',
  'Food & Drink',
];

// ─────────────────────────────────────────────────────────────────────────────
// API response types
// ─────────────────────────────────────────────────────────────────────────────

type RecordItem = {
  _id: number;
  Name: string | Record<string, string>;
  Category?: number;
  DirectionsLocation?: string;
  Location?: string;
  MinimumHeightRequirement?: number;
  MinimumUnaccompaniedHeightRequirement?: number | null;
};

type CategoryRecord = {
  _id: number;
  Name: string | Record<string, string>;
  Parent?: number;
};

type ResortRecord = {
  _id: number;
  Name: string | Record<string, string>;
  DirectionsLocation?: string;
  Location?: string;
};

type RecordsData = {
  Resort: ResortRecord[];
  Item: RecordItem[];
  Category: CategoryRecord[];
};

type LiveDataRecord = {
  _id: number;
  IsOperational?: boolean;
  IsOpen?: boolean;
  QueueTime?: number | null;
};

type LiveDataResponse = {
  entities: {
    Item: {
      records: LiveDataRecord[];
    };
  };
};

type CalendarDay = {
  key: string;
  openingHours: string;
};

type CalendarLocation = {
  days: CalendarDay[];
};

type CalendarResponse = {
  Locations?: CalendarLocation[];
  locations?: CalendarLocation[];
};

type InstallationResponse = {
  token: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// Schedule time-format patterns
// ─────────────────────────────────────────────────────────────────────────────

type TimeParseResult = {openTime: string; closeTime: string} | null;

/**
 * Parse a raw "openingHours" string such as "9:30am - 7pm" or "10:00 - 17:00"
 * into a pair of HH:mm strings.  Returns null when the format is unrecognised.
 */
function parseOpeningHours(raw: string): TimeParseResult {
  // Format 1: 9:30am - 7pm
  const fmt1 = /^(\d{1,2}):(\d{2})([ap]m)\s*-\s*(\d{1,2})([ap]m)$/i.exec(raw.trim());
  if (fmt1) {
    let openH = parseInt(fmt1[1], 10);
    const openM = parseInt(fmt1[2], 10);
    let closeH = parseInt(fmt1[4], 10);
    const amPmOpen = fmt1[3].toLowerCase();
    const amPmClose = fmt1[5].toLowerCase();
    if (amPmOpen === 'pm' && openH !== 12) openH += 12;
    if (amPmClose === 'pm' && closeH !== 12) closeH += 12;
    if (amPmOpen === 'am' && openH === 12) openH = 0;
    if (amPmClose === 'am' && closeH === 12) closeH = 0;
    return {
      openTime: `${String(openH).padStart(2, '0')}:${String(openM).padStart(2, '0')}`,
      closeTime: `${String(closeH).padStart(2, '0')}:00`,
    };
  }

  // Format 2: 10am - 5pm
  const fmt2 = /^(\d{1,2})([ap]m)\s*-\s*(\d{1,2})([ap]m)$/i.exec(raw.trim());
  if (fmt2) {
    let openH = parseInt(fmt2[1], 10);
    let closeH = parseInt(fmt2[3], 10);
    const amPmOpen = fmt2[2].toLowerCase();
    const amPmClose = fmt2[4].toLowerCase();
    if (amPmOpen === 'pm' && openH !== 12) openH += 12;
    if (amPmClose === 'pm' && closeH !== 12) closeH += 12;
    if (amPmOpen === 'am' && openH === 12) openH = 0;
    if (amPmClose === 'am' && closeH === 12) closeH = 0;
    return {
      openTime: `${String(openH).padStart(2, '0')}:00`,
      closeTime: `${String(closeH).padStart(2, '0')}:00`,
    };
  }

  // Format 3: 10:00 - 17:00
  const fmt3 = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (fmt3) {
    const openH = parseInt(fmt3[1], 10);
    const openM = parseInt(fmt3[2], 10);
    const closeH = parseInt(fmt3[3], 10);
    const closeM = parseInt(fmt3[4], 10);
    return {
      openTime: `${String(openH).padStart(2, '0')}:${String(openM).padStart(2, '0')}`,
      closeTime: `${String(closeH).padStart(2, '0')}:${String(closeM).padStart(2, '0')}`,
    };
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Base class
// ─────────────────────────────────────────────────────────────────────────────

@config
class AttractionsIOV1 extends Destination {
  // ── @config properties (loaded from env with ATTRACTIONSIO_ prefix) ──────

  @config
  apiKey: string = '';

  @config
  baseURL: string = '';

  @config
  calendarURL: string = '';

  @config
  appBuild: number = 0;

  @config
  appVersion: string = '';

  @config
  deviceIdentifier: string = '123';

  // ── Instance properties set by subclass constructors ─────────────────────

  /** Destination-level entity ID (e.g. "altontowersresort") */
  destinationId: string = '';

  /** Park-level entity ID (e.g. "altontowers") */
  parkId: string = '';

  /** IANA timezone string */
  timezone: string = 'Europe/London';

  constructor(options?: DestinationConstructor) {
    super(options);

    // Pick up identity fields from constructor config
    if (options?.config) {
      const cfg = options.config;
      if (cfg.destinationId) {
        this.destinationId = Array.isArray(cfg.destinationId)
          ? cfg.destinationId[0]
          : cfg.destinationId;
      }
      if (cfg.parkId) {
        this.parkId = Array.isArray(cfg.parkId) ? cfg.parkId[0] : cfg.parkId;
      }
      if (cfg.timezone) {
        this.timezone = Array.isArray(cfg.timezone) ? cfg.timezone[0] : cfg.timezone;
      }
    }

    // Allow all Attractions.io parks to share a single env-var prefix
    this.addConfigPrefix('ATTRACTIONSIO');
  }

  /**
   * Use parkId as cache key prefix to prevent cross-park cache collisions when
   * multiple instances of AttractionsIOV1 exist simultaneously.
   */
  getCacheKeyPrefix(): string {
    return `attractionsiov1:${this.destinationId}`;
  }

  // ── Authentication ────────────────────────────────────────────────────────

  /**
   * Inject the Attractions-Io auth header onto every request going to the
   * base API hostname.  Requests tagged 'skipAuth' skip the token injection
   * (used for the initial installation call).
   */
  @inject({
    eventName: 'httpRequest',
    hostname: function(this: AttractionsIOV1) {
      if (!this.baseURL) return '';
      try {
        return new URL(this.baseURL).hostname;
      } catch {
        return '';
      }
    },
    tags: {$nin: ['skipAuth']},
  })
  async injectAuth(requestObj: HTTPObj): Promise<void> {
    const token = await this.getInstallationToken();
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');
    requestObj.headers = {
      ...requestObj.headers,
      'date': now,
      'authorization': `Attractions-Io api-key="${this.apiKey}", installation-token="${token}"`,
      'user-agent': 'okhttp/4.11.0',
    };
  }

  /**
   * Inject the api-key-only header for the skipAuth installation request.
   */
  @inject({
    eventName: 'httpRequest',
    hostname: function(this: AttractionsIOV1) {
      if (!this.baseURL) return '';
      try {
        return new URL(this.baseURL).hostname;
      } catch {
        return '';
      }
    },
    tags: {$in: ['skipAuth']},
  })
  async injectApiKeyOnly(requestObj: HTTPObj): Promise<void> {
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');
    requestObj.headers = {
      ...requestObj.headers,
      'date': now,
      'authorization': `Attractions-Io api-key="${this.apiKey}"`,
      'user-agent': 'okhttp/4.11.0',
    };
  }

  /**
   * POST to the installation endpoint to obtain a session token.
   * Cached for ~11 months (481,801 seconds).
   */
  @cache({ttlSeconds: 481801})
  async getInstallationToken(): Promise<string> {
    const resp = await this.fetchInstallation();
    const data: InstallationResponse = await resp.json();
    return data.token;
  }

  /**
   * HTTP method for the installation POST.
   * Tagged 'skipAuth' so only the api-key header is injected (no token yet).
   */
  @http()
  async fetchInstallation(): Promise<HTTPObj> {
    const deviceId = crypto.randomUUID();
    // The API expects application/x-www-form-urlencoded (needle's default for
    // object bodies). Sending as JSON causes 400 "App Build must be an integer"
    // because form-encoding stringifies numbers while JSON preserves them.
    const params = new URLSearchParams({
      user_identifier: deviceId,
      app_build: String(this.appBuild),
      app_version: this.appVersion,
      device_identifier: this.deviceIdentifier,
    });
    return {
      method: 'POST',
      url: `${this.baseURL}installation`,
      body: params.toString(),
      headers: {'Content-Type': 'application/x-www-form-urlencoded'},
      options: {json: false},
      tags: ['skipAuth'],
    } as any as HTTPObj;
  }

  // ── Entity / POI data (SQLite-backed persistent store) ───────────────────

  /**
   * Download and extract the asset ZIP file from the given URL.
   */
  private async downloadAssetPack(url: string): Promise<{
    manifestData: {version: string};
    recordsData: RecordsData;
  }> {
    const response = await makeHttpRequest({
      method: 'GET',
      url,
      headers: {
        'accept-encoding': 'identity', // raw ZIP bytes, no gzip
        'user-agent': 'okhttp/4.11.0',
      },
    });

    const buffer = Buffer.from(await response.arrayBuffer());
    const zip = new AdmZip(buffer);

    const manifestEntry = zip.getEntry('manifest.json');
    const recordsEntry = zip.getEntry('records.json');
    if (!manifestEntry) throw new Error('No manifest.json found in ZIP');
    if (!recordsEntry) throw new Error('No records.json found in ZIP');

    return {
      manifestData: JSON.parse(zip.readAsText(manifestEntry)),
      recordsData: JSON.parse(zip.readAsText(recordsEntry)),
    };
  }

  /**
   * Return the full POI dataset for this park.
   *
   * Data is stored in the `attractionsio_entities` SQLite table (one row per
   * record), not as a giant JSON blob. The @cache decorator memoises the
   * reconstructed RecordsData for 12 hours so we don't re-read from SQLite
   * on every call within that window. When the cache expires, _syncFromAPI()
   * checks for a new ZIP and applies deltas.
   */
  @cache({ttlSeconds: 60 * 60 * 12})
  async getPOIData(): Promise<RecordsData> {
    await this._syncFromAPI();
    return this._readEntitiesFromDB();
  }

  /**
   * Sync entity data from the Attractions.io API into the local SQLite store.
   *
   * Always fetches the /data endpoint without a version parameter so we get
   * the full ZIP (matching the mobile app pattern). If the manifest version
   * matches what we already have, we skip parsing. Otherwise we diff/upsert
   * every record: new items are inserted, existing items are updated, and
   * items missing from the new data are soft-deleted (removedAt set).
   */
  private async _syncFromAPI(depth = 0): Promise<void> {
    // Build auth headers
    const token = await this.getInstallationToken();
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');
    const authHeaders: Record<string, string> = {
      'date': now,
      'authorization': `Attractions-Io api-key="${this.apiKey}", installation-token="${token}"`,
      'accept-encoding': 'identity',
      'user-agent': 'okhttp/4.11.0',
    };

    const response = await makeHttpRequest({
      method: 'GET',
      url: `${this.baseURL}data`,
      headers: authHeaders,
    });

    if (response.status === 202) {
      if (depth >= 5) {
        throw new Error('AttractionsIO data generation still in progress after 5 attempts');
      }
      const waitSeconds = 10 * (depth + 1);
      console.log(
        `[AttractionsIOV1] 202 received for ${this.destinationId}, ` +
        `waiting ${waitSeconds}s (attempt ${depth + 1}/5)…`,
      );
      await new Promise(resolve => setTimeout(resolve, waitSeconds * 1000));
      return this._syncFromAPI(depth + 1);
    }

    if (response.status !== 303) {
      // 200/304/etc. — no new data. If we already have data in the DB, that's fine.
      const hasData = this._hasStoredEntities();
      if (!hasData) {
        throw new Error(
          `AttractionsIO returned ${response.status} but no stored data exists for ${this.destinationId}`,
        );
      }
      return;
    }

    // 303 — redirect to ZIP
    const zipUrl = response.headers.get('location');
    if (!zipUrl) {
      throw new Error('AttractionsIO 303 response missing Location header');
    }

    const {manifestData, recordsData} = await this.downloadAssetPack(zipUrl);

    // Check version — skip if we already have this exact version
    const storedVersion = this._getStoredVersion();
    if (storedVersion === manifestData.version) {
      return;
    }

    // Diff and upsert into SQLite
    this._diffAndUpsert(recordsData, manifestData.version);
  }

  // ── SQLite helpers ──────────────────────────────────────────────────────

  private _getStoredVersion(): string | null {
    const row = database
      .prepare('SELECT version FROM attractionsio_versions WHERE park_id = ?')
      .get(this.destinationId) as {version: string} | undefined;
    return row?.version ?? null;
  }

  private _hasStoredEntities(): boolean {
    const row = database
      .prepare(
        'SELECT COUNT(*) as cnt FROM attractionsio_entities WHERE park_id = ? AND removed_at IS NULL',
      )
      .get(this.destinationId) as {cnt: number};
    return row.cnt > 0;
  }

  /**
   * Read all active entities from SQLite and reconstruct the RecordsData shape.
   */
  private _readEntitiesFromDB(): RecordsData {
    const rows = database
      .prepare(
        'SELECT record_type, data FROM attractionsio_entities WHERE park_id = ? AND removed_at IS NULL',
      )
      .all(this.destinationId) as {record_type: string; data: string}[];

    const result: RecordsData = {Resort: [], Item: [], Category: []};
    for (const row of rows) {
      const parsed = JSON.parse(row.data);
      if (row.record_type === 'Resort') result.Resort.push(parsed);
      else if (row.record_type === 'Item') result.Item.push(parsed);
      else if (row.record_type === 'Category') result.Category.push(parsed);
    }
    return result;
  }

  /**
   * Diff incoming records against the SQLite store and apply changes.
   * New records are inserted, existing records are updated (and un-deleted
   * if they were previously soft-deleted), and records not present in the
   * new data are soft-deleted.
   */
  private _diffAndUpsert(data: RecordsData, version: string): void {
    const now = Date.now();

    // Read all existing entities for this park (including soft-deleted)
    const existing = database
      .prepare(
        'SELECT record_type, entity_id, removed_at FROM attractionsio_entities WHERE park_id = ?',
      )
      .all(this.destinationId) as {
      record_type: string;
      entity_id: string;
      removed_at: number | null;
    }[];
    const existingKeys = new Set(existing.map(e => `${e.record_type}:${e.entity_id}`));
    const existingRemoved = new Map(
      existing.filter(e => e.removed_at !== null).map(e => [`${e.record_type}:${e.entity_id}`, true]),
    );

    const seenKeys = new Set<string>();

    // Prepare statements
    const upsertStmt = database.prepare(`
      INSERT INTO attractionsio_entities (park_id, record_type, entity_id, data, last_version, removed_at, updated_at)
      VALUES (?, ?, ?, ?, ?, NULL, ?)
      ON CONFLICT (park_id, record_type, entity_id) DO UPDATE SET
        data = excluded.data,
        last_version = excluded.last_version,
        removed_at = NULL,
        updated_at = excluded.updated_at
    `);

    const softDeleteStmt = database.prepare(`
      UPDATE attractionsio_entities SET removed_at = ?, updated_at = ?
      WHERE park_id = ? AND record_type = ? AND entity_id = ? AND removed_at IS NULL
    `);

    const versionStmt = database.prepare(`
      INSERT OR REPLACE INTO attractionsio_versions (park_id, version, updated_at)
      VALUES (?, ?, ?)
    `);

    // Wrap in a transaction for atomicity
    database.exec('BEGIN');
    try {
      const recordTypes: Array<{type: keyof RecordsData; name: string}> = [
        {type: 'Resort', name: 'Resort'},
        {type: 'Category', name: 'Category'},
        {type: 'Item', name: 'Item'},
      ];

      for (const {type, name} of recordTypes) {
        const records = data[type] || [];
        for (const record of records) {
          const entityId = String(record._id);
          const key = `${name}:${entityId}`;
          seenKeys.add(key);
          upsertStmt.run(
            this.destinationId,
            name,
            entityId,
            JSON.stringify(record),
            version,
            now,
          );
        }
      }

      // Soft-delete records not in the new data
      for (const key of existingKeys) {
        if (!seenKeys.has(key) && !existingRemoved.has(key)) {
          const [recordType, entityId] = key.split(':');
          softDeleteStmt.run(now, now, this.destinationId, recordType, entityId);
        }
      }

      // Update stored version
      versionStmt.run(this.destinationId, version, now);

      database.exec('COMMIT');
    } catch (e) {
      database.exec('ROLLBACK');
      throw e;
    }
  }

  // ── Category helpers ──────────────────────────────────────────────────────

  /**
   * Return all category _ids matching a given category name, including
   * immediate child categories.
   */
  @cache({ttlSeconds: 60 * 60 * 2})
  async getCategoryIDs(categoryName: string): Promise<number[]> {
    const data = await this.getPOIData();
    const ids: number[] = [];

    const parents = data.Category.filter(
      c => extractName(c.Name) === categoryName
    );
    if (parents.length === 0) return [];

    for (const parent of parents) {
      ids.push(parent._id);
      // Add children
      data.Category.filter(c => c.Parent === parent._id).forEach(c => ids.push(c._id));
    }

    return ids;
  }

  /**
   * Collect all items belonging to any of the given category names.
   */
  private async getItemsForCategories(categoryNames: string[]): Promise<RecordItem[]> {
    const allCatIds: number[] = [];
    for (const name of categoryNames) {
      const ids = await this.getCategoryIDs(name);
      allCatIds.push(...ids);
    }

    const data = await this.getPOIData();
    return data.Item.filter(item => item.Category !== undefined && allCatIds.includes(item.Category));
  }

  // ── Live data ─────────────────────────────────────────────────────────────

  /**
   * Fetch the public live-data JSON (no auth required).
   * Cached for 1 minute.
   */
  @http({cacheSeconds: 60})
  async fetchLiveData(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `https://live-data.attractions.io/${this.apiKey}.json`,
      options: {json: true},
      tags: ['liveData'],
    } as any as HTTPObj;
  }

  // ── Schedule ──────────────────────────────────────────────────────────────

  /**
   * Fetch the calendar JSON from the configured calendarURL.
   * Cached for 2 hours.
   */
  @http({cacheSeconds: 60 * 60 * 2})
  async fetchCalendar(): Promise<HTTPObj> {
    // Calendar URLs are park websites (altontowers.com, gardaland.it, etc.)
    // which block non-browser User-Agents. Use a browser-like UA.
    return {
      method: 'GET',
      url: this.calendarURL,
      headers: {
        'user-agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36',
      },
      options: {json: true},
      tags: ['calendar'],
    } as any as HTTPObj;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Template Method implementations
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Return the single destination entity for this park.
   */
  async getDestinations(): Promise<Entity[]> {
    const data = await this.getPOIData();
    if (!data.Resort || data.Resort.length === 0) {
      throw new Error(`No resort data for ${this.destinationId}`);
    }

    const resort = data.Resort[0];
    const entity: Entity = {
      id: this.destinationId,
      name: extractName(resort.Name),
      entityType: 'DESTINATION',
      timezone: this.timezone,
    } as Entity;

    const loc = parseLocation(resort.DirectionsLocation || resort.Location);
    if (loc) entity.location = loc;

    return [entity];
  }

  protected async buildEntityList(): Promise<Entity[]> {
    const data = await this.getPOIData();

    if (!data.Resort || data.Resort.length === 0) {
      throw new Error(`No resort data for ${this.destinationId}`);
    }

    const resort = data.Resort[0];

    // Park entity — strip trailing " Resort" from name
    let parkName = extractName(resort.Name).replace(/\s*Resort$/, '');
    const parkEntity: Entity = {
      id: this.parkId,
      name: parkName,
      entityType: 'PARK',
      parentId: this.destinationId,
      destinationId: this.destinationId,
      timezone: this.timezone,
    } as Entity;

    const parkLoc = parseLocation(resort.DirectionsLocation || resort.Location);
    if (parkLoc) parkEntity.location = parkLoc;

    // Attractions
    const attractionItems = await this.getItemsForCategories(ATTRACTION_CATEGORIES);
    const attractionEntities = attractionItems.map(item =>
      buildItemEntity(item, this.parkId, this.destinationId, this.timezone, 'ATTRACTION')
    );

    // Shows
    const showItems = await this.getItemsForCategories(SHOW_CATEGORIES);
    const showEntities = showItems.map(item =>
      buildItemEntity(item, this.parkId, this.destinationId, this.timezone, 'SHOW')
    );

    // Restaurants
    const restaurantItems = await this.getItemsForCategories(RESTAURANT_CATEGORIES);
    const restaurantEntities = restaurantItems.map(item =>
      buildItemEntity(item, this.parkId, this.destinationId, this.timezone, 'RESTAURANT')
    );

    return [
      ...await this.getDestinations(),
      parkEntity,
      ...attractionEntities,
      ...showEntities,
      ...restaurantEntities,
    ];
  }

  protected async buildLiveData(): Promise<LiveData[]> {
    // Get known attraction entity IDs
    const entities = await this.getEntities();
    const attractionIds = new Set(
      entities
        .filter(e => e.entityType === 'ATTRACTION')
        .map(e => e.id)
    );

    const resp = await this.fetchLiveData();
    const raw: LiveDataResponse = await resp.json();

    const records: LiveDataRecord[] = raw?.entities?.Item?.records ?? [];

    const liveData: LiveData[] = [];

    for (const record of records) {
      const id = String(record._id);
      if (!attractionIds.has(id)) continue;

      // Determine status
      let status: 'OPERATING' | 'CLOSED' | 'DOWN' = record.IsOperational ? 'OPERATING' : 'CLOSED';
      if (record.IsOpen === false) {
        status = 'CLOSED';
      }

      const entry: LiveData = {
        id,
        status,
      };

      // Wait time (in seconds from API – convert to minutes)
      if (record.QueueTime !== undefined && record.QueueTime !== null) {
        if (typeof record.QueueTime === 'number' && Number.isFinite(record.QueueTime)) {
          entry.queue = {
            STANDBY: {waitTime: Math.floor(record.QueueTime / 60)},
          };
        }
      } else if (record.QueueTime === null) {
        entry.queue = {
          STANDBY: {waitTime: undefined},
        };
      }

      liveData.push(entry);
    }

    return liveData;
  }

  protected async buildSchedules(): Promise<EntitySchedule[]> {
    return this._buildCalendarSchedules();
  }

  /**
   * Parse the standard calendar API response into EntitySchedule[].
   * Shared by most parks; overridden by HeidePark and DjursSommerland.
   */
  protected async _buildCalendarSchedules(): Promise<EntitySchedule[]> {
    let calData: CalendarResponse;
    try {
      const resp = await this.fetchCalendar();
      calData = await resp.json();
    } catch {
      return [{id: this.parkId, schedule: []}];
    }

    const locations = calData?.Locations ?? calData?.locations ?? [];
    if (!locations.length) {
      return [{id: this.parkId, schedule: []}];
    }

    // Use the location with the most days (mirrors JS logic)
    let days: CalendarDay[] = locations[0].days ?? [];
    if (days.length === 0) {
      for (const loc of locations) {
        if ((loc.days?.length ?? 0) > days.length) {
          days = loc.days;
        }
      }
    }

    const schedule: Array<{
      date: string;
      type: 'OPERATING';
      openingTime: string;
      closingTime: string;
    }> = [];

    for (const day of days) {
      const dateStr = parseYYYYMMDD(day.key); // "20260330" → "2026-03-30"
      if (!dateStr) continue;

      const times = parseOpeningHours(day.openingHours);
      if (!times) continue;

      schedule.push({
        date: dateStr,
        type: 'OPERATING',
        openingTime: constructDateTime(dateStr, times.openTime, this.timezone),
        closingTime: constructDateTime(dateStr, times.closeTime, this.timezone),
      });
    }

    return [{id: this.parkId, schedule}];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Private helpers (module-level, not class members)
// ─────────────────────────────────────────────────────────────────────────────

/** Parse "lat,lng" string into a location object, or return undefined. */
function parseLocation(raw?: string): {latitude: number; longitude: number} | undefined {
  if (!raw) return undefined;
  try {
    const parts = raw.split(',').map(Number);
    if (parts.length >= 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
      return {latitude: parts[0], longitude: parts[1]};
    }
  } catch {
    // ignore
  }
  return undefined;
}

/** Convert "YYYYMMDD" to "YYYY-MM-DD". Returns null on invalid input. */
function parseYYYYMMDD(raw: string): string | null {
  if (!/^\d{8}$/.test(raw)) return null;
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}

/** Build a full Entity from a records.json Item. */
function buildItemEntity(
  item: RecordItem,
  parkId: string,
  destinationId: string,
  timezone: string,
  entityType: 'ATTRACTION' | 'SHOW' | 'RESTAURANT'
): Entity {
  const entity: Entity = {
    id: String(item._id),
    name: extractName(item.Name),
    entityType,
    parentId: parkId,
    parkId,
    destinationId,
    timezone,
  } as Entity;

  // Location — prefer DirectionsLocation, fall back to Location
  const loc = parseLocation(item.DirectionsLocation || item.Location);
  if (loc) entity.location = loc;

  // Tags
  const tags = [];

  if (typeof item.MinimumHeightRequirement === 'number') {
    const heightCm = Math.floor(item.MinimumHeightRequirement * 100);
    tags.push(TagBuilder.minimumHeight(heightCm, 'cm'));
  }

  if (
    item.MinimumUnaccompaniedHeightRequirement !== undefined &&
    item.MinimumUnaccompaniedHeightRequirement !== null &&
    typeof item.MinimumUnaccompaniedHeightRequirement === 'number'
  ) {
    const heightCm = Math.floor(item.MinimumUnaccompaniedHeightRequirement * 100);
    // Only add if different from the supervised minimum height
    if (
      typeof item.MinimumHeightRequirement !== 'number' ||
      Math.floor(item.MinimumUnaccompaniedHeightRequirement * 100) !==
        Math.floor(item.MinimumHeightRequirement * 100)
    ) {
      tags.push(TagBuilder.minimumHeightUnaccompanied(heightCm, 'cm'));
    }
  }

  if (tags.length > 0) {
    entity.tags = tags;
  }

  return entity;
}

// ─────────────────────────────────────────────────────────────────────────────
// Park subclasses
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Alton Towers Resort, Staffordshire, UK
 */
@destinationController({category: ['Merlin', 'Alton Towers']})
export class AltonTowers extends AttractionsIOV1 {
  constructor(options?: DestinationConstructor) {
    super({
      ...options,
      config: {
        destinationId: 'altontowersresort',
        parkId: 'altontowers',
        timezone: 'Europe/London',
        appBuild: 293 as any,
        appVersion: '5.3',
        ...options?.config,
      },
    });
  }
}

/**
 * Thorpe Park Resort, Surrey, UK
 */
@destinationController({category: ['Merlin', 'Thorpe Park']})
export class ThorpePark extends AttractionsIOV1 {
  constructor(options?: DestinationConstructor) {
    super({
      ...options,
      config: {
        destinationId: 'thorpeparkresort',
        parkId: 'thorpepark',
        timezone: 'Europe/London',
        appBuild: 299 as any,
        appVersion: '1.4',
        ...options?.config,
      },
    });
  }
}

/**
 * Chessington World of Adventures Resort, Surrey, UK
 */
@destinationController({category: ['Merlin', 'Chessington']})
export class ChessingtonWorldOfAdventures extends AttractionsIOV1 {
  constructor(options?: DestinationConstructor) {
    super({
      ...options,
      config: {
        destinationId: 'chessingtonworldofadventuresresort',
        parkId: 'chessingtonworldofadventures',
        timezone: 'Europe/London',
        appBuild: 178 as any,
        appVersion: '3.3',
        ...options?.config,
      },
    });
  }
}

/**
 * LEGOLAND Windsor Resort, Berkshire, UK
 */
@destinationController({category: ['Merlin', 'Legoland']})
export class LegolandWindsor extends AttractionsIOV1 {
  constructor(options?: DestinationConstructor) {
    super({
      ...options,
      config: {
        destinationId: 'legolandwindsorresort',
        parkId: 'legolandwindsor',
        timezone: 'Europe/London',
        appBuild: 113 as any,
        appVersion: '2.4',
        ...options?.config,
      },
    });
  }
}

/**
 * LEGOLAND Florida Resort, Winter Haven, FL
 */
@destinationController({category: ['Merlin', 'Legoland']})
export class LegolandOrlando extends AttractionsIOV1 {
  constructor(options?: DestinationConstructor) {
    super({
      ...options,
      config: {
        destinationId: 'legolandorlandoresort',
        parkId: 'legolandorlando',
        timezone: 'America/New_York',
        appBuild: 115 as any,
        appVersion: '1.6.1',
        ...options?.config,
      },
    });
  }
}

/**
 * LEGOLAND California Resort, Carlsbad, CA
 */
@destinationController({category: ['Merlin', 'Legoland']})
export class LegolandCalifornia extends AttractionsIOV1 {
  constructor(options?: DestinationConstructor) {
    super({
      ...options,
      config: {
        destinationId: 'legolandcaliforniaresort',
        parkId: 'legolandcalifornia',
        timezone: 'America/Los_Angeles',
        appBuild: 800000074 as any,
        appVersion: '8.4.11',
        ...options?.config,
      },
    });
  }
}

/**
 * LEGOLAND Billund Resort, Billund, Denmark
 */
@destinationController({category: ['Merlin', 'Legoland']})
export class LegolandBillund extends AttractionsIOV1 {
  constructor(options?: DestinationConstructor) {
    super({
      ...options,
      config: {
        destinationId: 'legolandbillundresort',
        parkId: 'legolandbillund',
        timezone: 'Europe/Copenhagen',
        appBuild: 162 as any,
        appVersion: '3.4.17',
        ...options?.config,
      },
    });
  }
}

/**
 * LEGOLAND Deutschland Resort, Günzburg, Germany
 */
@destinationController({category: ['Merlin', 'Legoland']})
export class LegolandDeutschland extends AttractionsIOV1 {
  constructor(options?: DestinationConstructor) {
    super({
      ...options,
      config: {
        destinationId: 'legolanddeutschlandresort',
        parkId: 'legolanddeutschland',
        timezone: 'Europe/Berlin',
        appBuild: 113 as any,
        appVersion: '1.4.15',
        ...options?.config,
      },
    });
  }
}

/**
 * Gardaland Resort, Castelnuovo del Garda, Italy
 */
@destinationController({category: ['Merlin', 'Gardaland']})
export class Gardaland extends AttractionsIOV1 {
  constructor(options?: DestinationConstructor) {
    super({
      ...options,
      config: {
        destinationId: 'gardalandresort',
        parkId: 'gardaland',
        timezone: 'Europe/Rome',
        appBuild: 119 as any,
        appVersion: '4.2',
        ...options?.config,
      },
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HeidePark — custom v2 schedule API
// ─────────────────────────────────────────────────────────────────────────────

type HeideParkOpeningTime = {
  date: string;
  status: string;
  openingTimes?: {
    open?: string;
    close?: string;
  };
};

type HeideParkScheduleResponse = {
  openingTimes?: HeideParkOpeningTime[];
};

@config
class HeideParkBase extends AttractionsIOV1 {
  /**
   * Fetch the v2 resort-opening-times endpoint (specific to HeidePark).
   * Cached for 2 hours.
   */
  @http({cacheSeconds: 60 * 60 * 2})
  async fetchHeideParkSchedule(startDate: string, endDate: string): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `https://api.attractions.io/v2/resort-opening-times?startDate=${startDate}&endDate=${endDate}`,
      options: {json: true},
      tags: ['calendar'],
    } as any as HTTPObj;
  }

  protected async buildSchedules(): Promise<EntitySchedule[]> {
    const now = new Date();
    const threeMonthsLater = addDays(now, 90);

    // formatInTimezone 'date' returns MM/DD/YYYY — convert to YYYY-MM-DD
    const startDate = formatInTimezone(now, this.timezone, 'date')
      .replace(/^(\d{2})\/(\d{2})\/(\d{4})$/, '$3-$1-$2');
    const endDate = formatInTimezone(threeMonthsLater, this.timezone, 'date')
      .replace(/^(\d{2})\/(\d{2})\/(\d{4})$/, '$3-$1-$2');

    let schedData: HeideParkScheduleResponse;
    try {
      const resp = await this.fetchHeideParkSchedule(startDate, endDate);
      schedData = await resp.json();
    } catch {
      return [{id: this.parkId, schedule: []}];
    }

    if (!schedData?.openingTimes || !Array.isArray(schedData.openingTimes)) {
      return [{id: this.parkId, schedule: []}];
    }

    const schedule: Array<{
      date: string;
      type: 'OPERATING';
      openingTime: string;
      closingTime: string;
    }> = [];

    for (const entry of schedData.openingTimes) {
      // Only include open days; skip days without valid times
      if (entry.status !== 'open') continue;
      if (!entry.openingTimes?.open || !entry.openingTimes?.close) continue;

      schedule.push({
        date: entry.date,
        type: 'OPERATING',
        openingTime: constructDateTime(entry.date, entry.openingTimes.open, this.timezone),
        closingTime: constructDateTime(entry.date, entry.openingTimes.close, this.timezone),
      });
    }

    return [{id: this.parkId, schedule}];
  }
}

/**
 * Heide Park Resort, Soltau, Germany
 */
@destinationController({category: ['Merlin', 'Heide Park']})
export class HeidePark extends HeideParkBase {
  constructor(options?: DestinationConstructor) {
    super({
      ...options,
      config: {
        destinationId: 'heideparkresort',
        parkId: 'heidepark',
        timezone: 'Europe/Berlin',
        appBuild: 302101 as any,
        appVersion: '4.2.6',
        ...options?.config,
      },
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Knoebels — no schedule API
// ─────────────────────────────────────────────────────────────────────────────

@config
class KnoebelsBase extends AttractionsIOV1 {
  protected async buildSchedules(): Promise<EntitySchedule[]> {
    // Knoebels has no machine-readable schedule API
    return [];
  }
}

/**
 * Knoebels Amusement Resort, Elysburg, PA
 */
@destinationController({category: ['Knoebels']})
export class Knoebels extends KnoebelsBase {
  constructor(options?: DestinationConstructor) {
    super({
      ...options,
      config: {
        destinationId: 'knoebels',
        parkId: 'knoebelspark',
        timezone: 'America/New_York',
        appBuild: 48 as any,
        appVersion: '1.1.2',
        ...options?.config,
      },
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DjursSommerland — HTML calendar scraping
// ─────────────────────────────────────────────────────────────────────────────

type DjursParkEvent = {
  type: number;
  start: string;
  end: string;
  description?: string;
  days?: {
    ranges: number[];
  };
};

type DjursCalendarModel = {
  parkEvents?: DjursParkEvent[];
};

@config
class DjursSommerlandBase extends AttractionsIOV1 {
  /**
   * Fetch the opening-hours page HTML.
   * Cached for 2 hours.
   */
  @http({cacheSeconds: 60 * 60 * 2})
  async fetchCalendarHTML(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: 'https://djurssommerland.dk/en/plan-your-trip/opening-hours/',
      tags: ['calendar'],
    } as any as HTTPObj;
  }

  protected async buildSchedules(): Promise<EntitySchedule[]> {
    let html: string;
    try {
      const resp = await this.fetchCalendarHTML();
      html = await resp.text();
    } catch {
      return [{id: this.parkId, schedule: []}];
    }

    // Extract data-model attribute from <body> tag
    const bodyMatch = html.match(/<body[^>]*\sdata-model=['"]([^'"]*)['"]/i);
    if (!bodyMatch) {
      return [{id: this.parkId, schedule: []}];
    }

    let calendarData: DjursCalendarModel;
    try {
      // The attribute value is HTML-entity encoded — decode basic entities
      const decoded = bodyMatch[1]
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
      calendarData = JSON.parse(decoded);
    } catch {
      return [{id: this.parkId, schedule: []}];
    }

    if (!calendarData.parkEvents || !Array.isArray(calendarData.parkEvents)) {
      return [{id: this.parkId, schedule: []}];
    }

    const schedule: Array<{
      date: string;
      type: string;
      openingTime: string;
      closingTime: string;
      description?: string;
    }> = [];

    const currentYear = new Date().getFullYear();

    for (const event of calendarData.parkEvents) {
      const {type, start, end, days} = event;
      if (!start || !end || !days?.ranges) continue;

      const startMatch = start.match(/^(\d{1,2}):(\d{2})/);
      const endMatch = end.match(/^(\d{1,2}):(\d{2})/);
      if (!startMatch || !endMatch) continue;

      const openHour = parseInt(startMatch[1], 10);
      const openMinute = parseInt(startMatch[2], 10);
      const closeHour = parseInt(endMatch[1], 10);
      const closeMinute = parseInt(endMatch[2], 10);

      const openTime = `${String(openHour).padStart(2, '0')}:${String(openMinute).padStart(2, '0')}`;
      const closeTime = `${String(closeHour).padStart(2, '0')}:${String(closeMinute).padStart(2, '0')}`;

      // type 1 = Regular, type 2 = Water park, type 4 = Magical Halloween
      const isWaterPark = type === 2;
      const isSpecialEvent = type === 4;
      const scheduleType = (isWaterPark || isSpecialEvent) ? 'INFO' : 'OPERATING';
      const description = isWaterPark
        ? 'Water Park'
        : isSpecialEvent
          ? (event.description || 'Magical Halloween')
          : undefined;

      for (const dayIndex of days.ranges) {
        // dayIndex encoding: monthIndex * 31 + (dayOfMonth - 1), monthIndex 0-based
        const month = Math.floor(dayIndex / 31);
        const day = (dayIndex % 31) + 1;

        // Validate day makes sense for the month
        const testDate = new Date(currentYear, month, day);
        if (testDate.getMonth() !== month || testDate.getDate() !== day) continue;

        const dateStr = `${currentYear}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

        const entry: {
          date: string;
          type: string;
          openingTime: string;
          closingTime: string;
          description?: string;
        } = {
          date: dateStr,
          type: scheduleType,
          openingTime: constructDateTime(dateStr, openTime, this.timezone),
          closingTime: constructDateTime(dateStr, closeTime, this.timezone),
        };

        if (description) entry.description = description;

        schedule.push(entry);
      }
    }

    // Sort by date then opening time
    schedule.sort((a, b) => {
      const dc = a.date.localeCompare(b.date);
      return dc !== 0 ? dc : a.openingTime.localeCompare(b.openingTime);
    });

    return [{id: this.parkId, schedule: schedule as any}];
  }
}

/**
 * Djurs Sommerland, Nimtofte, Denmark
 */
@destinationController({category: ['Djurs Sommerland']})
export class DjursSommerland extends DjursSommerlandBase {
  constructor(options?: DestinationConstructor) {
    super({
      ...options,
      config: {
        destinationId: 'djurs-sommerland-destination',
        parkId: 'djurs-sommerland',
        timezone: 'Europe/Copenhagen',
        appBuild: 169 as any,
        appVersion: '2.5.1',
        ...options?.config,
      },
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Remaining standard parks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * LEGOLAND Japan Resort, Nagoya, Japan
 */
@destinationController({category: ['Merlin', 'Legoland']})
export class LegolandJapan extends AttractionsIOV1 {
  constructor(options?: DestinationConstructor) {
    super({
      ...options,
      config: {
        destinationId: 'legolandjapanresort',
        parkId: 'legolandjapan',
        timezone: 'Asia/Tokyo',
        appBuild: 186 as any,
        appVersion: '1.4.24',
        ...options?.config,
      },
    });
  }
}

/**
 * LEGOLAND New York Resort, Goshen, NY
 */
@destinationController({category: ['Merlin', 'Legoland']})
export class LegolandNewYork extends AttractionsIOV1 {
  constructor(options?: DestinationConstructor) {
    super({
      ...options,
      config: {
        destinationId: 'legolandnewyorkdestination',
        parkId: 'legolandnewyork',
        timezone: 'America/New_York',
        appBuild: 217 as any,
        appVersion: '1.4.4',
        ...options?.config,
      },
    });
  }
}

/**
 * LEGOLAND Korea Resort, Chuncheon, South Korea
 */
@destinationController({category: ['Merlin', 'Legoland']})
export class LegolandKorea extends AttractionsIOV1 {
  constructor(options?: DestinationConstructor) {
    super({
      ...options,
      config: {
        destinationId: 'legolandkoreadestination',
        parkId: 'legolandkorea',
        timezone: 'Asia/Seoul',
        appBuild: 183 as any,
        appVersion: '1.2.3',
        ...options?.config,
      },
    });
  }
}

/**
 * Peppa Pig Theme Park Florida, Winter Haven, FL
 */
@destinationController({category: ['Merlin', 'Peppa Pig Theme Park']})
export class PeppaPigThemeParkFlorida extends AttractionsIOV1 {
  constructor(options?: DestinationConstructor) {
    super({
      ...options,
      config: {
        destinationId: 'peppapigthemeparkfloridadestination',
        parkId: 'peppapigthemeparkflorida',
        timezone: 'America/New_York',
        appBuild: 63 as any,
        appVersion: '1.0.16',
        ...options?.config,
      },
    });
  }
}

export {AttractionsIOV1};

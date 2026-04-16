import {Destination, DestinationConstructor} from '../../destination.js';
import {cache} from '../../cache.js';
import {http, HTTPObj} from '../../http.js';
import {inject} from '../../injector.js';
import config from '../../config.js';
import {destinationController} from '../../destinationRegistry.js';
import {
  Entity,
  LiveData,
  EntitySchedule,
} from '@themeparks/typelib';
import {formatInTimezone, addDays, isBefore, addMinutes, constructDateTime} from '../../datetime.js';
import {TagBuilder} from '../../tags/index.js';

// ─── Data types ──────────────────────────────────────────────────────────────

/** A single POI from the Europa-Park /api/v2/pois endpoint */
type EuropaParkPOI = {
  id: number;
  name: string;
  type: string;
  subtype?: string;
  queueing?: boolean;
  scopes?: string[];
  latitude?: number;
  longitude?: number;
  minHeight?: number;
  maxHeight?: number;
  code?: string;
  // showlocation sub-entities
  shows?: EuropaParkShow[];
  // virtual-queue companion data (injected during entity build)
  vQueue?: EuropaParkPOI;
};

/** A show entry nested inside a showlocation POI */
type EuropaParkShow = {
  id: number;
  name: string;
  duration?: number;
  code?: string;
  latitude?: number;
  longitude?: number;
};

/** Waiting-times API response item */
type EuropaParkWaitTime = {
  code: string;
  time: number;
  startAt?: string | null;
  endAt?: string | null;
};

/** Show-times API response item */
type EuropaParkShowTime = {
  showId: number;
  today: string[];
};

/** Season schedule item */
type EuropaParkSeason = {
  startAt: string;
  endAt: string;
  startAt_time?: string; // opening time component from the API
  endAt_time?: string;   // closing time component from the API
  scopes: string[];
  status: string;
  closed?: boolean;
  specialOpenTimes?: Array<{
    dateAt: string;
    startAt: string | null;
    endAt: string | null;
  }>;
  hotelStartAt?: string;
  hotelEndAt?: string;
};

/** Live calendar overlay for today */
type EuropaParkLiveCalendar = {
  today?: {
    date: string;
    start: string | null;
    end: string | null;
  };
};

// ─── Internal entity record (mirrors europaparkdb _getEntities output) ────────

type EuropaParkEntity = {
  id: string;
  name: string;
  entityType: 'ATTRACTION' | 'SHOW';
  scopes: string[];
  code?: string;
  vQueue?: EuropaParkPOI;
  duration?: number;
  latitude?: number;
  longitude?: number;
  minHeight?: number;
  maxHeight?: number;
};

// ─── Park config ──────────────────────────────────────────────────────────────

type EuropaParkConfig = {
  id: number;
  scope: string;
  name?: string;         // optional name override (e.g. Traumatica)
  poiType?: string;      // override for park-type lookup (e.g. eventlocation)
};

const PARK_CONFIGS: EuropaParkConfig[] = [
  {id: 493, scope: 'europapark'},
  {id: 494, scope: 'rulantica'},
  {id: 642, scope: 'traumatica', name: 'Traumatica', poiType: 'eventlocation'},
];

const DESTINATION_ID = 'europapark';
const TIMEZONE = 'Europe/Berlin';

// ─── Main class ───────────────────────────────────────────────────────────────

@config
class EuropaParkBase extends Destination {
  @config
  apiBase: string = '';

  @config
  authURL: string = '';

  @config
  clientId: string = '';

  @config
  clientSecret: string = '';

  @config
  appVersion: string = '16.0.0';

  timezone: string = TIMEZONE;

  constructor(options?: DestinationConstructor) {
    super(options);
    this.addConfigPrefix('EUROPAPARK');
  }

  // ─── Authentication ──────────────────────────────────────────────────────

  /** Inject Bearer token + User-Agent into all API requests */
  @inject({
    eventName: 'httpRequest',
    hostname: function(this: EuropaPark) {
      return new URL(this.apiBase).hostname;
    },
    tags: {$nin: ['auth']},
  })
  async injectAuth(req: HTTPObj): Promise<void> {
    const {token} = await this.getToken();
    req.headers = {
      ...req.headers,
      'authorization': `Bearer ${token}`,
      'accept-language': 'en',
      'user-agent': `EuropaParkApp/${this.appVersion} (Android)`,
    };
  }

  /** Inject User-Agent on auth endpoint too */
  @inject({
    eventName: 'httpRequest',
    hostname: function(this: EuropaPark) {
      return new URL(this.authURL).hostname;
    },
    tags: {$in: ['auth']},
  })
  async injectAuthUA(req: HTTPObj): Promise<void> {
    req.headers = {
      ...req.headers,
      'user-agent': `EuropaParkApp/${this.appVersion} (Android)`,
    };
  }

  /** Clear cached token on 401 */
  @inject({
    eventName: 'httpError',
    hostname: function(this: EuropaPark) {
      return new URL(this.apiBase).hostname;
    },
  })
  async handleUnauthorized(req: HTTPObj): Promise<void> {
    if (req.response?.status === 401) {
      const {CacheLib} = await import('../../cache.js');
      await CacheLib.delete(`${this.constructor.name}:getToken:[]`);
    }
  }

  /** Fetch OAuth2 token (form-encoded POST, like needle default) */
  @http({tags: ['auth']} as any)
  async fetchToken(): Promise<HTTPObj> {
    const params = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      grant_type: 'client_credentials',
    });

    return {
      method: 'POST',
      url: this.authURL,
      body: params.toString(),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      tags: ['auth'],
    } as any as HTTPObj;
  }

  /** Cached OAuth2 token – expires according to API-supplied expires_in */
  @cache({callback: (resp: {token: string; expiresIn: number}) => resp?.expiresIn || 86400})
  async getToken(): Promise<{token: string; expiresIn: number}> {
    const resp = await this.fetchToken();
    const data: any = await resp.json();
    if (!data?.access_token) {
      throw new Error(`Europa-Park: failed to obtain access_token`);
    }
    return {
      token: data.access_token,
      expiresIn: (data.expires_in as number) || 86400,
    };
  }

  // ─── API fetch methods ────────────────────────────────────────────────────

  /** Fetch ALL POI data – large, so cache for 12 hours */
  @http({cacheSeconds: 60 * 60 * 12} as any)
  async fetchPOIs(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.apiBase}/api/v2/pois?status[]=live`,
      options: {json: true},
      tags: [],
    } as any as HTTPObj;
  }

  /** Waiting-times endpoint – cache 1 minute */
  @http({cacheSeconds: 60} as any)
  async fetchWaitingTimes(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.apiBase}/api/v2/waiting-times`,
      options: {json: true},
      tags: [],
    } as any as HTTPObj;
  }

  /** Season schedule endpoint – cache 6 hours */
  @http({cacheSeconds: 60 * 60 * 6} as any)
  async fetchSeasons(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.apiBase}/api/v2/seasons?status[]=live`,
      options: {json: true},
      tags: [],
    } as any as HTTPObj;
  }

  /** Live calendar overlay for today (europapark scope only) – cache 5 minutes */
  @http({cacheSeconds: 60 * 5} as any)
  async fetchLiveCalendar(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.apiBase}/api/v2/season-opentime-details/europapark`,
      options: {json: true},
      tags: [],
    } as any as HTTPObj;
  }

  /** Show-times for today – cache 6 hours */
  @http({cacheSeconds: 60 * 60 * 6} as any)
  async fetchShowTimes(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.apiBase}/api/v2/show-times?status[]=live`,
      options: {json: true},
      tags: [],
    } as any as HTTPObj;
  }

  // ─── Cached data getters ──────────────────────────────────────────────────

  @cache({ttlSeconds: 60 * 60 * 12})
  async getPOIs(): Promise<EuropaParkPOI[]> {
    const resp = await this.fetchPOIs();
    const data: any = await resp.json();
    if (!Array.isArray(data)) {
      throw new Error(`Europa-Park: unexpected POI response (type: ${typeof data})`);
    }
    return data as EuropaParkPOI[];
  }

  @cache({ttlSeconds: 60})
  async getWaitingTimes(): Promise<EuropaParkWaitTime[]> {
    const resp = await this.fetchWaitingTimes();
    return (await resp.json()) as EuropaParkWaitTime[];
  }

  @cache({ttlSeconds: 60 * 60 * 6})
  async getSeasons(): Promise<EuropaParkSeason[]> {
    const resp = await this.fetchSeasons();
    return (await resp.json()) as EuropaParkSeason[];
  }

  @cache({ttlSeconds: 60 * 5})
  async getLiveCalendar(): Promise<EuropaParkLiveCalendar> {
    const resp = await this.fetchLiveCalendar();
    return (await resp.json()) as EuropaParkLiveCalendar;
  }

  @cache({ttlSeconds: 60 * 60 * 6})
  async getShowTimes(): Promise<EuropaParkShowTime[]> {
    const resp = await this.fetchShowTimes();
    return (await resp.json()) as EuropaParkShowTime[];
  }

  // ─── Entity builder helpers ───────────────────────────────────────────────

  /**
   * Convert raw POI list into the internal entity format used by both
   * buildEntityList and buildLiveData.  Mirrors the legacy _getEntities()
   * logic from europaparkdb.js exactly.
   */
  @cache({ttlSeconds: 60 * 60 * 12})
  async getParkEntities(): Promise<EuropaParkEntity[]> {
    const poiData = await this.getPOIs();
    const entities: EuropaParkEntity[] = [];

    const addPoiData = (poi: EuropaParkPOI & {entityType?: string}): void => {
      if (!poi.name) return;

      const poiEntityTypes = ['attraction', 'showlocation', 'shows', 'pois'];
      const entityType = poi.entityType ?? poi.type;

      if (!poiEntityTypes.includes(entityType)) return;

      // showlocation → recurse into sub-shows
      if (entityType === 'showlocation') {
        (poi.shows || []).forEach((show) => {
          addPoiData({
            ...show,
            entityType: 'shows',
            latitude: poi.latitude,
            longitude: poi.longitude,
            scopes: poi.scopes,
            type: 'shows',
          } as any);
        });
        return;
      }

      // Only allow attraction subtype for 'pois' type
      if (entityType === 'pois' && poi.type !== 'attraction') return;

      // Skip virtual-queue dummy entries
      if (poi.queueing) return;

      // Skip queue map pointers
      if (poi.name.indexOf('Queue - ') === 0) return;

      // Map old vs new entity type strings to id prefix
      let idPrefix: string;
      if (entityType === 'attraction') {
        idPrefix = 'pois';
      } else if (entityType === 'showlocation' || entityType === 'shows') {
        idPrefix = 'shows';
      } else {
        idPrefix = entityType; // 'pois'
      }

      const finalEntityType: 'ATTRACTION' | 'SHOW' =
        (entityType === 'shows' || entityType === 'showlocation') ? 'SHOW' : 'ATTRACTION';

      // Look for a virtual-queue companion (queueing:true, name contains this ride's name)
      const nameLower = poi.name.toLowerCase();
      const vQueueData = poiData.find((x) => {
        return x.queueing === true && x.name.toLowerCase().indexOf(nameLower) > 0;
      });

      entities.push({
        id: `${idPrefix}_${poi.id}`,
        name: poi.name,
        entityType: finalEntityType,
        scopes: poi.scopes || [],
        code: poi.code,
        vQueue: vQueueData,
        duration: (poi as any).duration,
        latitude: poi.latitude,
        longitude: poi.longitude,
        minHeight: poi.minHeight,
        maxHeight: poi.maxHeight,
      });
    };

    poiData.forEach((poi) => {
      addPoiData({...poi, entityType: poi.type});
    });

    return entities;
  }

  // ─── Template Method: buildEntityList ────────────────────────────────────

  async getDestinations(): Promise<Entity[]> {
    return [
      {
        id: DESTINATION_ID,
        name: 'Europa-Park',
        entityType: 'DESTINATION',
        timezone: TIMEZONE,
        location: {latitude: 48.2661, longitude: 7.7225},
      } as Entity,
    ];
  }

  protected async buildEntityList(): Promise<Entity[]> {
    const result: Entity[] = [...(await this.getDestinations())];

    const poiData = await this.getPOIs();
    const entities = await this.getParkEntities();

    // ── Parks ──────────────────────────────────────────────────────────────
    const allowedTypes = new Set(['park', ...PARK_CONFIGS.filter((p) => p.poiType).map((p) => p.poiType!)]);

    for (const parkConfig of PARK_CONFIGS) {
      const expectedType = parkConfig.poiType ?? 'park';
      const park = poiData.find((x) => x.id === parkConfig.id && x.type === expectedType);
      if (!park) continue;

      const parkEntity: Entity = {
        id: `park_${park.id}`,
        name: parkConfig.name || park.name,
        entityType: 'PARK',
        parentId: DESTINATION_ID,
        destinationId: DESTINATION_ID,
        timezone: TIMEZONE,
      } as Entity;

      if (park.latitude && park.longitude) {
        parkEntity.location = {latitude: park.latitude, longitude: park.longitude};
      } else {
        parkEntity.location = {latitude: 48.2661, longitude: 7.7225};
      }

      result.push(parkEntity);
    }

    // ── Attractions (non-show entities scoped to each park) ────────────────
    for (const parkConfig of PARK_CONFIGS) {
      const parkId = `park_${parkConfig.id}`;
      const parkAttractions = entities.filter(
        (e) => e.entityType === 'ATTRACTION' && e.scopes.includes(parkConfig.scope),
      );

      for (const entity of parkAttractions) {
        // Skip "+ Pass entrance" entries
        if (entity.name.indexOf('+ Pass entrance') > 0) continue;

        const attraction: Entity = {
          id: entity.id,
          name: entity.name,
          entityType: 'ATTRACTION',
          parentId: parkId,
          destinationId: DESTINATION_ID,
          timezone: TIMEZONE,
        } as Entity;

        // Location
        if (entity.latitude && entity.longitude) {
          attraction.location = {latitude: entity.latitude, longitude: entity.longitude};
        } else {
          attraction.location = {latitude: 48.2661, longitude: 7.7225};
        }

        // Tags
        const tags = [];
        if (entity.minHeight) {
          tags.push(TagBuilder.minimumHeight(entity.minHeight, 'cm'));
        }
        if (entity.maxHeight) {
          tags.push(TagBuilder.maximumHeight(entity.maxHeight, 'cm'));
        }
        if (tags.length) attraction.tags = tags;

        result.push(attraction);
      }
    }

    // ── Shows (per park, then hotel scope) ────────────────────────────────
    const collectedShowIds = new Set<string>();

    for (const parkConfig of PARK_CONFIGS) {
      const parkId = `park_${parkConfig.id}`;
      const parkShows = entities.filter(
        (e) => e.entityType === 'SHOW' && e.scopes.includes(parkConfig.scope),
      );

      for (const entity of parkShows) {
        const show: Entity = {
          id: entity.id,
          name: entity.name,
          entityType: 'SHOW',
          parentId: parkId,
          destinationId: DESTINATION_ID,
          timezone: TIMEZONE,
        } as Entity;

        if (entity.latitude && entity.longitude) {
          show.location = {latitude: entity.latitude, longitude: entity.longitude};
        } else {
          show.location = {latitude: 48.2661, longitude: 7.7225};
        }

        result.push(show);
        collectedShowIds.add(entity.id);
      }
    }

    // Hotel-scoped shows (not already collected via a park scope)
    const hotelShows = entities.filter(
      (e) => e.entityType === 'SHOW' && e.scopes.includes('hotel'),
    );

    for (const entity of hotelShows) {
      if (collectedShowIds.has(entity.id)) continue;

      const show: Entity = {
        id: entity.id,
        name: entity.name,
        entityType: 'SHOW',
        parentId: DESTINATION_ID,
        destinationId: DESTINATION_ID,
        timezone: TIMEZONE,
      } as Entity;

      if (entity.latitude && entity.longitude) {
        show.location = {latitude: entity.latitude, longitude: entity.longitude};
      } else {
        show.location = {latitude: 48.2661, longitude: 7.7225};
      }

      result.push(show);
    }

    // ── Restaurants (gastronomy POIs per park) ─────────────────────────────
    for (const parkConfig of PARK_CONFIGS) {
      const parkId = `park_${parkConfig.id}`;
      const restaurantPOIs = poiData.filter(
        (x) => x.type === 'gastronomy' && (x.scopes || []).includes(parkConfig.scope),
      );

      for (const poi of restaurantPOIs) {
        const restaurant: Entity = {
          id: `gastronomy_${poi.id}`,
          name: poi.name,
          entityType: 'RESTAURANT',
          parentId: parkId,
          destinationId: DESTINATION_ID,
          timezone: TIMEZONE,
        } as Entity;

        if (poi.latitude && poi.longitude) {
          restaurant.location = {latitude: poi.latitude, longitude: poi.longitude};
        } else {
          restaurant.location = {latitude: 48.2661, longitude: 7.7225};
        }

        result.push(restaurant);
      }
    }

    return result;
  }

  // ─── Template Method: buildLiveData ──────────────────────────────────────

  protected async buildLiveData(): Promise<LiveData[]> {
    const entities = await this.getParkEntities();
    const poiData = await this.getPOIs();
    const waits = await this.getWaitingTimes();
    const showTimes = await this.getShowTimes();

    // Build code → entityId map from attraction/show entities
    const codeToEntityId = new Map<string, string>();
    for (const entity of entities) {
      if (entity.code) {
        codeToEntityId.set(entity.code, entity.id);
      }
    }
    // Also add restaurant codes (gastronomy POIs are not in the entity DB)
    for (const poi of poiData) {
      if (poi.type === 'gastronomy' && poi.code) {
        codeToEntityId.set(poi.code, `gastronomy_${poi.id}`);
      }
    }

    const liveDataMap = new Map<string, LiveData>();
    const getOrCreate = (id: string): LiveData => {
      let entry = liveDataMap.get(id);
      if (!entry) {
        entry = {id, status: 'OPERATING'} as LiveData;
        liveDataMap.set(id, entry);
      }
      return entry;
    };

    // ── First pass: extract virtual-queue data ─────────────────────────────
    type VQueueEntry = {
      entityId: string;
      ignoreCode: string;
      returnStart: string | null;
      returnEnd: string | null;
      state: 'AVAILABLE' | 'TEMP_FULL' | 'FINISHED';
    };
    const vQueueData: VQueueEntry[] = [];

    for (const wait of waits) {
      // Find a ride whose vQueue.code matches this wait entry's code
      const realRide = entities.find((e) => e.vQueue?.code === wait.code);
      if (!realRide) continue;

      // This wait entry is the VQ dummy – determine state
      let state: 'AVAILABLE' | 'TEMP_FULL' | 'FINISHED' = 'AVAILABLE';
      if (wait.time === 666) {
        state = 'TEMP_FULL';
      } else if (wait.time === 777) {
        state = 'FINISHED';
      }

      if (realRide.code) {
        const entityId = codeToEntityId.get(realRide.code);
        if (entityId) {
          vQueueData.push({
            entityId,
            ignoreCode: wait.code,
            returnStart: wait.startAt ?? null,
            returnEnd: wait.endAt ?? null,
            state,
          });
        }
      }
    }

    // ── Second pass: process wait times ───────────────────────────────────
    for (const wait of waits) {
      // Skip VQ dummy entries
      if (vQueueData.find((v) => v.ignoreCode === wait.code)) continue;

      const entityId = codeToEntityId.get(wait.code);
      if (!entityId) continue;

      const live = getOrCreate(entityId);

      // Map time codes to status
      switch (wait.time) {
        case 999:
        case 444: // weather
        case 555: // ice
          live.status = 'DOWN';
          break;
        case 222:
          live.status = 'REFURBISHMENT';
          break;
        case 333:
          live.status = 'CLOSED';
          break;
      }

      // Stand-by queue applies to rides/shows, not restaurants
      if (!entityId.startsWith('gastronomy_')) {
        if (!live.queue) live.queue = {} as any;
        live.queue!.STANDBY = {
          waitTime: wait.time <= 91 ? wait.time : undefined,
        };

        // Inject virtual-queue data if available
        const vq = vQueueData.find((v) => v.entityId === entityId);
        if (vq) {
          live.queue!.RETURN_TIME = this.buildReturnTimeQueue(
            vq.state,
            vq.returnStart,
            vq.returnEnd,
          );
        }
      }
    }

    // ── Show times ────────────────────────────────────────────────────────
    const now = new Date();

    for (const showEntry of showTimes) {
      const showEntityId = `shows_${showEntry.showId}`;
      const showEntity = entities.find((e) => e.id === showEntityId);
      if (!showEntity) continue;

      const live = getOrCreate(showEntityId);

      const showtimes = showEntry.today.map((startTimeStr) => {
        const startTime = new Date(startTimeStr);
        const endTime = addMinutes(startTime, showEntity.duration || 0);
        return {
          startTime: formatInTimezone(startTime, TIMEZONE, 'iso'),
          endTime: formatInTimezone(endTime, TIMEZONE, 'iso'),
          type: 'Performance' as const,
        };
      });

      live.showtimes = showtimes;

      if (showtimes.length === 0) {
        live.status = 'CLOSED';
      } else {
        // If the last show has ended, mark as closed
        const lastEndTime = showtimes.reduce((latest, s) => {
          const t = new Date(s.endTime);
          return t > latest ? t : latest;
        }, new Date(showtimes[0].startTime));

        if (isBefore(lastEndTime, now)) {
          live.status = 'CLOSED';
        }
      }
    }

    return Array.from(liveDataMap.values());
  }

  // ─── Template Method: buildSchedules ─────────────────────────────────────

  protected async buildSchedules(): Promise<EntitySchedule[]> {
    const schedules: EntitySchedule[] = [];

    for (const parkConfig of PARK_CONFIGS) {
      const schedule = await this._buildScheduleForPark(parkConfig);
      schedules.push(schedule);
    }

    return schedules;
  }

  /** Build the schedule for a single park config */
  private async _buildScheduleForPark(parkConfig: EuropaParkConfig): Promise<EntitySchedule> {
    const cal = await this.getSeasons();
    const now = new Date();
    const nowDate = formatInTimezone(now, TIMEZONE, 'date');

    // Filter to open seasons for this park
    const parkSeasons = cal.filter(
      (s) => !s.closed && s.scopes.includes(parkConfig.scope) && s.status === 'live',
    );

    type ScheduleEntry = {
      date: string;
      openingTime: string;
      closingTime: string;
      type: 'OPERATING' | 'EXTRA_HOURS';
      description?: string;
    };

    const times: ScheduleEntry[] = [];

    for (const season of parkSeasons) {
      // Build a lookup of special overrides by date string
      const specialByDate = new Map<string, NonNullable<EuropaParkSeason['specialOpenTimes']>[0]>();
      for (const special of season.specialOpenTimes || []) {
        specialByDate.set(special.dateAt.substring(0, 10), special);
      }

      // Iterate over every day in the season range
      const seasonStart = new Date(season.startAt);
      const seasonEnd = new Date(season.endAt);

      // Extract date-only YYYY-MM-DD strings for the season start/end
      const seasonStartDate = season.startAt.substring(0, 10);
      const seasonEndDate = season.endAt.substring(0, 10);

      // Walk through dates
      let current = new Date(seasonStart);
      while (true) {
        const dateStr = formatInTimezone(current, TIMEZONE, 'date');
        // Convert MM/DD/YYYY -> YYYY-MM-DD
        const [mm, dd, yyyy] = dateStr.split('/');
        const isoDate = `${yyyy}-${mm}-${dd}`;

        // Stop if we've gone past season end
        if (isoDate > seasonEndDate) break;

        // Skip dates before today
        if (isoDate < nowDate) {
          current = addDays(current, 1);
          continue;
        }

        const special = specialByDate.get(isoDate);

        // null startAt on a special means park is closed that day despite the season
        if (special && special.startAt === null) {
          current = addDays(current, 1);
          continue;
        }

        let openingTime: string;
        let closingTime: string;

        if (special) {
          openingTime = special.startAt!;
          closingTime = special.endAt!;
        } else {
          // Combine date + time components from season object
          // The API returns full datetime strings like "2024-04-01T09:00:00+00:00"
          // We apply the date portion from the current iteration date
          openingTime = this._applyDateToTime(season.startAt, isoDate);
          closingTime = this._applyDateToTime(season.endAt, isoDate);
        }

        times.push({date: isoDate, openingTime, closingTime, type: 'OPERATING'});

        // Hotel extra hours
        if (season.hotelStartAt && season.hotelEndAt) {
          times.push({
            date: isoDate,
            openingTime: this._applyDateToTime(season.hotelStartAt, isoDate),
            closingTime: this._applyDateToTime(season.hotelEndAt, isoDate),
            type: 'EXTRA_HOURS',
            description: 'Open To Hotel Guests',
          });
        }

        current = addDays(current, 1);
      }
    }

    // Overlay live opening times for Europa-Park main park only
    if (parkConfig.scope === 'europapark') {
      const liveData = await this.getLiveCalendar();
      if (liveData?.today && liveData.today.date) {
        const date = liveData.today.date.substring(0, 10);

        if (liveData.today.start === null || liveData.today.end === null) {
          // Park is closed today – remove all schedule entries for today
          for (let i = times.length - 1; i >= 0; i--) {
            if (times[i].date === date) times.splice(i, 1);
          }
        } else if (
          typeof liveData.today.start === 'string' &&
          typeof liveData.today.end === 'string'
        ) {
          // Replace operating hours with live data
          const entry = times.find((t) => t.date === date && t.type === 'OPERATING');
          if (entry) {
            entry.openingTime = liveData.today.start;
            entry.closingTime = liveData.today.end;
          }
        }
      }
    }

    return {
      id: `park_${parkConfig.id}`,
      schedule: times,
    } as EntitySchedule;
  }

  /**
   * Given a full datetime string like "2025-04-01T09:00:00+02:00" and a target
   * date "2025-07-15", returns a new datetime string with the date replaced but
   * the time/offset preserved – as a proper ISO-8601 string in the park timezone.
   *
   * This replicates moment's:
   *   moment.tz(inDate, tz).set({ year, month, date }).format()
   */
  private _applyDateToTime(datetimeStr: string, targetDate: string): string {
    // Extract time portion (HH:mm:ss) from the original string
    const match = datetimeStr.match(/T(\d{2}:\d{2}(?::\d{2})?)/);
    const timePart = match ? match[1] : '00:00:00';
    return constructDateTime(targetDate, timePart, TIMEZONE);
  }
}

// ─── Destination registration ─────────────────────────────────────────────────

@destinationController({category: 'Europa-Park'})
export class EuropaPark extends EuropaParkBase {
  constructor(options?: DestinationConstructor) {
    super(options);
  }
}

export default EuropaPark;

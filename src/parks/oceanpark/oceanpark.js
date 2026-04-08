import {Destination} from '../destination.js';
import {attractionType, statusType, queueType, tagType, scheduleType, entityType} from '../parkTypes.js';
import {reusePromise} from '../../reusePromises.js';
import moment from 'moment-timezone';
import crypto from 'crypto';

export class OceanPark extends Destination {
  constructor(options = {}) {
    options.timezone = options.timezone || 'Asia/Hong_Kong';
    options.name = options.name || 'Ocean Park Hong Kong';
    options.baseURL = options.baseURL || 'https://sop.oceanpark.com.hk';
    options.mapURL = options.mapURL || 'https://map.oceanpark.com.hk';
    options.parkId = options.parkId || 1;
    options.configPrefixes = ['OCEANPARK'].concat(options.configPrefixes || []);

    super(options);

    // Inject optoken header for all sop.oceanpark.com.hk requests
    const baseURLHostname = new URL(this.config.baseURL).hostname;
    this.http.injectForDomain({
      hostname: baseURLHostname,
    }, async (method, url, data, options) => {
      if (!options) options = {};
      // Always send POST bodies as JSON
      options.json = true;
      // Skip token injection for the token endpoint itself to avoid circular calls
      if (url.includes('/user/token')) return {method, url, data, options};
      const token = await this._getToken();
      if (!options.headers) options.headers = {};
      options.headers['optoken'] = token;
      return {method, url, data, options};
    });
  }

  /**
   * Get or generate a permanent device ID
   * @returns {Promise<string>}
   */
  async _getDeviceId() {
    let deviceId = await this.cache.get('deviceId');
    if (!deviceId) {
      deviceId = crypto.randomUUID();
      // Store with no TTL (permanent)
      await this.cache.set('deviceId', deviceId, Number.MAX_SAFE_INTEGER);
    }
    return deviceId;
  }

  /**
   * Get a valid auth token, fetching a new one if expired.
   * Uses reusePromise to prevent duplicate concurrent token requests.
   * @returns {Promise<string>}
   */
  async _getToken() {
    return reusePromise(this, this._fetchToken);
  }

  async _fetchToken() {
    const cached = await this.cache.get('authToken');
    if (cached) return cached;

    const deviceId = await this._getDeviceId();

    const resp = await this.http('POST', `${this.config.baseURL}/api/common/user/token`, {
      pId: this.config.parkId,
      lang: 'en',
      deviceId,
    });

    const token = resp?.body?.data?.token;
    const tokenExpire = resp?.body?.data?.tokenExpire;

    if (!token) {
      this.log('Token response body:', JSON.stringify(resp?.body));
      throw new Error('Failed to get Ocean Park auth token');
    }

    // Cache until token expires (tokenExpire is unix ms)
    const ttl = tokenExpire ? (tokenExpire - Date.now()) : (1000 * 60 * 60 * 24);
    await this.cache.set('authToken', token, Math.max(ttl, 1000 * 60));

    return token;
  }

  /**
   * Fetch entity list for a given sortId
   * @param {number} sortId
   * @returns {Promise<Array>}
   */
  async _fetchEntityList(sortId) {
    '@cache|1m';
    const resp = await this.http('POST', `${this.config.baseURL}/api/common/entity/list`, {
      pId: this.config.parkId,
      lang: 'en',
      sortId,
    });
    return resp?.body?.data?.data || [];
  }

  /**
   * Fetch entity detail for a given entity ID (for show showtimes)
   * @param {number} entityId
   * @returns {Promise<object>}
   */
  async _fetchEntityDetail(entityId) {
    '@cache|1h';
    const resp = await this.http('POST', `${this.config.baseURL}/api/common/entity/detail`, {
      pId: this.config.parkId,
      lang: 'en',
      entityId,
    });
    return resp?.body?.data || {};
  }

  /**
   * Fetch 30-day park schedule
   * @returns {Promise<Array>}
   */
  async _fetchParkSchedule() {
    '@cache|1h';
    const today = moment().tz(this.config.timezone).format('YYYY-MM-DD');
    const endDate = moment().tz(this.config.timezone).add(30, 'days').format('YYYY-MM-DD');

    const resp = await this.http('POST', `${this.config.baseURL}/api/common/park/list`, {
      pId: this.config.parkId,
      lang: 'en',
      startDate: today,
      endDate,
    });
    return resp?.body?.data?.parkOperatingHourList || [];
  }

  /**
   * Fetch reference points JSON from map subdomain
   * @returns {Promise<Array>}
   */
  async _fetchReferencePoints() {
    '@cache|1d';
    const resp = await this.http('GET', `${this.config.mapURL}/assets/data/reference_points.json`);
    return resp?.body || [];
  }

  /**
   * Fetch a specific category data JSON from map subdomain
   * @param {string} category
   * @returns {Promise<Array>}
   */
  async _fetchMapCategoryData(category) {
    '@cache|1d';
    const resp = await this.http('GET', `${this.config.mapURL}/assets/data/${category}.json`);
    return resp?.body || [];
  }

  /**
   * Compute affine transform coefficients from reference points
   * Solves: lat = a*x + b*y + c, lng = d*x + e*y + f
   * Using least squares normal equations / Cramer's rule for 3x3 system
   * @param {Array} refPoints
   * @returns {{a,b,c,d,e,f}}
   */
  _computeAffineTransform(refPoints) {
    // Build sums for normal equations
    let sumX = 0;
    let sumY = 0;
    let sumXX = 0;
    let sumXY = 0;
    let sumYY = 0;
    let sumLat = 0;
    let sumXLat = 0;
    let sumYLat = 0;
    let sumLng = 0;
    let sumXLng = 0;
    let sumYLng = 0;
    const n = refPoints.length;

    for (const p of refPoints) {
      const x = p.pixelX;
      const y = p.pixelY;
      const lat = p.latitude;
      const lng = p.longitude;
      sumX += x;
      sumY += y;
      sumXX += x * x;
      sumXY += x * y;
      sumYY += y * y;
      sumLat += lat;
      sumXLat += x * lat;
      sumYLat += y * lat;
      sumLng += lng;
      sumXLng += x * lng;
      sumYLng += y * lng;
    }

    // Normal equations matrix M and RHS vectors
    // [ sumXX  sumXY  sumX ] [a]   [sumXLat]
    // [ sumXY  sumYY  sumY ] [b] = [sumYLat]
    // [ sumX   sumY   n   ] [c]   [sumLat ]
    const M = [
      [sumXX, sumXY, sumX],
      [sumXY, sumYY, sumY],
      [sumX,  sumY,  n],
    ];

    const det = (m) =>
      m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
      m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
      m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);

    const D = det(M);

    const cramer = (rhs) => {
      const M0 = [[rhs[0], M[0][1], M[0][2]], [rhs[1], M[1][1], M[1][2]], [rhs[2], M[2][1], M[2][2]]];
      const M1 = [[M[0][0], rhs[0], M[0][2]], [M[1][0], rhs[1], M[1][2]], [M[2][0], rhs[2], M[2][2]]];
      const M2 = [[M[0][0], M[0][1], rhs[0]], [M[1][0], M[1][1], rhs[1]], [M[2][0], M[2][1], rhs[2]]];
      return [det(M0) / D, det(M1) / D, det(M2) / D];
    };

    const [a, b, c] = cramer([sumXLat, sumYLat, sumLat]);
    const [d, e, f] = cramer([sumXLng, sumYLng, sumLng]);

    return {a, b, c, d, e, f};
  }

  /**
   * Build a map from api_key -> {latitude, longitude} using pixel coords + affine transform
   * @returns {Promise<Map>}
   */
  async _buildCoordinateMap() {
    '@cache|1d';
    const refPoints = await this._fetchReferencePoints();
    const coeffs = this._computeAffineTransform(refPoints);

    const categories = ['attractions', 'animals', 'dining', 'transportations', 'shows', 'shops'];
    const coordMap = new Map();

    for (const category of categories) {
      const entities = await this._fetchMapCategoryData(category);
      if (!Array.isArray(entities)) continue;
      for (const e of entities) {
        if (e.api_key && e.x != null && e.y != null) {
          const latitude = coeffs.a * e.x + coeffs.b * e.y + coeffs.c;
          const longitude = coeffs.d * e.x + coeffs.e * e.y + coeffs.f;
          coordMap.set(String(e.api_key), {latitude, longitude});
        }
      }
    }

    return coordMap;
  }

  /**
   * Parse height restrictions from conditionList
   * @param {Array} conditionList
   * @returns {{min: number|null, max: number|null}}
   */
  _parseHeightTag(conditionList) {
    let min = null;
    let max = null;
    if (!Array.isArray(conditionList)) return {min, max};

    for (const cond of conditionList) {
      const text = typeof cond === 'string' ? cond : (cond.conditionDesc || cond.description || '');

      // min height: "Height: 140cm" or "Height: 140 cm"
      const minMatch = text.match(/Height:\s*(\d+)\s*cm/i);
      if (minMatch) {
        min = parseInt(minMatch[1], 10);
      }

      // max height from range: "Between 100cm and 140cm"
      const maxMatch = text.match(/Between\s*\d+\s*cm.*?and\s*(\d+)\s*cm/i);
      if (maxMatch) {
        max = parseInt(maxMatch[1], 10);
      }
    }

    return {min, max};
  }

  /**
   * Build the destination entity
   */
  async buildDestinationEntity() {
    return {
      ...this.buildBaseEntityObject(null),
      _id: 'oceanparkresort',
      slug: 'oceanparkresort',
      name: 'Ocean Park Hong Kong',
      entityType: entityType.destination,
      location: {latitude: 22.2465, longitude: 114.1748},
    };
  }

  /**
   * Build park entities
   */
  async buildParkEntities() {
    return [{
      ...this.buildBaseEntityObject(null),
      _id: 'oceanpark',
      _destinationId: 'oceanparkresort',
      _parentId: 'oceanparkresort',
      name: 'Ocean Park',
      entityType: entityType.park,
      location: {latitude: 22.2465, longitude: 114.1748},
    }];
  }

  /**
   * Build attraction entities (rides + transport)
   */
  async buildAttractionEntities() {
    const [rides, transport, coordMap] = await Promise.all([
      this._fetchEntityList(8),
      this._fetchEntityList(7),
      this._buildCoordinateMap(),
    ]);

    const allEntities = [...rides, ...transport];

    // Fetch entity details in parallel to get relateList (FastPass info)
    const details = await Promise.all(
      allEntities.map((entity) => this._fetchEntityDetail(entity.id).catch(() => ({})))
    );

    return allEntities.map((entity, i) => {
      const isTransport = entity.typeId === 7;
      const coords = coordMap.get(String(entity.extEntityCode));
      const detail = details[i] || {};

      const tags = [];

      if (coords) {
        tags.push({id: tagType.location, value: coords});
      }

      // Parse height restrictions
      const {min, max} = this._parseHeightTag(entity.conditionList);
      if (min !== null) {
        tags.push({id: tagType.minimumHeight, value: {height: min, unit: 'cm'}});
      }
      if (max !== null) {
        tags.push({id: tagType.maximumHeight, value: {height: max, unit: 'cm'}});
      }

      // Unsuitable for pregnant
      if (Array.isArray(entity.conditionList) && entity.conditionList.some((c) => {
        const text = typeof c === 'string' ? c : (c.conditionDesc || c.description || '');
        return /pregnant/i.test(text);
      })) {
        tags.push({id: tagType.unsuitableForPregnantPeople, value: true});
      }

      // May get wet
      if (entity.raFacilityType === 'Wet Rides') {
        tags.push({id: tagType.mayGetWet, value: true});
      }

      // FastPass (Ocean FasTrack) — only available in entity detail
      if (Array.isArray(detail.relateList) && detail.relateList.some((r) => r.type === 'ticket')) {
        tags.push({id: tagType.fastPass, value: true});
      }

      const built = {
        ...this.buildBaseEntityObject(entity),
        _id: `attraction_${entity.id}`,
        _destinationId: 'oceanparkresort',
        _parentId: 'oceanpark',
        _parkId: 'oceanpark',
        name: entity.name,
        entityType: entityType.attraction,
        attractionType: isTransport ? attractionType.transport : attractionType.ride,
      };

      built.location = coords || {latitude: 22.2465, longitude: 114.1748};

      if (tags.length > 0) {
        built._tags = tags;
      }

      return built;
    });
  }

  /**
   * Build show entities
   */
  async buildShowEntities() {
    const [shows, coordMap] = await Promise.all([
      this._fetchEntityList(15),
      this._buildCoordinateMap(),
    ]);

    return shows.map((entity) => {
      const coords = coordMap.get(String(entity.extEntityCode));
      const built = {
        ...this.buildBaseEntityObject(entity),
        _id: `show_${entity.id}`,
        _destinationId: 'oceanparkresort',
        _parentId: 'oceanpark',
        _parkId: 'oceanpark',
        name: entity.name,
        entityType: entityType.show,
        attractionType: attractionType.show,
      };
      built.location = coords || {latitude: 22.2465, longitude: 114.1748};
      return built;
    });
  }

  /**
   * Build restaurant entities
   */
  async buildRestaurantEntities() {
    const [dining, coordMap] = await Promise.all([
      this._fetchEntityList(17),
      this._buildCoordinateMap(),
    ]);

    return dining.map((entity) => {
      const coords = coordMap.get(String(entity.extEntityCode));
      const built = {
        ...this.buildBaseEntityObject(entity),
        _id: `restaurant_${entity.id}`,
        _destinationId: 'oceanparkresort',
        _parentId: 'oceanpark',
        _parkId: 'oceanpark',
        name: entity.name,
        entityType: entityType.restaurant,
      };
      built.location = coords || {latitude: 22.2465, longitude: 114.1748};
      return built;
    });
  }

  /**
   * Build live data for all entities
   */
  async buildEntityLiveData() {
    const today = this.getTimeNowMoment().format('YYYY-MM-DD');

    const [rides, transport, shows] = await Promise.all([
      this._fetchEntityList(8),
      this._fetchEntityList(7),
      this._fetchEntityList(15),
    ]);

    const liveData = [];

    // Rides + Transport
    for (const entity of [...rides, ...transport]) {
      const pflowInfo = entity.pflowInfo || {};
      const isOpen = pflowInfo.entityStatus === 'open';
      const waitTime = pflowInfo.entityWaitTime;

      const data = {
        _id: `attraction_${entity.id}`,
        status: isOpen ? statusType.operating : statusType.closed,
      };

      if (isOpen && waitTime != null && waitTime >= 0) {
        data.queue = {
          [queueType.standBy]: {waitTime},
        };
      }

      // Today's operating hours
      const hoursList = pflowInfo.operatingHourList;
      if (Array.isArray(hoursList)) {
        const todayEntry = hoursList.find(
          (h) => h.openDate === today && h.openTime && h.closeTime
        );
        if (todayEntry) {
          data.operatingHours = [{
            type: 'Operating',
            startTime: new Date(todayEntry.openTime).toISOString(),
            endTime: new Date(todayEntry.closeTime).toISOString(),
          }];
        }
      }

      liveData.push(data);
    }

    // Shows - fetch details in parallel for showtimes
    await Promise.all(shows.map(async (entity) => {
      const pflowInfo = entity.pflowInfo || {};
      const isOpen = pflowInfo.entityStatus === 'open';

      const detail = await this._fetchEntityDetail(entity.id);
      const activityList = detail.activityList || [];

      const showtimes = activityList.flatMap((activity) =>
        (activity.timeList || []).map((t) => ({
          type: 'Performance Time',
          startTime: new Date(t.startTime).toISOString(),
          endTime: new Date(t.endTime).toISOString(),
        }))
      );

      liveData.push({
        _id: `show_${entity.id}`,
        status: isOpen ? statusType.operating : statusType.closed,
        showtimes,
      });
    }));

    return liveData;
  }

  /**
   * Build schedule data for park
   */
  async buildEntityScheduleData() {
    const parkSchedule = await this._fetchParkSchedule();
    const tz = this.config.timezone;
    const allEntries = [];

    for (const day of parkSchedule) {
      if (day.parkStatus !== 'open') continue;

      // Main operating hours
      allEntries.push({
        date: day.openDate,
        type: scheduleType.operating,
        openingTime: moment.tz(day.parkOpenTime, 'x', tz).format(),
        closingTime: moment.tz(day.parkCloseTime, 'x', tz).format(),
      });

      // Parking hours
      if (day.parkingOpenTime && day.parkingCloseTime) {
        allEntries.push({
          date: day.openDate,
          type: scheduleType.informational,
          description: 'Parking',
          openingTime: moment.tz(day.parkingOpenTime, 'x', tz).format(),
          closingTime: moment.tz(day.parkingCloseTime, 'x', tz).format(),
        });
      }

      // Summit zone (only if open and closes before main park)
      if (day.summitStaus === 'open' && day.summitCloseTime && day.summitCloseTime < day.parkCloseTime) {
        allEntries.push({
          date: day.openDate,
          type: scheduleType.informational,
          description: 'The Summit',
          openingTime: moment.tz(day.parkOpenTime, 'x', tz).format(),
          closingTime: moment.tz(day.summitCloseTime, 'x', tz).format(),
        });
      }
    }

    return [{
      _id: 'oceanpark',
      schedule: allEntries,
    }];
  }
}

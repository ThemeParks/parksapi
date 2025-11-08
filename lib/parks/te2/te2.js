import {URL} from 'url';
import moment from 'moment-timezone';

import Destination from '../destination.js';
import {attractionType, statusType, queueType, scheduleType, entityType} from '../parkTypes.js';

// Ride indicator labels used to identify attractions with wait times
const RIDE_INDICATOR_LABELS = new Set(['thrill level', 'rider height', 'ages']);

// Schedule types
const SCHEDULE_TYPE_PERFORMANCE = 'Performance Time';

// Schedule label identifiers
const PARK_SCHEDULE_LABELS = ['park', 'gate'];

/**
 * Base destination for TE2-powered parks.
 * Handles basic auth using the configured username/password.
 */
export class TE2Destination extends Destination {
  /**
   * Create a new TE2Destination object
   * @param {object} options Configuration options
   * @param {string} [options.timezone] Park timezone (default: Australia/Brisbane)
   * @param {string} [options.destinationId] Unique destination identifier
   * @param {string} [options.venueId] TE2 API venue ID
   * @param {string} [options.subdomain] TE2 API subdomain
   * @param {string} [options.apidomain] TE2 API domain
   * @param {string} [options.apiuser] TE2 API username
   * @param {string} [options.apipass] TE2 API password
   * @param {Array<string>} [options.rideTypes] Categories to classify as rides
   * @param {Array<string>} [options.diningTypes] Categories to classify as dining
   * @param {Array<string>} [options.showTypes] Categories to classify as shows
   * @param {number} [options.eventScheduleDays] Days to fetch for event schedule (default: 14)
   */
  constructor(options = {}) {
    options.timezone = options.timezone || 'Australia/Brisbane';
    options.destinationId = options.destinationId || '';
    options.venueId = options.venueId || '';
    options.subdomain = options.subdomain || 'vrtp';
    options.apidomain = options.apidomain || 'te2.biz';
    options.apiuser = options.apiuser || '';
    options.apipass = options.apipass || '';
    options.rideTypes = options.rideTypes || ['Ride', 'Coasters', 'Family', 'ThrillRides', 'Kids', 'Rides & Attractions'];
    options.diningTypes = options.diningTypes || ['Snacks', 'wpDining', 'Meals', 'Dining'];
    options.showTypes = options.showTypes || ['Shows', 'Show', 'Entertainment', 'Live Entertainment', 'Presentation'];
    options.eventScheduleDays = options.eventScheduleDays || 14;

    // allow configuring credentials via TE2_* env vars
    options.configPrefixes = ['TE2'].concat(options.configPrefixes || []);

    super(options);

    if (!this.config.destinationId) throw new Error('Missing destinationId');
    if (!this.config.venueId) throw new Error('Missing venueId');
    if (!this.config.subdomain) throw new Error('Missing subdomain');
    if (!this.config.apidomain) throw new Error('Missing apidomain');
    if (!this.config.apiuser) throw new Error('Missing apiuser');
    if (!this.config.apipass) throw new Error('Missing apipass');

    this.config.apiBase = this.config.apiBase || `https://${this.config.subdomain}.${this.config.apidomain}`;

    const baseURLHostname = new URL(this.config.apiBase).hostname;

    this.http.injectForDomain({
      hostname: baseURLHostname,
    }, async (method, url, data, options = {}) => {
      const requestUrl = new URL(url);

      options.headers = {
        ...(options.headers || {}),
        'Content-Type': 'application/json',
      };

      if (requestUrl.pathname.startsWith('/rest/')) {
        const credentials = Buffer.from(`${this.config.apiuser}:${this.config.apipass}`).toString('base64');
        options.headers.Authorization = `Basic ${credentials}`;
      }
    });
  }

  /**
   * Fetch current POI status data including wait times and operational status
   * @return {Promise<object>} POI status data
   */
  async getPOIStatus() {
    '@cache|1';
    const resp = await this.http('GET', `${this.config.apiBase}/rest/venue/${this.config.venueId}/poi/all/status`);
    return resp?.body ?? resp;
  }

  /**
   * Fetch venue/destination metadata
   * @return {Promise<object>} Destination data including name and location
   */
  async getDestinationData() {
    '@cache|1440';
    const resp = await this.http('GET', `${this.config.apiBase}/rest/venue/${this.config.venueId}`);
    return resp?.body ?? resp;
  }

  /**
   * Fetch all Points of Interest (attractions, dining, shows, etc.) for this venue
   * @return {Promise<Array>} Array of POI objects
   */
  async getPOIData() {
    '@cache|1440';
    const resp = await this.http('GET', `${this.config.apiBase}/rest/venue/${this.config.venueId}/poi/all`);
    return resp?.body ?? resp;
  }

  /**
   * Fetch category definitions from the TE2 API
   * @return {Promise<object>} Category data with POI associations
   * @private
   */
  async _fetchCategories() {
    '@cache|1440';
    const resp = await this.http('GET', `${this.config.apiBase}/rest/app/${this.config.venueId}/displayCategories`);
    return resp?.body ?? resp;
  }

  /**
   * Parse category data to find POI entities matching the given types
   * Recursively includes child categories based on parent relationships
   * @param {object} params Parameters
   * @param {Array<string>} params.initialTypes Initial category types to search for
   * @return {Promise<object>} Object containing matched types and entity IDs
   * @private
   */
  async _getParsedCategories({initialTypes}) {
    const types = Array.isArray(initialTypes) ? [...initialTypes] : [];
    const entities = [];

    const categoryData = await this._fetchCategories();
    if (!Array.isArray(categoryData?.categories)) {
      return {
        types,
        entities,
      };
    }

    categoryData.categories.forEach((cat) => {
      if (types.indexOf(cat.label) >= 0) {
        if (types.indexOf(cat.id) < 0) {
          types.push(cat.id);
        }
        if (Array.isArray(cat.poi)) {
          entities.push(...cat.poi);
        }
      }
      if (cat.parent && types.indexOf(cat.parent) >= 0) {
        if (types.indexOf(cat.id) < 0) {
          types.push(cat.id);
        }
        if (Array.isArray(cat.poi)) {
          entities.push(...cat.poi);
        }
      }
    });

    return {
      types,
      entities: [...new Set(entities)],
    };
  }

  /**
   * Get parsed category data for attraction/ride types
   * @return {Promise<object>} Object with types array and entities array
   */
  async getAttractionTypes() {
    return await this._getParsedCategories({
      initialTypes: this.config.rideTypes,
    });
  }

  /**
   * Get parsed category data for dining types
   * @return {Promise<object>} Object with types array and entities array
   */
  async getDiningTypes() {
    return await this._getParsedCategories({
      initialTypes: this.config.diningTypes,
    });
  }

  /**
   * Get parsed category data for show/entertainment types
   * @return {Promise<object>} Object with types array and entities array
   */
  async getShowTypes() {
    return await this._getParsedCategories({
      initialTypes: this.config.showTypes,
    });
  }

  /**
   * Build a base entity object from TE2 API data
   * Extracts common fields like name, ID, and location
   * @param {object} data Raw entity data from TE2 API
   * @return {object} Base entity object with standardized fields
   */
  buildBaseEntityObject(data) {
    const entity = super.buildBaseEntityObject(data);

    if (data) {
      entity.name = data.name || data.label;
      entity._id = data.id || undefined;

      if (data.location) {
        if (data.location.lon !== undefined && data.location.lat !== undefined) {
          const lon = Number(data.location.lon);
          const lat = Number(data.location.lat);
          if (!Number.isNaN(lon) && !Number.isNaN(lat)) {
            entity.location = {
              longitude: lon,
              latitude: lat,
            };
          }
        }
        if (data.location.center?.lon !== undefined && data.location.center?.lat !== undefined) {
          const lon = Number(data.location.center.lon);
          const lat = Number(data.location.center.lat);
          if (!Number.isNaN(lon) && !Number.isNaN(lat)) {
            entity.location = {
              longitude: lon,
              latitude: lat,
            };
          }
        }
      }
    }

    return entity;
  }

  /**
   * Build the destination entity representing this venue
   * @return {Promise<object>} Destination entity object
   */
  async buildDestinationEntity() {
    const destinationData = await this.getDestinationData();
    const name = destinationData?.name || destinationData?.label || this.config.name || this.config.destinationId;
    const slug = (name || '').toLowerCase().replace(/[^a-z0-9]+/g, '').replace(/(^-|-$)/g, '') || this.config.destinationId;
    return {
      ...this.buildBaseEntityObject(destinationData),
      _id: `${this.config.destinationId}_destination`,
      slug,
      entityType: entityType.destination,
    };
  }

  /**
   * Build park entities for this destination
   * In TE2, the destination and park are typically the same venue
   * @return {Promise<Array<object>>} Array of park entity objects
   */
  async buildParkEntities() {
    const destinationData = await this.getDestinationData();
    const name = destinationData?.name || destinationData?.label || this.config.name || this.config.destinationId;
    const slug = (name || '').toLowerCase().replace(/[^a-z0-9]+/g, '').replace(/(^-|-$)/g, '') || this.config.destinationId;
    return [
      {
        ...this.buildBaseEntityObject(destinationData),
        _id: this.config.destinationId,
        _destinationId: `${this.config.destinationId}_destination`,
        _parentId: `${this.config.destinationId}_destination`,
        slug: `${slug || this.config.destinationId}park`,
        entityType: entityType.park,
      },
    ];
  }

  /**
   * Filter POI data to get entities matching specified types/IDs
   * Supports custom filtering via includeFn callback
   * @param {object} categoryData Object containing types and entities arrays
   * @param {Array<string>} categoryData.types Category type IDs to match
   * @param {Array<string>} categoryData.entities Entity IDs to match
   * @param {object} data Additional data to merge into each entity
   * @param {object} options Options object
   * @param {Function} [options.includeFn] Custom filter function for additional inclusion logic
   * @return {Promise<Array<object>>} Array of filtered entity objects
   * @private
   */
  async _getFilteredEntities({types, entities}, data, {includeFn} = {}) {
    const poi = await this.getPOIData();
    if (!Array.isArray(poi)) {
      return [];
    }

    const typeSet = new Set(Array.isArray(types) ? types : []);
    const entitySet = new Set(Array.isArray(entities) ? entities : []);
    const seenIds = new Set();

    return poi.filter((entry) => {
      if (!entry?.id) return false;

      if (seenIds.has(entry.id)) {
        return false;
      }

      const matchesCategory = typeSet.has(entry.type) || entitySet.has(entry.id);
      const matchesFallback = typeof includeFn === 'function' ? includeFn(entry) : false;

      if (!(matchesCategory || matchesFallback)) {
        return false;
      }

      seenIds.add(entry.id);
      return true;
    }).map((entry) => {
      return {
        ...this.buildBaseEntityObject(entry),
        _destinationId: `${this.config.destinationId}_destination`,
        _parentId: this.config.destinationId,
        _parkId: this.config.destinationId,
        ...data,
      };
    });
  }

  /**
   * Build attraction entities for this destination
   * Includes rides identified by category or by presence of wait time/ride indicator tags
   * @return {Promise<Array<object>>} Array of attraction entity objects
   */
  async buildAttractionEntities() {
    return await this._getFilteredEntities(
      await this.getAttractionTypes(),
      {
        entityType: entityType.attraction,
        attractionType: attractionType.ride,
      },
      {
        includeFn: (entry) => {
          // Include entries with status data that have ride indicator tags
          const status = entry?.status;
          if (!status || (status.waitTime === undefined && status.operationalStatus === undefined)) {
            return false;
          }

          const tags = Array.isArray(entry?.tags) ? entry.tags : [];
          return tags.some((tag) => {
            const label = (tag?.label || '').toLowerCase();
            return RIDE_INDICATOR_LABELS.has(label);
          });
        },
      },
    );
  }

  /**
   * Build restaurant/dining entities for this destination
   * @return {Promise<Array<object>>} Array of restaurant entity objects
   */
  async buildRestaurantEntities() {
    return await this._getFilteredEntities(
      await this.getDiningTypes(),
      {
        entityType: entityType.restaurant,
      },
    );
  }

  /**
   * Build a POI lookup map from POI data array
   * @param {Array} poiData - Array of POI data objects
   * @return {Map} Map of POI ID to POI object
   * @private
   */
  _buildPOIMap(poiData) {
    const poiMap = new Map();
    if (Array.isArray(poiData)) {
      poiData.forEach((poi) => {
        if (poi?.id) {
          poiMap.set(poi.id, poi);
        }
      });
    }
    return poiMap;
  }

  /**
   * Find location data from associated POIs or fallback sources
   * @param {Array} associatedPois - Array of associated POI objects
   * @param {object} basePoi - Base POI object to check for location
   * @return {object|null} Location object with latitude/longitude or null
   * @private
   */
  _findLocationForShowEntity(associatedPois, basePoi) {
    // First try to find location from associated POIs
    const poiWithLocation = associatedPois.find((poi) => poi?.location?.latitude && poi?.location?.longitude);
    if (poiWithLocation) {
      return {
        latitude: Number(poiWithLocation.location.latitude),
        longitude: Number(poiWithLocation.location.longitude),
      };
    }

    // Try base POI location
    if (basePoi?.location) {
      return {...basePoi.location};
    }

    // Fallback to config location
    if (this.config?.location) {
      return {...this.config.location};
    }

    return null;
  }

  /**
   * Build a show entity from event calendar data
   * @param {object} event - Event data from calendar
   * @param {Map} poiMap - Map of POI IDs to POI objects
   * @return {object} Show entity object
   * @private
   */
  _buildShowEntityFromEvent(event, poiMap) {
    const associatedPois = Array.isArray(event.associatedPois) ? event.associatedPois : [];

    // Find base POI from associated POIs
    let basePoi = null;
    for (const assoc of associatedPois) {
      if (assoc?.id && poiMap.has(assoc.id)) {
        basePoi = poiMap.get(assoc.id);
        break;
      }
    }

    // Build base entity from POI or event data
    const entityBase = basePoi
      ? this.buildBaseEntityObject(basePoi)
      : this.buildBaseEntityObject({id: event.id, name: event.title});

    const entity = {
      ...entityBase,
      _id: event.id,
      _destinationId: `${this.config.destinationId}_destination`,
      _parentId: this.config.destinationId,
      _parkId: this.config.destinationId,
      entityType: entityType.show,
      name: event.title || entityBase?.name || event.id,
    };

    // Add description if available
    if (event.description) {
      entity.description = event.description;
    }

    // Find and set location if not already set
    if (!entity.location) {
      const location = this._findLocationForShowEntity(associatedPois, basePoi);
      if (location) {
        entity.location = location;
      }
    }

    return entity;
  }

  /**
   * Build show/entertainment entities for this destination
   * Combines show entities from categories and event calendar data
   * @return {Promise<Array<object>>} Array of show entity objects
   */
  async buildShowEntities() {
    // Get show entities from filtered show types
    const showEntities = await this._getFilteredEntities(
      await this.getShowTypes(),
      {
        entityType: entityType.show,
      },
    );

    const existingIds = new Set(showEntities.map((ent) => ent?._id).filter((id) => !!id));

    // Fetch event calendar data and add any missing show entities
    const {events, showtimesByEvent} = await this._getEventCalendarData();
    if (events.length > 0) {
      const poiData = await this.getPOIData();
      const poiMap = this._buildPOIMap(poiData);

      events.forEach((event) => {
        if (!event?.id) return;
        if (existingIds.has(event.id)) return;

        const entity = this._buildShowEntityFromEvent(event, poiMap);
        showEntities.push(entity);
        existingIds.add(entity._id);
      });
    }

    return showEntities;
  }

  /**
   * Fetch venue operating hours schedule data
   * @param {object} options Options object
   * @param {number} [options.days=120] Number of days to fetch schedule for
   * @return {Promise<object>} Schedule data with daily operating hours
   * @private
   */
  async _fetchScheduleData({days = 120} = {}) {
    '@cache|1440';
    const resp = await this.http('GET', `${this.config.apiBase}/v2/venues/${this.config.venueId}/venue-hours?days=${days}`);
    return resp.body;
  }

  /**
   * Fetch event calendar data including shows and entertainment schedules
   * @param {object} options Options object
   * @param {number} [options.days] Number of days to fetch (uses config.eventScheduleDays if not specified)
   * @return {Promise<object>} Event calendar data with events and schedules
   */
  async fetchEventCalendar({days} = {}) {
    '@cache|30';
    const duration = Number.isFinite(days) ? days : this.config.eventScheduleDays;
    const resp = await this.http('GET', `${this.config.apiBase}/v2/venues/${this.config.venueId}/calendars/events?days=${duration}`);
    return resp?.body ?? resp;
  }

  /**
   * Get parsed event calendar data with showtimes organized by event
   * Filters out past events and creates showtime objects
   * @return {Promise<object>} Object containing events, eventsById map, and showtimesByEvent map
   * @private
   */
  async _getEventCalendarData() {
    try {
      const calendar = await this.fetchEventCalendar({});
      const events = Array.isArray(calendar?.events) ? calendar.events : [];
      const schedules = Array.isArray(calendar?.schedules) ? calendar.schedules : [];
      if (!events.length || !schedules.length) {
        return {
          events: [],
          eventsById: new Map(),
          showtimesByEvent: new Map(),
        };
      }

      const eventsById = new Map();
      events.forEach((event) => {
        if (event?.id) {
          eventsById.set(event.id, event);
        }
      });

      const nowMs = Date.now();
      const showtimesByEvent = new Map();

      schedules.forEach((slot) => {
        const event = eventsById.get(slot?.eventId);
        if (!event) return;

        const start = slot?.start;
        if (!start) return;

        const startMs = Date.parse(start);
        if (!Number.isFinite(startMs) || startMs < nowMs) return;

        const end = slot?.end;
        const endMs = end ? Date.parse(end) : Number.NaN;
        const showtime = {
          type: SCHEDULE_TYPE_PERFORMANCE,
          startTime: start,
          endTime: Number.isFinite(endMs) ? end : start,
        };

        if (!showtimesByEvent.has(event.id)) {
          showtimesByEvent.set(event.id, new Map());
        }

        const eventMap = showtimesByEvent.get(event.id);
        const key = `${showtime.startTime}|${showtime.endTime}`;
        if (!eventMap.has(key)) {
          eventMap.set(key, showtime);
        }
      });

      const normalizedShowtimes = new Map();
      showtimesByEvent.forEach((eventMap, eventId) => {
        const items = Array.from(eventMap.values()).sort((a, b) => a.startTime.localeCompare(b.startTime));
        if (items.length > 0) {
          normalizedShowtimes.set(eventId, items);
        }
      });

      return {
        events,
        eventsById,
        showtimesByEvent: normalizedShowtimes,
      };
    } catch (err) {
      this.log(`Failed to fetch TE2 event data: ${err?.message || err}`);
      return {
        events: [],
        eventsById: new Map(),
        showtimesByEvent: new Map(),
      };
    }
  }

  async buildEntityScheduleData() {
    const scheduleData = await this._fetchScheduleData();
    if (!Array.isArray(scheduleData?.days)) {
      return [];
    }

    const scheduleEntries = [];
    scheduleData.days.forEach((day) => {
      (day.hours || []).forEach((hours) => {
        if (day.label !== 'Park' && hours.status === 'CLOSED') return;

        const start = hours?.schedule?.start;
        const end = hours?.schedule?.end;
        if (!start || !end) return;

        const startMoment = moment(start).tz(this.config.timezone);
        const endMoment = moment(end).tz(this.config.timezone);
        if (!startMoment.isValid() || !endMoment.isValid()) return;

        const label = typeof hours.label === 'string' ? hours.label.trim() : '';
        const normalizedLabel = label.toLowerCase();

        // Determine if this is a park operating schedule or informational schedule
        let scheduleTypeValue = scheduleType.informational;
        if (PARK_SCHEDULE_LABELS.includes(normalizedLabel)) {
          scheduleTypeValue = scheduleType.operating;
        }

        scheduleEntries.push({
          date: startMoment.format('YYYY-MM-DD'),
          type: scheduleTypeValue,
          description: normalizedLabel === 'park' ? undefined : label || undefined,
          openingTime: startMoment.format(),
          closingTime: endMoment.format(),
        });
      });
    });

    if (scheduleEntries.length === 0) {
      return [];
    }

    scheduleEntries.sort((a, b) => {
      const dateCompare = a.date.localeCompare(b.date);
      if (dateCompare !== 0) {
        return dateCompare;
      }
      return a.openingTime.localeCompare(b.openingTime);
    });

    return [
      {
        _id: this.config.destinationId,
        schedule: scheduleEntries,
      },
    ];
  }

  async buildEntityLiveData() {
    const liveDataMap = new Map();

    const statusData = await this.getPOIStatus();
    if (Array.isArray(statusData)) {
      statusData.forEach((entry) => {
        if (!entry?.status || !entry.id) return;
        if (entry.id.includes('_STANDING_OFFER_BEACON')) return;

        const liveData = liveDataMap.get(entry.id) || {_id: entry.id};

        if (entry.status.waitTime !== undefined) {
          const rawWait = Number(entry.status.waitTime);
          const sanitizedWait = Number.isFinite(rawWait) ? Math.max(0, Math.round(rawWait)) : null;

          liveData.queue = {
            [queueType.standBy]: {
              waitTime: sanitizedWait,
            },
          };
        }

        liveData.status = entry.status.isOpen ? statusType.operating : statusType.closed;

        liveDataMap.set(entry.id, liveData);
      });
    }

    const {eventsById, showtimesByEvent} = await this._getEventCalendarData();
    const now = this.getTimeNowMoment();
    const todayKey = now.tz(this.config.timezone).format('YYYY-MM-DD');

    const filterShowtimesForToday = (showtimes) => {
      return showtimes.filter((slot) => {
        if (!slot?.startTime) return false;
        const startMoment = moment.tz(slot.startTime, this.config.timezone);
        if (!startMoment.isValid()) return false;
        if (startMoment.isBefore(now)) return false;
        return startMoment.format('YYYY-MM-DD') === todayKey;
      });
    };

    showtimesByEvent.forEach((showtimes, eventId) => {
      if (!showtimes.length) return;
      const todaysShowtimes = filterShowtimesForToday(showtimes);
      if (!todaysShowtimes.length) return;

      const liveData = liveDataMap.get(eventId) || {_id: eventId};
      liveData.showtimes = todaysShowtimes;
      liveData.status = statusType.operating;

      liveDataMap.set(eventId, liveData);
    });

    return Array.from(liveDataMap.values());
  }
}

export class VrtpSeaWorldTe2 extends TE2Destination {
  constructor(options = {}) {
    options.name = options.name || 'Sea World (TE2)';
    options.destinationId = options.destinationId || 'vrtp_sw_te2';
    options.venueId = options.venueId || 'VRTP_SW';
    super(options);
  }
}

export class VrtpMovieWorldTe2 extends TE2Destination {
  constructor(options = {}) {
    options.name = options.name || 'Warner Bros. Movie World (TE2)';
    options.destinationId = options.destinationId || 'vrtp_mw_te2';
    options.venueId = options.venueId || 'VRTP_MW';
    super(options);
  }
}

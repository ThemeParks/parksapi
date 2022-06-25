// te2.io / te2.biz interface

import {Destination} from '../destination.js';
import {attractionType, statusType, queueType, tagType, scheduleType, entityType} from '../parkTypes.js';
import {URL} from 'url';

export class TE2Destination extends Destination {
  constructor(options = {}) {
    // venue ID
    options.destinationId = options.destinationId || '';
    options.venueId = options.venueId || '';
    options.subdomain = options.subdomain || 'cf';
    options.apidomain = options.apidomain || 'te2.biz';
    options.apiuser = options.apiuser || '';
    options.apipass = options.apipass || '';
    options.rideTypes = options.rideTypes || ['Ride', 'Coasters', 'Family', 'ThrillRides', 'Kids', 'Rides & Attractions'];
    options.diningTypes = options.diningTypes || ['Snacks', 'wpDining', 'Meals', 'Dining'];

    options.configPrefixes = ['TE2'];

    super(options);

    if (!this.config.destinationId) throw new Error('Missing destinationId');
    if (!this.config.venueId) throw new Error('Missing venueId');
    if (!this.config.subdomain) throw new Error('Missing subdomain');
    if (!this.config.apidomain) throw new Error('Missing apidomain');
    if (!this.config.apiuser) throw new Error('Missing apiuser');
    if (!this.config.apipass) throw new Error('Missing apipass');
    if (!this.config.rideTypes) throw new Error('Missing rideTypes');

    // construct our destination's API base URL from the configured pieces
    this.config.apiBase = this.config.apiBase || `https://${this.config.subdomain}.${this.config.apidomain}`;

    // authenticate all our requests
    const baseURLHostname = new URL(this.config.apiBase).hostname;

    this.http.injectForDomain({
      hostname: baseURLHostname,
    }, async (method, url, data, options) => {
      // extract path from url
      const path = new URL(url).pathname;

      // add core headers
      options.headers = {
        ...options.headers,
        'Content-Type': 'application/json',
      };

      // use username:password credentials for /rest/ requests
      if (path.startsWith('/rest/')) {
        options.headers = {
          ...options.headers,
          Authorization: `Basic ${Buffer.from(`${this.config.apiuser}:${this.config.apipass}`).toString('base64')}`,
        };
      }
    });
  }

  /**
   * Get current POI data status
   * @returns {array<object>}
   */
  async getPOIStatus() {
    '@cache|1';
    const resp = await this.http('GET', `${this.config.apiBase}/rest/venue/${this.config.venueId}/poi/all/status`);
    return resp.body;
  }

  /**
   * Get the destination data from the API (name, location, etc.)
   * @returns {object}
   */
  async getDestinationData() {
    // cache for a day
    '@cache|1440';
    const resp = await this.http('GET', `${this.config.apiBase}/rest/venue/${this.config.venueId}`);
    return resp.body;
  }

  /**
   * Get park POI data
   * @returns {array<object>}
   */
  async getPOIData() {
    // cache for a day
    '@cache|1440';
    const resp = await this.http('GET', `${this.config.apiBase}/rest/venue/${this.config.venueId}/poi/all`);
    return resp.body;
  }

  /**
   * Fetch the POI category data for this destination
   */
  async _fetchCategories() {
    '@cache|1440'; // cache for a day
    const resp = await this.http('GET', `${this.config.apiBase}/rest/app/${this.config.venueId}/displayCategories`);
    return resp.body;
  }

  /**
   * Get categories from API based on the configured initial types
   * @param {object} params
   * @param {array<string>} params.initialTypes
   * @returns {object} - {types: {string: string}, entities: {string: string}}
   */
  async _getParsedCategories({initialTypes}) {
    const types = [].concat(...initialTypes);
    // some categories just list the POIs that belong to it
    const entities = [];

    const categoryData = await this._fetchCategories();

    categoryData.categories.forEach((cat) => {
      if (types.indexOf(cat.label) >= 0) {
        if (types.indexOf(cat.id) < 0) {
          types.push(cat.id);
        }
        if (cat.poi) {
          entities.push(...cat.poi);
        }
      }
      if (cat.parent && types.indexOf(cat.parent) >= 0) {
        if (types.indexOf(cat.id) < 0) {
          types.push(cat.id);
        }
        if (cat.poi) {
          entities.push(...cat.poi);
        }
      }
    });

    return {
      types,
      entities: entities.filter((x, idx) => {
        // remove duplicates
        return entities.indexOf(x) === idx;
      }),
    };
  }

  /**
   * Get the type IDs for this destination's attractions
   */
  async getAttractionTypes() {
    return await this._getParsedCategories({
      initialTypes: this.config.rideTypes,
    });
  }

  /**
   * Get the type IDs for this destination's dining
   */
  async getDiningTypes() {
    return await this._getParsedCategories({
      initialTypes: this.config.diningTypes,
    });
  }

  /**
   * Helper function to build a basic entity document
   * Useful to avoid copy/pasting
   * @param {object} data 
   * @returns {object}
   */
  buildBaseEntityObject(data) {
    const entity = Destination.prototype.buildBaseEntityObject.call(this, data);

    if (data) {
      // name
      entity.name = data.name || data.label;

      entity._id = data.id || undefined;

      // entity location
      if (data.location) {
        if (data.location.lon) {
          entity.location = {
            longitude: data.location.lon,
            latitude: data.location.lat,
          };
        }
        if (data.location.center?.lon) {
          entity.location = {
            longitude: data.location.center.lon,
            latitude: data.location.center.lat,
          };
        }
      }
    }

    return entity;
  }

  /**
   * Build the destination entity representing this destination
   */
  async buildDestinationEntity() {
    const destinationData = await this.getDestinationData();
    return {
      ...this.buildBaseEntityObject(destinationData),
      _id: `${this.config.destinationId}_destination`,
      slug: this.config.destinationId,
      entityType: entityType.destination,
    };
  }

  /**
   * Build the park entities for this destination
   */
  async buildParkEntities() {
    const destinationData = await this.getDestinationData();
    return [
      {
        ...this.buildBaseEntityObject(destinationData),
        _id: this.config.destinationId,
        _destinationId: `${this.config.destinationId}_destination`,
        _parentId: `${this.config.destinationId}_destination`,
        slug: `${this.config.destinationId}park`,
        entityType: entityType.park,
      }
    ];
  }

  async _getFilteredEntities({types, entities}, data) {
    const poi = await this.getPOIData();
    return poi.filter((entry) => {
      // filter by rideTypes
      return types.indexOf(entry.type) >= 0 || entities.indexOf(entry.id) >= 0;
    }).map((entry) => {
      // build the entity
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
   * Build the attraction entities for this destination
   */
  async buildAttractionEntities() {
    return await this._getFilteredEntities(
      {
        ...await this.getAttractionTypes(),
      },
      {
        entityType: entityType.attraction,
        attractionType: attractionType.ride,
      }
    );
  }

  /**
   * Build the show entities for this destination
   */
  async buildShowEntities() {
    return [];
  }

  /**
   * Build the restaurant entities for this destination
   */
  async buildRestaurantEntities() {
    return await this._getFilteredEntities(
      {
        ...await this.getDiningTypes(),
      },
      {
        entityType: entityType.restaurant,
      }
    );
  }

  /**
   * @inheritdoc
   */
  async buildEntityLiveData() {
    const statusData = await this.getPOIStatus();

    return statusData.map((entry) => {
      if (!entry.status || !entry.id) return null;

      if (entry.id.indexOf('_STANDING_OFFER_BEACON') >= 0) {
        return null;
      }

      const liveData = {
        _id: entry.id,
        status: statusType.closed,
      };

      if (!!entry.status.isOpen) {
        liveData.status = statusType.operating;
      }

      if (entry.status.waitTime !== undefined) {
        liveData.queue = {
          [queueType.standBy]: {
            waitTime: entry.status.waitTime,
          },
        };
      }

      return liveData;
    }).filter((x) => !!x);
  }

  /**
   * Get schedule data for this destination, with an optional number of days to fetch
   * @param {object} [options]
   * @param {number} [options.days] Number of days to fetch
   * @returns {array<object>}
   */
  async _fetchScheduleData({days = 120} = {}) {
    '@cache|1440'; // cache for a day
    const resp = await this.http('GET', `${this.config.apiBase}/v2/venues/${this.config.venueId}/venue-hours?days=${days}`);
    return resp.body;
  }

  /**
   * Return schedule data for all scheduled entities in this destination
   * Eg. parks
   * @returns {array<object>}
   */
  async buildEntityScheduleData() {
    const scheduleData = await this._fetchScheduleData();

    const schedules = [];
    scheduleData.days.forEach((x) => {
      x.hours.forEach((hours) => {
        if (x.label !== 'Park' && hours.status === 'CLOSED') return;

        schedules.push({
          date: x.date,
          type: hours.label === 'Park' ? "OPERATING" : "INFO",
          description: hours.label === 'Park' ? undefined : hours.label,
          // bless you, API developer, for having the dates in a normal format
          openingTime: hours.schedule.start,
          closingTime: hours.schedule.end,
        });
      });
    });

    return [
      {
        _id: this.config.destinationId,
        schedule: schedules,
      }
    ];
  }
}

export class CedarPoint extends TE2Destination {
  constructor(options = {}) {
    options.timezone = 'America/New_York';
    options.venueId = 'CF_CP';
    options.destinationId = 'centerpoint';

    super(options);
  }
}

export class KnottsBerryFarm extends TE2Destination {
  constructor(options = {}) {
    options.timezone = 'America/Los_Angeles';
    options.venueId = 'CF_KBF';
    options.destinationId = 'knottsberryfarm';

    super(options);
  }
}

export class CaliforniasGreatAmerica extends TE2Destination {
  constructor(options = {}) {
    options.timezone = 'America/Los_Angeles';
    options.venueId = 'CF_GA';
    options.destinationId = 'californiasgreatamerica';

    super(options);
  }
}

export class CanadasWonderland extends TE2Destination {
  constructor(options = {}) {
    options.timezone = 'America/Toronto';
    options.venueId = 'CF_CW';
    options.destinationId = 'canadaswonderland';

    super(options);
  }
}

export class Carowinds extends TE2Destination {
  constructor(options = {}) {
    options.timezone = 'America/New_York';
    options.venueId = 'CF_CA';
    options.destinationId = 'carowinds';

    super(options);
  }
}

export class KingsIsland extends TE2Destination {
  constructor(options = {}) {
    options.timezone = 'America/New_York';
    options.venueId = 'CF_KI';
    options.destinationId = 'kingsisland';

    super(options);
  }
}

export class DorneyPark extends TE2Destination {
  constructor(options = {}) {
    options.timezone = 'America/New_York';
    options.venueId = 'CF_DP';
    options.destinationId = 'dorneypark';

    super(options);
  }
}

export class KingsDominion extends TE2Destination {
  constructor(options = {}) {
    options.timezone = 'America/New_York';
    options.venueId = 'CF_KD';
    options.destinationId = 'kingsdominion';

    super(options);
  }
}

export class MichigansAdventure extends TE2Destination {
  constructor(options = {}) {
    options.timezone = 'America/Detroit';
    options.venueId = 'CF_MA';
    options.destinationId = 'michigansadventure';

    super(options);
  }
}

export class ValleyFair extends TE2Destination {
  constructor(options = {}) {
    options.timezone = 'America/Chicago';
    options.venueId = 'CF_VF';
    options.destinationId = 'valleyfair';

    super(options);
  }
}

export class WorldsOfFun extends TE2Destination {
  constructor(options = {}) {
    options.timezone = 'America/Chicago';
    options.venueId = 'CF_WF';
    options.destinationId = 'worldsoffun';

    super(options);
  }
}

import {Destination} from '../destination.js';
import {attractionType, statusType, queueType, tagType, scheduleType, entityType} from '../parkTypes.js';

export class PortAventuraWorld extends Destination {
  constructor(options = {}) {
    options.timezone = options.timezone || 'Europe/Madrid';

    // accept overriding the API base URL
    options.apiBase = options.apiBase || false;

    super(options);

    if (!this.config.apiBase) throw new Error('Missing apiBase');

    this.destinationId = 'portaventuraworld';

    const baseURLHostname = new URL(this.config.apiBase).hostname;
    this.http.injectForDomain({
      hostname: baseURLHostname,
    }, async (method, url, data, options) => {
      options.json = true;
    });
  }

  /**
   * Return core app config
   */
  async getAppConfig() {
    '@cache|1440'; // cache for 24 hours

    const resp = await this.http('GET', `${this.config.apiBase}ws/getUrlConfiguration/en`);

    return resp?.body;
  }

  /**
   * Map base URL
   * @returns {String}
   */
  async getMapURLBase() {
    const appConfig = await this.getAppConfig();
    return appConfig.find((x) => x.title === 'mapa')?.url;
  }

  async getDestinationData() {
    '@cache|1440'; // cache for 24 hours

    const resp = await this.http('GET', `${this.config.apiBase}ws/v3/getAllfilter/all/all/en`);

    return resp?.body;
  }

  /**
   * Get array of all the park configs in this resort
   * @returns {array<Object>}
   */
  async getParkData() {
    const locations = await this.getDestinationData();
    return locations.map((x, idx) => {
      x.park_number = idx + 1;
      return x;
    }).filter((x) => {
      return !!x.filters.find((y) => y.id === 'atraccion');
    });
  }

  /**
   * Return mapping of "parque_nombre" to park data objects
   * @returns {Object}
   */
  async getParkMappings() {
    // @cache|60
    const parks = await this.getParkData();
    return parks.reduce((acc, x) => {
      acc[x.park_number] = {...x};
      return acc;
    }, []);
  }

  /**
   * Return the attraction data (both static and live) for the destination.
   * Used for building attaction entities and the live data
   */
  async _fetchAttractionData() {
    '@cache|1'; // cache for 1 minute

    const parks = await this.getParkData();

    const data = [];

    for (const park of parks) {
      const liveDataResp = await this.http('GET', `${this.config.apiBase}/ws/nv/filters/${park.id}/atraccion/en`);
      data.push(...liveDataResp.body);
    }

    return data;
  }

  /**
   * Helper function to build a basic entity document
   * Useful to avoid copy/pasting
   * @param {object} data 
   * @returns {object}
   */
  buildBaseEntityObject(data) {
    const entity = Destination.prototype.buildBaseEntityObject.call(this, data);

    if (data?.titulo) {
      entity.name = data.titulo;
    }

    if (data?.latitud && data?.longitud) {
      entity.location = {
        longitude: Number(data.longitud),
        latitude: Number(data.latitud),
      };
    }

    if (data?.id) {
      entity._id = `${data.id}`;
    }

    return entity;
  }

  /**
   * Build the destination entity representing this destination
   */
  async buildDestinationEntity() {
    const doc = {};
    return {
      ...this.buildBaseEntityObject(doc),
      _id: this.destinationId,
      slug: this.destinationId,
      name: 'PortAventura World',
      entityType: entityType.destination,
    };
  }

  /**
   * Build the park entities for this destination
   */
  async buildParkEntities() {
    const parks = await this.getParkData();
    return parks.map((x) => {
      return {
        ...this.buildBaseEntityObject(null),
        _id: x.id,
        _destinationId: this.destinationId,
        _parentId: this.destinationId,
        slug: x.id,
        name: x.texto,
        entityType: entityType.park,
      };
    });
  }

  /**
   * Build the attraction entities for this destination
   */
  async buildAttractionEntities() {
    const parkMappings = await this.getParkMappings();
    const data = await this._fetchAttractionData();

    return data.filter((x) => {
      // only return attractions
      return x.tipo === 'atraccion';// && !!parkMappings[x.parque_nombre];
    }).map((ent) => {
      return {
        ...this.buildBaseEntityObject(ent),
        _parentId: parkMappings[ent.parque_id].id,
        _destinationId: this.destinationId,
        _parkId: parkMappings[ent.parque_id].id,
        entityType: entityType.attraction,
        attractionType: attractionType.ride,
      };
    });
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
    return [];
  }

  /**
   * @inheritdoc
   */
  async buildEntityLiveData() {
    const liveData = await this._fetchAttractionData();

    return liveData.map((ride) => {
      // parse wait time
      let waitTime = -1;
      if (ride.time_range) {
        const parsedTime = /(\d+) min/.exec(ride.time_range);
        if (parsedTime) {
          waitTime = Number(parsedTime[1]);
        } else {
          // support hour:minute times
          const parsedTimeHour = /(\d+)(?::(\d+))?\s?h/.exec(ride.time_range);
          if (parsedTimeHour) {
            waitTime = Number(parsedTimeHour[1]) * 60 + Number(parsedTimeHour[2] || 0);
          } else {
            this.log(`Unable to parse wait time for ${ride.id}: ${ride.time_range}`);
          }
        }
      }

      const rideData = {
        _id: `${ride.id}`,
        // default to status: operating
        status: statusType.operating,
      }

      if (ride.location_status === 1) {
        if (waitTime >= 0) {
          rideData.queue = {
            [queueType.standBy]: {
              waitTime: waitTime,
            },
          };
        }
      } else {
        if (ride.location_status === 0) {
          rideData.status = statusType.closed;
        } else {
          // TODO - other statuses
          rideData.status = statusType.down;
        }
      }

      return rideData;
    });
  }

  /**
   * Fetch calendar data for a specific date
   * @param {string} date YYYY-MM-DD
   * @returns 
   */
  async _fetchScheduleForDate(date) {
    '@cache|10080'; // cache for 1 week
    const url = `${this.config.apiBase}ws/getCalendar/${date}/en`;
    const resp = await this.http('GET', url);
    return resp.body;
  }

  /**
   * Return schedule data for all scheduled entities in this destination
   * Eg. parks
   * @returns {array<object>}
   */
  async buildEntityScheduleData() {
    // TODO - once app is returning some opening data, parse it
    const dateData = await this.forEachUpcomingDate(async (date) => {
      const dateString = date.format('YYYY-MM-DD');
      return {
        date: date.clone(),
        ...(await this._fetchScheduleForDate(dateString)),
      };
    }, 30);

    const parkData = await this.getParkData();
    return parkData.map((park) => {
      return {
        _id: `${park.id}`,
        schedule: dateData.map((x) => {
          const dataForThisPark = x[`${park.park_number}`];
          if (!dataForThisPark) {
            return null;
          }

          // ignore closed dates
          if (dataForThisPark.estado == "Closed") {
            return null;
          }

          const splitHours = dataForThisPark.horario.split('-').map(x => x.trim());
          if (splitHours.length !== 2) {
            return null;
          }
          const matchHours = (hours) => {
            const match = /^([0-9]{1,2})((?::[0-9]{2}))?/.exec(hours);
            if (!match) {
              return null;
            }
            return {
              hours: Number(match[1]),
              minutes: match[2] ? Number(match[2].replace(':', '')) : 0,
            };
          };

          const matchStart = matchHours(splitHours[0]);
          if (!matchStart) {
            return null;
          }
          const matchEnd = matchHours(splitHours[1]);
          if (!matchEnd) {
            return null;
          }

          return {
            date: x.date.format('YYYY-MM-DD'),
            type: "OPERATING",
            openingTime: x.date.clone().hours(parseInt(matchStart.hours, 10)).minutes(parseInt(matchStart.minutes, 10)).seconds(0).format(),
            closingTime: x.date.clone().hours(parseInt(matchEnd.hours, 10)).minutes(parseInt(matchEnd.minutes, 10)).seconds(0).format(),
          };
        }).filter((x) => !!x),
      };
    });
  }
}

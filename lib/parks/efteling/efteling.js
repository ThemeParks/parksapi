import {attractionType, statusType, queueType, tagType, scheduleType, entityType} from '../parkTypes.js';
import moment from 'moment-timezone';
import Destination from '../destination.js';

/**
 * Efteling Park Object
 */
export class Efteling extends Destination {
  /**
   * Create a new Efteling Park object
   * @param {object} options
   */
  constructor(options = {}) {
    options.name = options.name || 'Efteling';
    options.timezone = options.timezone || 'Europe/Amsterdam';

    options.apiKey = options.apiKey || '';
    options.apiVersion = options.apiVersion || '';
    options.appVersion = options.appVersion || '';

    options.searchUrl = options.searchUrl || 'https://prd-search-acs.efteling.com/2013-01-01/search';
    options.waitTimesUrl = options.waitTimesUrl || 'https://api.efteling.com/app/wis/';

    // bump cache to invalidate the POI data that has been updated
    options.cacheVersion = 1;

    super(options);

    if (!this.config.apiKey) throw new Error('Missing Efteling apiKey');
    if (!this.config.apiVersion) throw new Error('Missing Efteling apiVersion');
    if (!this.config.appVersion) throw new Error('Missing Efteling appVersion');

    this.http.injectForDomain({
      // match either of the API domains
      $or: [
        {
          hostname: 'api.efteling.com',
        },
        {
          hostname: 'prd-search-acs.efteling.com',
        },
      ],
    }, (method, url, data, options) => {
      // all requests from the app to any efteling subdomain should send these headers
      options.headers['x-app-version'] = this.config.appVersion;
      options.headers['x-app-name'] = 'Efteling';
      options.headers['x-app-id'] = 'nl.efteling.android';
      options.headers['x-app-platform'] = 'Android';
      options.headers['x-app-language'] = 'en';
      options.headers['x-app-timezone'] = this.config.timezone;
      // override user-agent here, rather than class-wide
      //  any other non-Efteling API requests can use the default user-agent
      options.headers['user-agent'] = 'okhttp/4.4.0';
      options.compressed = true;
    });

    this.http.injectForDomain({
      // only use these headers for the main API domain
      hostname: 'api.efteling.com',
    }, (method, url, data, options) => {
      // api.efteling.com requries an API key as well as the above headers
      options.headers['x-api-key'] = this.config.apiKey;
      options.headers['x-api-version'] = this.config.apiVersion;
    });
  }

  /**
   * Get Efteling POI data
   * This data contains general ride names, descriptions etc.
   * Wait time data references this to get ride names
   */
  async getPOIData() {
    // cache for 12 hours
    '@cache|720';

    // curl -H 'Host: prd-search-acs.efteling.com' -H 'user-agent: okhttp/4.4.0' -H 'x-app-version: v3.7.1' -H 'x-app-name: Efteling' -H 'x-app-id: nl.efteling.android' -H 'x-app-platform: Android' -H 'x-app-language: en' -H 'x-app-timezone: Europe/London' --compressed 'https://prd-search-acs.efteling.com/2013-01-01/search?q.parser=structured&size=1000&q=%28and%20%28phrase%20field%3Dlanguage%20%27en%27%29%29'
    const fetchedPOIData = await this.http('GET', this.config.searchUrl, {
      'size': 1000,
      'q.parser': 'structured',
      'q': '(and (phrase field=language \'en\'))',
    });

    const data = fetchedPOIData?.body?.hits?.hit;
    if (!data) {
      throw new Error('Failed to fetch Efteling POI data');
    }

    const poiData = {};
    data.forEach((hit) => {
      // skip any entries that aren't shown in the app
      if (hit.hide_in_app) return;

      if (hit.fields) {
        poiData[hit.fields.id] = {
          id: hit.fields.id,
          name: hit.fields.name,
          type: hit.fields.category,
          props: hit.fields.properties,
        };

        // try to parse lat/long
        //  edge-case: some rides have dud "0.0,0.0" location, ignore these
        if (hit.fields.latlon && hit.fields.latlon !== '0.0,0.0') {
          const match = /([0-9.]+),([0-9.]+)/.exec(hit.fields.latlon);
          if (match) {
            poiData[hit.fields.id].location = {
              latitude: Number(match[1]),
              longitude: Number(match[2]),
            };
          }
        }

        // check for any alternative versions of the ride
        //  this is usually the single rider line, though one is a "boatride"
        if (hit.fields.alternateid && hit.fields.alternatetype === 'singlerider') {
          poiData[hit.fields.id].singleRiderId = hit.fields.alternateid;
        }
      }
    });

    return poiData;
  }

  /**
   * Get calendar data for the given month and year
   * @param {string} month
   * @param {string} year
   * @return {array<object>}
   */
  async getCalendarMonth(month, year) {
    return await this.cache.wrap(`calendar_${year}_${month}`, async () => {
      const data = await this.http(
        'GET',
        `https://www.efteling.com/service/cached/getpoiinfo/en/${year}/${month}`,
        null,
        {
          headers: {
            'X-Requested-With': 'XMLHttpRequest',
            'referer': 'https://www.efteling.com/en/park/opening-hours?app=true',
            'cookie': 'website#lang=en',
          },
          json: true,
        },
      );

      // Efteling returns 400 once the month is in the past
      if (data.statusCode === 400) {
        return undefined;
      }

      if (!data?.body?.OpeningHours) throw new Error(`Unable to find opening hours for Efteling ${data.body}`);

      return data.body;
    }, 1000 * 60 * 60 * 12); // 12 hours
  }

  /**
 * Get restaurant operating hours from API
 * @param {string} day
 * @param {string} month
 * @param {string} year
 */
  async getRestaurantOperatingHours(day, month, year) {
    return await this.cache.wrap(`restaurant_${year}_${month}_${day}`, async () => {
      const waitTimes = await this.http('GET', this.config.waitTimesUrl, {
        language: 'en',
      });

      if (!waitTimes?.body?.AttractionInfo) {
        throw new Error(`Unable to find restaurant operating hours for Efteling ${data.body}`);
      }

      return waitTimes.body;
    }, 1000 * 60 * 60 * 12); // 12 hours
  }

  /**
   * Return restaurant operating hours for the supplied date
   * @param {moment} date
   */
  async _getRestaurantOperatingHoursForDate(date) {
    const cal = await this.getRestaurantOperatingHours(date.format('D'), date.format('M'), date.format('YYYY'));

    if (cal === undefined) return undefined;

    const data = cal.AttractionInfo;

    return data.map((entry) => {
      if (entry.Type !== 'Horeca') return;

      if (!entry.OpeningTimes || entry.OpeningTimes.length == 0) {
        return {
          restaurantID: entry.Id,
          openingTime: 0,
          closingTime: 0,
          status: statusType.closed,
        };
      }

      const openingTimes = entry.OpeningTimes;

      return {
        restaurantID: entry.Id,
        openingTime: moment(openingTimes[0].HourFrom).format(),
        closingTime: moment(openingTimes[0].HourTo).format(),
        type: scheduleType.operating,
      };
    }).filter((x) => x !== undefined);
  }

  /**
   * Helper function to build a basic entity document
   * Useful to avoid copy/pasting
   * @param {object} data 
   * @returns {object}
   */
  buildBaseEntityObject(data) {
    const entity = Destination.prototype.buildBaseEntityObject.call(this, data);

    entity._id = data?.id || entity._id;
    entity.name = data?.name || entity.name;

    // add location (if found)
    if (data?.location !== undefined) {
      entity.location = {
        longitude: data.location.longitude,
        latitude: data.location.latitude,
      };
    }

    // TODO - extra facet data
    /*
    // look for any other useful tags
    // may get wet
    await this.toggleAttractionTag(id, tagType.mayGetWet, p.props.indexOf('wet') >= 0);
    // tag "pregnant people should not ride" attractions
    await this.toggleAttractionTag(
      id,
      tagType.unsuitableForPregnantPeople,
      p.props.indexOf('pregnantwomen') >= 0,
    );

    // single rider queue available?
    await this.setAttractionTag(
      id,
      null,
      tagType.singleRider,
      !!p.singleRiderId,
    );

    // look for attraction minimum height
    const minHeightProp = p.props.find((prop) => prop.indexOf('minimum') === 0);
    if (minHeightProp !== undefined) {
      const minHeightNumber = Number(minHeightProp.slice(7));
      if (!isNaN(minHeightNumber)) {
        await this.setAttractionTag(id, 'minimumHeight', tagType.minimumHeight, {
          height: minHeightNumber,
          unit: 'cm',
        });
      }
    }*/

    return entity;
  }

  /**
   * Build the destination entity representing this destination
   */
  async buildDestinationEntity() {
    return {
      ...this.buildBaseEntityObject({
        name: "Efteling Themepark Resort",
      }),
      _id: 'eftelingresort',
      slug: 'eftelingresort',
      entityType: entityType.destination,
    };
  }

  /**
   * Build the park entities for this destination
   */
  async buildParkEntities() {
    const destination = await this.buildDestinationEntity();
    return [
      {
        ...this.buildBaseEntityObject({
          name: this.config.name,
        }),
        _id: 'efteling',
        _destinationId: destination._id,
        _parentId: destination._id,
        slug: 'efteling',
        entityType: entityType.park,
      },
    ];
  }

  async _buildArrayOfEntitiesOfType(type, fields = {}) {
    const destination = await this.buildDestinationEntity();
    const poi = await this.getPOIData();

    // some valid attraction types from the Efteling API:
    // 'attraction', 'show', 'merchandise', 'restaurant', 'fairytale', 'facilities-toilets', 'facilities-generic', 'eventlocation', 'game'

    const attrs = [];

    const poiKeys = Object.keys(poi);
    for (let i = 0; i < poiKeys.length; i++) {
      const id = poiKeys[i];
      const p = poi[id];

      // if poi data matches our wanted types
      if (p.type === type) {
        const attr = {
          ...fields,
          ...this.buildBaseEntityObject(p),
          _destinationId: destination._id,
          // TODO - are all rides/shows inside the park?
          _parkId: 'efteling',
          _parentId: 'efteling',
        };

        attrs.push(attr);
      }
    }

    return attrs;
  }

  /**
   * Build the attraction entities for this destination
   */
  async buildAttractionEntities() {
    return this._buildArrayOfEntitiesOfType('attraction', {
      entityType: entityType.attraction,
      attractionType: attractionType.ride,
    });
  }

  /**
   * Build the show entities for this destination
   */
  async buildShowEntities() {
    return this._buildArrayOfEntitiesOfType('show', {
      entityType: entityType.show,
    });
  }

  /**
   * Build the restaurant entities for this destination
   */
  async buildRestaurantEntities() {
    // TODO
    return [];
  }

  async _fetchWaitTimes() {
    // cache 1 minute
    '@cache|1';
    return (await this.http('GET', this.config.waitTimesUrl, {
      language: 'en',
    })).body;
  }

  /**
   * @inheritdoc
   */
  async buildEntityLiveData() {
    const poiData = await this.getPOIData();

    // this function should return all the live data for all entities in this destination
    const waitTimes = await this._fetchWaitTimes();

    const attractions = waitTimes?.AttractionInfo;
    if (!attractions) throw new Error('Efteling wait times response missing AttractionInfo');

    const livedata = [];

    // first, look for single-rider entries
    const singleRiderData = [];
    for (let i = 0; i < attractions.length; i++) {
      const entry = attractions[i];
      if (poiData[entry.Id] === undefined) {
        // if we don't have POI data for this attraction, check for single rider IDs and update the main attraction
        const singleRiderPOI = Object.keys(poiData).find((k) => {
          return poiData[k].singleRiderId && poiData[k].singleRiderId === entry.Id;
        });

        if (singleRiderPOI !== undefined) {
          // we have found a matching single-rider entry!
          singleRiderData.push({
            id: singleRiderPOI,
            time: parseInt(entry.WaitingTime, 10),
          });
        }
      }
    }

    for (let i = 0; i < attractions.length; i++) {
      const entry = attractions[i];
      if (entry.Type !== 'Attraction') continue;
      if (poiData[entry.Id] === undefined) continue;

      const live = {
        _id: entry.Id,
      };

      let rideStatus = null;
      const rideWaitTime = parseInt(entry.WaitingTime, 10);
      const rideState = entry.State.toLowerCase();
      // update ride with wait time data
      if (rideState === 'storing' || rideState === 'tijdelijkbuitenbedrijf') {
        // Ride down because of an interruption
        rideStatus = statusType.down;
      } else if (rideState === 'buitenbedrijf') {
        // ride is closed "for the day"
        rideStatus = statusType.closed;
      } else if (rideState === 'inonderhoud') {
        // Ride down because of maintenance/refurbishment
        rideStatus = statusType.refurbishment;
      } else if (rideState === 'gesloten' || rideState === '' || rideState === 'wachtrijgesloten') {
        // ride is "closed"
        rideStatus = statusType.closed;
      } else if (rideState === 'open') {
        // Ride operating
        rideStatus = statusType.operating;
      }

      if (rideStatus === null) {
        this.emit('error', new Error(`Unknown Efteling rideStatus ${JSON.stringify(rideState)}`));
        console.log('Unknown Efteling rideStatus', JSON.stringify(rideState));
      }

      live.status = rideStatus;
      live.queue = {
        [queueType.standBy]: {
          waitTime: rideStatus == statusType.operating ? rideWaitTime : null,
        },
      };

      // add any single rider data (if available)
      const singleRider = singleRiderData.find((x) => x.id === entry.Id);
      if (singleRider) {
        live.queue[queueType.singleRider] = {
          waitTime: rideStatus == statusType.operating ? singleRider.time : null,
        };
      }

      livedata.push(live);
    }

    return livedata;
  }

  /**
   * Return schedule data for all scheduled entities in this destination
   * Eg. parks
   * @returns {array<object>}
   */
  async buildEntityScheduleData() {
    // get operating hours for next x months
    const parkSchedule = [];

    const now = this.getTimeNowMoment();
    const monthsToFetch = 3;
    const end = now.clone().add(monthsToFetch, 'months');
    for (; now.isSameOrBefore(end, 'month'); now.add(1, 'month')) {
      const calData = await this.getCalendarMonth(now.format('M'), now.format('YYYY'));
      if (calData === undefined) continue;

      calData.OpeningHours.forEach((x) => {
        const date = moment.tz(x.Date, 'YYYY-MM-DD', this.config.timezone);
        x.OpeningHours.forEach((d) => {
          const open = d.Open.split(':').map(Number);
          const close = d.Close.split(':').map(Number);
          parkSchedule.push({
            date: date.format('YYYY-MM-DD'),
            openingTime: date.clone().set('hour', open[0]).set('minute', open[1]).format(),
            closingTime: date.clone().set('hour', close[0]).set('minute', close[1]).format(),
            type: scheduleType.operating,
          });
        });
      });
    }

    return [
      {
        _id: 'efteling',
        schedule: parkSchedule,
      }
    ];
  }

}

export default Efteling;

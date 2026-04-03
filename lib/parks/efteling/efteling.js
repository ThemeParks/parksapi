import {attractionType, statusType, queueType, tagType, scheduleType, entityType, returnTimeState} from '../parkTypes.js';
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

    options.virtualQueueWindowMinutes = options.virtualQueueWindowMinutes || 15;

    // bump cache to invalidate the POI data that has been updated
    options.cacheVersion = 2;

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
        {
          hostname: 'cloud.efteling.com',
        }
      ],
    }, (method, url, data, options) => {
      options.headers = options.headers || {};
      // all requests from the app to any efteling subdomain should send these headers
      options.headers['x-app-version'] = this.config.appVersion;
      options.headers['x-app-name'] = 'Efteling';
      options.headers['x-app-id'] = 'nl.efteling.android';
      options.headers['x-app-platform'] = 'Android';
      options.headers['x-app-language'] = options.headers['x-app-language'] || 'en';
      options.headers['x-app-timezone'] = this.config.timezone;
      // override user-agent here, rather than class-wide
      //  any other non-Efteling API requests can use the default user-agent
      options.headers['user-agent'] = 'okhttp/4.12.0';
      options.compressed = true;
    });

    this.http.injectForDomain({
      // only use these headers for the main API domain
      hostname: 'api.efteling.com',
    }, (method, url, data, options) => {
      options.headers = options.headers || {};
      // api.efteling.com requries an API key as well as the above headers
      options.headers['x-api-key'] = this.config.apiKey;
      options.headers['x-api-version'] = this.config.apiVersion;
    });
  }

  /**
   * Fetch POI data from Efteling API
   * @return {array<object>}
   */
  async _fetchPOIData({language = 'en'} = {}) {
    // cache for 12 hours
    '@cache|720';
    const data = await this.http(
      'GET',
      'https://api.efteling.com/app/poi',
      null,
      {
        headers: {
          'x-app-language': language,
        },
        json: true,
      },
    );

    return data?.body?.hits?.hit || null;
  }

  /**
   * Get Efteling POI data
   * This data contains general ride names, descriptions etc.
   * Wait time data references this to get ride names
   */
  async getPOIData() {
    '@cache|5';

    // grab English data first
    const data = await this._fetchPOIData({language: 'en'});
    if (!data) {
      throw new Error('Failed to fetch Efteling POI data [en]');
    }

    // also grab native language data and insert any missing entries
    const nativeData = await this._fetchPOIData({language: 'nl'});
    if (!nativeData) {
      throw new Error('Failed to fetch Efteling POI data [nl]');
    }

    // merge EN/NL entries by ID with EN as primary and NL fallback
    const englishMap = new Map();
    const nativeMap = new Map();
    data.forEach((item) => {
      if (item?.fields?.id) englishMap.set(item.fields.id, item);
    });
    nativeData.forEach((item) => {
      if (item?.fields?.id) nativeMap.set(item.fields.id, item);
    });

    const allIds = new Set([...englishMap.keys(), ...nativeMap.keys()]);
    const mergedData = [...allIds].map((id) => englishMap.get(id) || nativeMap.get(id));

    const poiData = {};
    mergedData.forEach((hit) => {
      if (!hit?.fields) return;
      // skip any entries that aren't shown in the app
      if (hit.hide_in_app || hit.fields.hide_in_app) return;

      poiData[hit.fields.id] = {
        id: hit.fields.id,
        name: hit.fields.name,
        type: hit.fields.category,
        props: hit.fields.properties,
      };

      // hard-code station names so they can be distinct
      if (hit.fields.id === 'stoomtreinr') {
        poiData[hit.fields.id].name = poiData[hit.fields.id].name + ' - Oost';
      }
      if (hit.fields.id === 'stoomtreinm') {
        poiData[hit.fields.id].name = poiData[hit.fields.id].name + ' - Marerijk';
      }

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

    // extra facet data from POI props
    if (data?.props) {
      entity._tags = [];

      // may get wet
      if (data.props.indexOf('wet') >= 0) {
        entity._tags.push({ id: tagType.mayGetWet, value: true });
      }

      // unsuitable for pregnant people
      if (data.props.indexOf('pregnantwomen') >= 0) {
        entity._tags.push({ id: tagType.unsuitableForPregnantPeople, value: true });
      }

      // single rider queue available
      if (data.singleRiderId) {
        entity._tags.push({ id: tagType.singleRider, value: true });
      }

      // minimum height
      const minHeightProp = data.props.find((prop) => prop.indexOf('minimum') === 0);
      if (minHeightProp !== undefined) {
        const minHeightNumber = Number(minHeightProp.slice(7));
        if (!isNaN(minHeightNumber)) {
          entity._tags.push({ id: tagType.minimumHeight, value: { height: minHeightNumber, unit: 'cm' } });
        }
      }
    }

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
      location: {
        latitude: 51.649515,
        longitude: 5.043776
      },
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
        location: {
          latitude: 51.649515,
          longitude: 5.043776
        }
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
    return (await this._buildArrayOfEntitiesOfType('restaurant', {
      entityType: entityType.restaurant,
    })).filter((x) => x.location);
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

    // helper function to create or get a live data entry
    const createOrGetLiveData = (id) => {
      // smush standby and virtual queue data together for droomvlucht
      if (id === 'droomvluchtstandby') {
        return createOrGetLiveData('droomvlucht');
      }

      const existing = livedata.find((x) => x._id === id);
      if (existing) return existing;

      const newEntry = {
        _id: id,
        status: null,
      };

      livedata.push(newEntry);

      return newEntry;
    };

    const populateAttractionLiveData = (entry) => {
      const live = createOrGetLiveData(entry.Id);
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
      } else if (rideState === 'gesloten' || rideState === '' || rideState === 'wachtrijgesloten' || rideState === 'nognietopen') {
        // ride is "closed"
        rideStatus = statusType.closed;
      } else if (rideState === 'open') {
        // Ride operating
        rideStatus = statusType.operating;
      }

      live.status = rideStatus || live.status;

      if (live.status === null) {
        this.emit('error', new Error(`Unknown Efteling rideStatus ${JSON.stringify(rideState)}`));
        console.log('Unknown Efteling rideStatus', JSON.stringify(rideState));
      }

      live.queue = {
        [queueType.standBy]: {
          waitTime: rideStatus == statusType.operating ? (
            isNaN(rideWaitTime) ? null : rideWaitTime
          ) : null,
        },
      };

      // add any single rider data (if available)
      const singleRider = singleRiderData.find((x) => x.id === entry.Id);
      if (singleRider) {
        live.queue[queueType.singleRider] = {
          waitTime: rideStatus == statusType.operating ? (
            isNaN(singleRider.time) ? null : singleRider.time
          ) : null,
        };
      }

      // TODO - add virtual queue data
      if (entry.VirtualQueue) {
        // debugger;
        // known states:
        //  walkin (park not open, but there is a virtual queue)
        //  enabled (virtual queue is open)
        //  full (virtual queue is full for the day)

        const vqObj = {
          state: returnTimeState.finished,
          returnStart: null,
          returnEnd: null,
        };

        if (entry.VirtualQueue.State === 'walkin') {
          // walkin = "Currently, you do not need to join the virtual queue"
          vqObj.state = returnTimeState.temporarilyFull;
          vqObj.returnStart = null;
          vqObj.returnEnd = null;

        } else if (entry.VirtualQueue.State === 'enabled') {
          vqObj.state = returnTimeState.available;

          // generate startTime for return time by adding the waiting time to the current time
          const nowInPark = this.getTimeNowMoment();
          const startTime = nowInPark.clone().set({
            // blank out the seconds and milliseconds
            seconds: 0,
            milliseconds: 0,
          }).add(entry.VirtualQueue.WaitingTime, 'minutes');
          vqObj.returnStart = startTime.format();

          // you have a 15 minute window to return, according to the app
          vqObj.returnEnd = startTime.clone().add(this.config.virtualQueueWindowMinutes, 'minutes').format();
        } else if (entry.VirtualQueue.State === 'full') {
          // full
          vqObj.state = returnTimeState.finished;
          vqObj.returnStart = null;
          vqObj.returnEnd = null;
        } else {
          this.emit('error', new Error(`Unknown Efteling VirtualQueue state ${JSON.stringify(entry.VirtualQueue)}`));
          console.log('Unknown Efteling virtualQueue state', JSON.stringify(entry.VirtualQueue));

          // TODO - add any other valid states
        }

        live.queue[queueType.returnTime] = vqObj;
      }
    };

    const populateRestaurantLiveData = (entry) => {
      const live = createOrGetLiveData(entry.Id);
      const state = entry.State?.toLowerCase();
      live.status = state === 'open' ? statusType.operating : statusType.closed;

      if (entry.OpeningTimes && entry.OpeningTimes.length > 0) {
        live.operatinghours = entry.OpeningTimes.map((ot) => ({
          startTime: moment.tz(ot.HourFrom, 'YYYY-MM-DDTHH:mm:ssZ', this.config.timezone).format(),
          endTime: moment.tz(ot.HourTo, 'YYYY-MM-DDTHH:mm:ssZ', this.config.timezone).format(),
          type: scheduleType.operating,
        }));
      }
    };

    const populateShowLiveData = (entry) => {
      const live = createOrGetLiveData(entry.Id);
      live.status = statusType.operating;
      // if we have no upcoming showtimes, assume the show is closed
      if (!entry.ShowTimes || entry.ShowTimes.length === 0) {
        live.status = statusType.closed;
      }

      const allTimes = (entry.ShowTimes || []).concat(entry.PastShowTimes || []);
      live.showtimes = allTimes.map((time) => {
        const show = {
          type: time.Edition || 'Showtime',
          startTime: moment.tz(time.StartDateTime, 'YYYY-MM-DDTHH:mm:ssZ', this.config.timezone).format(),
          endTime: moment.tz(time.EndDateTime, 'YYYY-MM-DDTHH:mm:ssZ', this.config.timezone).format(),
        };

        return show;
      });
    };

    // only process POI types that we actually build entities for (skip resort-only types)
    const validPoiTypes = new Set(['attraction', 'show', 'restaurant']);

    for (let i = 0; i < attractions.length; i++) {
      const entry = attractions[i];
      // special case: droomvluchtstandby
      if (entry.Id !== 'droomvluchtstandby') {
        // skip entries that don't have POI data, or have POI data but no location
        if (!poiData[entry.Id]?.location) continue;
        // skip resort-only POI types
        if (!validPoiTypes.has(poiData[entry.Id].type)) continue;
      }

      // populate live data for attractions
      if (entry.Type === 'Attraction' || entry.Type === 'Attracties') {
        populateAttractionLiveData(entry);
      }

      // populate live data for shows
      if (entry.Type === 'Shows en Entertainment') {
        populateShowLiveData(entry);
      }

      // populate live data for restaurants/food stands
      if (entry.Type === 'Eten en Drinken') {
        populateRestaurantLiveData(entry);
      }
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
        x.OpeningHours.sort((a, b) => a.Open - b.Open);
        x.OpeningHours.forEach((d, idx) => {
          const open = d.Open.split(':').map(Number);
          const close = d.Close.split(':').map(Number);
          parkSchedule.push({
            date: date.format('YYYY-MM-DD'),
            openingTime: date.clone().set('hour', open[0]).set('minute', open[1]).format(),
            closingTime: date.clone().set('hour', close[0]).set('minute', close[1]).format(),
            type: idx === 0 ? scheduleType.operating : scheduleType.informational,
            description: idx === 0 ? undefined : 'Evening Hours',
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

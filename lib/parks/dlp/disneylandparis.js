import {v4 as uuid} from 'uuid';
import {Destination} from '../destination.js';
import {attractionType, statusType, queueType, scheduleType, returnTimeState, entityType} from '../parkTypes.js';
import moment from 'moment-timezone';
import sift from 'sift';

const ignoreEntities = [
  '00000', // Avengers Campus
];

/**
 * Disneyland Paris Park Object
 */
export class DisneylandParis extends Destination {
  /**
   * Create a new DisneylandParis object
   * @param {object} options
   */
  constructor(options = {}) {
    options.name = options.name || 'Disneyland Paris';
    options.timezone = options.timezone || 'Europe/Paris';

    options.apiKey = options.apiKey || '';
    options.apiBase = options.apiBase || '';
    options.apiBaseWaitTimes = options.apiBaseWaitTimes || '';
    options.language = options.language || 'en-gb';

    options.standbyApiBase = options.standbyApiBase || '';
    options.standbyApiKey = options.standbyApiKey || '';
    options.standbyApiUser = options.standbyApiUser || '';
    options.standbyApiPass = options.standbyApiPass || '';
    options.standbyAuthURL = options.standbyAuthURL || '';

    options.useragent = options.useragent || 'okhttp/3.12.1';

    options.configPrefixes = ['DLP'].concat(options.configPrefixes || []);

    options.cacheVersion = 2;

    super(options);

    if (!this.config.apiKey) throw new Error('Missing Disneyland Paris apiKey');
    if (!this.config.apiBase) throw new Error('Missing Disneyland Paris apiBase');
    if (!this.config.apiBaseWaitTimes) throw new Error('Missing Disneyland Paris apiBaseWaitTimes');

    if (!this.config.standbyApiBase) throw new Error('Missing Disneyland Paris standbyApiBase');
    if (!this.config.standbyApiKey) throw new Error('Missing Disneyland Paris standbyApiKey');
    if (!this.config.standbyApiUser) throw new Error('Missing Disneyland Paris standbyApiUser');
    if (!this.config.standbyApiPass) throw new Error('Missing Disneyland Paris standbyApiPass');
    if (!this.config.standbyAuthURL) throw new Error('Missing Disneyland Paris standbyAuthURL');

    // attraction data domain
    this.http.injectForDomain({
      hostname: new URL(this.config.apiBase).hostname,
    }, async (method, url, data, options) => {
      options.headers['x-application-id'] = 'mobile-app';
      options.headers['x-request-id'] = uuid();
      options.json = true;
    });

    // live wait time domain
    this.http.injectForDomain({
      hostname: new URL(this.config.apiBaseWaitTimes).hostname,
    }, async (method, url, data, options) => {
      options.headers['x-api-key'] = this.config.apiKey,
        options.headers.accept = 'application/json, text/plain, */*';
    });

    // virtual queue domain
    this.http.injectForDomain({
      hostname: new URL(this.config.standbyApiBase).hostname,
    }, async (method, url, data, options) => {
      const authData = await getAuthToken();
      if (!authData) {
        throw new Error(`Unable to get auth token for DLP virtual queue access: ${JSON.stringify(authData)}`);
      }

      options.headers['x-api-key'] = this.config.standbyApiKey,
        options.headers['authorization'] = `BEARER ${authData}`,
        options.headers.accept = 'application/json, text/plain, */*';
    });

    this.http.injectForDomainResponse({
      hostname: new URL(this.config.standbyApiBase).hostname,
    }, async (resp) => {
      if (resp.statusCode === 401) {
        // unset our api key so we refetch it
        console.log('Failed to get vqueue, fetch our auth key again...');
        await this.cache.set('dlp_apikey', undefined, -1);
        return undefined;
      }

      return resp;
    });

    this.http.injectForDomainResponse({
      hostname: new URL(this.config.standbyAuthURL).hostname,
    }, async (resp) => {
      if (resp.statusCode === 400) {
        // fetch our API key and try again
        await this.cache.set('dlp_authapikey', undefined, -1);
        return undefined;
      }

      return resp;
    });
  }

  /*
  async _buildAttractionObject(attractionID) {
    const parkData = await this.getParkData();

    const attr = parkData.find((x) => {
      return x.id === attractionID;
    });
    if (attr === undefined) return undefined;

    // attraction tags
    const tags = [];

    // attraction have fastpass?
    tags.push({
      type: tagType.fastPass,
      value: !!attr.fastPass,
    });

    // on-ride photos?
    tags.push({
      type: tagType.onRidePhoto,
      value: !!attr.photopass,
    });

    // single rider queue available?
    tags.push({
      type: tagType.singleRider,
      value: !!attr.singleRider,
    });

    // location
    if (attr.coordinates) {
      const entrance = attr.coordinates.find((x) => x.type === 'Guest Entrance');
      if (entrance) {
        tags.push({
          type: tagType.location,
          key: 'location',
          value: {
            longitude: entrance.lng,
            latitude: entrance.lat,
          },
        });
      }
    }

    // height tag
    if (attr.height !== undefined) {
      attr.height.forEach((height) => {
        // skip attractions for "any height"
        if (height.id === 'anyHeight') return;

        const heightVal = /([\d\.]+)\s+(\w+)/.exec(height.value);
        if (heightVal) {
          const unit = heightVal[2];
          tags.push({
            type: tagType.minimumHeight,
            key: height.id,
            value: {
              height: Number(heightVal[1]) * (unit === 'm' ? 100 : 1),
              unit: 'cm',
            },
          });
        }
      });
    }

    // may get wet
    tags.push({
      type: tagType.mayGetWet,
      value: attr.interests ? !!attr.interests.find((x) => x.id === 'guestMayGetSplashed') : false,
    });

    // pregnant riders
    tags.push({
      type: tagType.unsuitableForPregnantPeople,
      value: attr.physicalConsiderations ?
        !!attr.physicalConsiderations.find((x) => x.id === 'expectantMothersMayNotRide') :
        false,
    });

    return {
      name: attr.name,
      // TODO - sort rides from other attractions
      type: attr.contentType === 'Attraction' ? attractionType.ride : attractionType.other,
      tags,
    };
  }*/

  /**
   * Get API key for authentication
   * @returns {string}
   */
  async getAuthApiKey() {
    return await this.cache.wrap(`dlp_authapikey`, async () => {
      const data = await this.http('POST', `${this.config.standbyAuthURL}api-key`, null);
      return data?.headers?.['api-key'];
    }, 1000 * 60 * 60 * 24); // 24-hours, will be refreshed if we need to fetch a new one
  }

  /**
   * Fetch our auth token to access the HTTP API
   * @returns {string}
   */
  async getAuthToken() {
    let expiryTime = 1000 * 60 * 60; // default: 1 hour
    return await this.cache.wrap(`dlp_apikey`, async () => {
      const apiApiKey = await this.getAuthApiKey();
      if (apiApiKey === undefined) return undefined;

      const requestOptions = {
        headers: {
          'authorization': `APIKEY ${apiApiKey}`,
          // eslint-disable-next-line max-len
          'user-agent': 'Mozilla/5.0 (Linux; Android 11; ONEPLUS A5000 Build/PQ3A.190801.002; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/85.0.4183.127 Mobile Safari/537.36',
        },
        json: true,
      };

      const login = () => {
        console.log('Logging in to DLP fresh...');
        return this.http('POST', `${this.config.standbyAuthURL}guest/login`, {
          'loginValue': this.config.standbyApiUser,
          'password': this.config.standbyApiPass,
        }, requestOptions);
      };
      const refresh = () => {
        console.log('Refreshing DLP token...');
        return this.http('POST', `${this.config.standbyAuthURL}guest/refresh-auth`, {
          'refreshToken': refreshToken,
        }, requestOptions);
      };

      // either login or refresh based on presense of our resfresh token
      const refreshToken = await this.cache.get('dlp_refreshtoken');
      const wantRefresh = refreshToken !== undefined;
      let resp = await (wantRefresh ? refresh() : login());
      if (!resp.body && wantRefresh) {
        // if we fail to refresh, and wanted to refresh... login again instead
        resp = await login();
      }

      const data = resp?.body?.data?.token;
      if (data === undefined) {
        return undefined;
      }

      // API returns expiry time in seconds
      expiryTime = data.ttl * 1000;

      // store our refresh token separately
      await this.cache.set('dlp_refreshtoken', data.refresh_token, 1000 * 60 * 60 * 24 * 7);

      // return just our token
      return data.access_token;
    }, expiryTime);
  }

  /**
   * Get Destination POI Data
   * @returns {array}
   */
  async getPOIData() {
    // cache 12 hours
    '@cache|720';
    const fetchedData = await this.http('POST', `${this.config.apiBase}/query`, {
      // eslint-disable-next-line max-len
      query: 'query activities($market: String!, $types: [String]) { activities(market: $market, types: $types) { id closed contentType: __typename name subType entityType coordinates { lat lng } pageLink { tcmId regions { templateId schemaId } } schedules { status } squareMediaMobile { url alt } location { id value urlFriendlyId iconFont } hideFunctionality ... on Attraction { age { ...f } height { ...f } interests { ...f } photopass fastPass singleRider mobilityDisabilities { ...f } serviceAnimals { ...f } physicalConsiderations { ...f } } ... on Entertainment { relatedLocations { ...r } openDate endDate photopass schedules { startTime date } interests { ...f } age { ...f } entertainmentTypes { ...f } mobilityDisabilities { ...f } } ... on Event { relatedLocations { ...r } interests { ...f } mobilityDisabilities { ...f } experienceTypes { ...f } age { ...f } } ... on GuestService { guestServices { ...f } relatedLocations { ...r poi { name location { value pageLink { tcmId regions { templateId schemaId } } } smallMedia { url alt } } } } ... on Recreation { relatedLocations { ...r } } ... on Resort { disneyOwned hotelBeingRefurbished tier hotelCharacteristics { ...f } hotelTypes { ...f } hotelCategories { ...f } hotelParkDistances { ...f } hotelAmenities { ...f } } ... on DinnerShow { cuisines { ...f } serviceTypes { ...f } price { ...f } diningPlans { ...f } } ... on DiningEvent { cuisines { ...f } serviceTypes { ...f } price { ...f } diningPlans { ...f } } ... on Restaurant { drsApp clickAndCollect cuisines { ...f } serviceTypes { ...f } price { ...f } diningPlans { ...f } } ... on Shop { schedules { startTime endTime } merchandises { ...f } mobilityDisabilities { ...f } } ... on Spa { relatedLocations { ...r } serviceTypes { ...f } interests { ...f } } ... on Tour { interests { ...f } mobilityDisabilities { ...f } experienceTypes { ...f } age { ...f } } } } fragment r on RelatedLocation { type poi { coordinates { lat lng } } } fragment f on Facet { id value urlFriendlyId iconFont } ',
      variables: {
        market: this.config.language,
        types: [
          'Attraction',
          'DiningEvent',
          'DinnerShow',
          'Entertainment',
          'Event',
          'GuestService',
          'Recreation',
          'Resort',
          'Restaurant',
          'Shop',
          'Spa',
          'Tour',
          'ThemePark',
        ],
      },
    });

    return fetchedData.body.data.activities;
  }

  /**
   * Helper function to build a basic entity document
   * Useful to avoid copy/pasting
   * @param {object} data 
   * @returns {object}
   */
  buildBaseEntityObject(data) {
    const entity = Destination.prototype.buildBaseEntityObject.call(this, data);

    entity._id = data?.id;
    entity.name = data?.name;

    // try and find location data
    if (data?.coordinates) {
      const entrance = data.coordinates.find((x) => x.type === 'Guest Entrance' || x.type === undefined);
      if (entrance) {
        entity.location = {
          longitude: entrance.lng,
          latitude: entrance.lat,
        };
      }
    }

    // TODO - facets

    return entity;
  }

  /**
   * Build the destination entity representing this destination
   */
  async buildDestinationEntity() {
    return {
      ...this.buildBaseEntityObject(),
      _id: 'dlp',
      name: this.config.name,
      slug: 'disneylandparis',
      entityType: entityType.destination,
    };
  }

  /**
   * Build the park entities for this destination
   */
  async buildParkEntities() {
    // find all destination parks
    const poiData = await this.getPOIData();
    const parks = poiData.filter((x) => {
      return x.contentType === 'ThemePark';
    });

    const destination = await this.buildDestinationEntity();

    return parks.map((x) => {
      return {
        ...this.buildBaseEntityObject(x),
        _destinationId: destination._id,
        _parentId: destination._id,
        slug: x.name.toLowerCase().replace(/[^a-z]/g, ''),
        entityType: entityType.park,
      };
    });
  }

  async getEntitiesOfTypes(filterObj, data) {
    const parkData = await this.getPOIData();
    if (!parkData) return [];

    const attrs = parkData.filter(sift(filterObj));

    const destination = await this.buildDestinationEntity();

    return attrs.map((x) => {
      // skip placeholders
      if (ignoreEntities.indexOf(x?.id) >= 0) return undefined;

      return {
        ...this.buildBaseEntityObject(x),
        ...data,
        _destinationId: destination._id,
        _parentId: x?.location?.id,
        _parkId: x?.location?.id,
      };
    }).filter((x) => !!x).filter((x) => {
      // remove any entities with invalid locations (placeholder/defunct)
      return x.location?.longitude !== 0 && x.location?.latitude !== 0;
    });
  }

  /**
   * Build the attraction entities for this destination
   */
  async buildAttractionEntities() {
    return this.getEntitiesOfTypes({
      entityType: 'attractions',
    }, {
      entityType: entityType.attraction,
      attractionType: attractionType.ride,
    });
  }

  /**
   * Build the show entities for this destination
   */
  async buildShowEntities() {
    return this.getEntitiesOfTypes({
      entertainmentTypes: {
        $elemMatch: {
          id: 'stageShows',
        },
      }
    }, {
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

  /**
   * Get wait time raw data
   * @returns {object}
   */
  async fetchWaitData() {
    '@cache|1';
    try {
      return (await this.http('GET', `${this.config.apiBaseWaitTimes}waitTimes`)).body;
    } catch (e) {
      console.error(`DLP error: getResortWaitTimes ${e}`);
      throw e;
    }
  }

  /**
   * Fetch virtual queue status
   * @returns {array}
   */
  async fetchVirtualQueueData() {
    '@cache|1';
    if (!process.env.DLP_VQUEUE) {
      return [];
    }

    try {
      const standByVirtualData = await this.http('GET', this.config.standbyApiBase);
      return standByVirtualData.body;
    } catch (e) {
      console.error(`DLP error: getResortVirtualQueues ${e}`);
      throw e;
    }
  }

  /**
   * @inheritdoc
   */
  async buildEntityLiveData() {
    // this function should return all the live data for all entities in this destination
    const waits = await this.fetchWaitData();

    if (!Array.isArray(waits)) {
      // DLP is offline (?!)
      //  DLP servers go offline briefly most nights
      return [];
    }

    // TODO - virtual queues
    const vQData = await this.fetchVirtualQueueData();

    return waits.filter((x) => x.type === 'Attraction').map((time) => {
      const live = {
        _id: time.entityId,
        status: statusType.operating,
      };

      if (time.status === 'DOWN') {
        live.status = statusType.down;
      } else if (time.status === 'REFURBISHMENT') {
        live.status = statusType.refurbishment;
      } else if (time.status === 'CLOSED' || time.status === null) {
        live.status = statusType.closed;
      }

      // stand-by time
      live.queue = {
        [queueType.standBy]: {
          waitTime: live.status === statusType.operating ?
            Number(time.postedWaitMinutes) :
            null,
        },
      };

      // single-rider time
      if (time.singleRider?.isAvailable === true) {
        live.queue[queueType.singleRider] = {
          waitTime: live.status === statusType.operating ?
            Number(time.singleRider.singleRiderWaitMinutes) :
            null,
        };
      }

      // look for virtual queue entries
      const rideVQueue = vQData.find((x) => x?.attractionId == time.entityId);
      if (rideVQueue !== undefined) {
        live.queue[queueType.returnTime] = {
          returnStart: moment.tz(rideVQueue.timeSlotStartDatetime, 'YYYY-MM-DD HH:mm', this.config.timezone),
          returnEnd: moment.tz(rideVQueue.timeSlotEndDatetime, 'YYYY-MM-DD HH:mm', this.config.timezone),
          state: rideVQueue.uiStatus === 'Available' ? returnTimeState.available : returnTimeState.finished,
        };
      }

      return live;
    });
  }

  /**
   * Fetch schedule data for a specific day
   * DLP's API returns one day at a time
   * @param {string} date YYYY-MM-DD format
   * @returns {array<schedule>}
   */
  async fetchResortScheduleForDate(date) {
    // cache for a week
    '@cache|10080';
    const fetchedData = await this.http('POST', `${this.config.apiBase}/query`, {
      // eslint-disable-next-line max-len
      'query': 'query activitySchedules($market: String!, $types: [ActivityScheduleStatusInput]!, $date: String!) { activitySchedules(market: $market, date: $date, types: $types) { __typename id name subType url pageLink { url regions { contentId templateId schemaId } } heroMediaMobile { url alt } squareMediaMobile { url alt } hideFunctionality containerTcmId urlFriendlyId location { ...location } subLocation { ...location } type subType schedules(date: $date, types: $types) { startTime endTime date status closed language } } } fragment location on Location { id value urlFriendlyId iconFont pageLink { url tcmId title regions { contentId templateId schemaId } } } ',
      'variables': {
        'market': 'en-gb',
        'types': [{
          'type': 'ThemePark',
          'status': ['OPERATING', 'EXTRA_MAGIC_HOURS'],
        }, {
          'type': 'Entertainment',
          'status': ['PERFORMANCE_TIME'],
        }, {
          'type': 'Attraction',
          'status': ['OPERATING', 'REFURBISHMENT', 'CLOSED'],
        }, {
          'type': 'Resort',
          'status': ['OPERATING', 'REFURBISHMENT', 'CLOSED'],
        }, {
          'type': 'Shop',
          'status': ['REFURBISHMENT', 'CLOSED'],
        }, {
          'type': 'Restaurant',
          'status': ['REFURBISHMENT', 'CLOSED', 'OPERATING'],
        }, {
          'type': 'DiningEvent',
          'status': ['REFURBISHMENT', 'CLOSED'],
        }, {
          'type': 'DinnerShow',
          'status': ['REFURBISHMENT', 'CLOSED'],
        }],
        'date': date,
      },
    });

    return fetchedData.body.data.activitySchedules;
  }

  /**
   * Return schedule data for all scheduled entities in this destination
   * Eg. parks
   * @returns {array<object>}
   */
  async buildEntityScheduleData() {
    // TODO - fetch schedule data some way into the future
    const now = this.getTimeNowMoment();
    const end = now.clone().add(60, 'days');

    const scheduleData = [];
    const momentParseFormat = 'YYYY-MM-DDTHH:mm:ss';

    for (; now.isSameOrBefore(end, 'day'); now.add(1, 'day')) {
      const dateString = now.format('YYYY-MM-DD');
      const dateData = await this.fetchResortScheduleForDate(dateString);
      if (!dateData) continue;

      dateData.forEach((x) => {
        if (ignoreEntities.indexOf(x?.id) >= 0) return;

        let sched = scheduleData.find((a) => a._id === x.id);
        if (!sched) {
          sched = scheduleData[scheduleData.push({
            _id: x.id,
            schedule: [],
          }) - 1];
        }

        x.schedules.forEach((hours) => {
          sched.schedule.push({
            date: dateString,
            openingTime: moment.tz(`${dateString}T${hours.startTime}`, momentParseFormat, this.config.timezone).format(),
            closingTime: moment.tz(`${dateString}T${hours.endTime}`, momentParseFormat, this.config.timezone).format(),
            // our graphql query only wants types of "OPERATING" or "EXTRA_MAGIC_HOURS", so we can ternery op this
            type: hours.status === 'EXTRA_MAGIC_HOURS' ? scheduleType.extraHours : scheduleType.operating,
            description: hours.status === 'EXTRA_MAGIC_HOURS' ? 'Extra Magic Hours' : undefined,
          });
        });
      });
    }

    return scheduleData;
  }


}

export default DisneylandParis;

/*
export class DisneylandParisMagicKingdom extends DisneylandParis {
  constructor(options = {}) {
    options.name = options.name || 'Disneyland Paris - Magic Kingdom';
    options.parkId = options.parkId || 'P1';
    super(options);
  }
}

export class DisneylandParisWaltDisneyStudios extends DisneylandParis {
  constructor(options = {}) {
    options.name = options.name || 'Disneyland Paris - Walt Disney Studios';
    options.parkId = options.parkId || 'P2';
    super(options);
  }
}
*/
import {v4 as uuid} from 'uuid';
import {Park} from '../park.js';
import {attractionType, statusType, queueType, tagType, scheduleType, returnTimeState} from '../parkTypes.js';
import {reusePromise} from '../../reusePromises.js';
import moment from 'moment-timezone';

let parkDataController = undefined;
/**
 * Get the park data for both parks at once.
 * This exists outside the scope of the park objects, so we can share the data between them.
 */
async function getResortParkData() {
  try {
    if (parkDataController === undefined) {
      return undefined;
    }

    // cache attraction data in the global cache
    const data = await parkDataController.cache.wrapGlobal('dlp_parkdata', async () => {
      const fetchedData = await parkDataController.http('POST', `${parkDataController.config.apiBase}/query`, {
      // eslint-disable-next-line max-len
        query: 'query activities($market: String!, $types: [String]) { activities(market: $market, types: $types) { contentType: __typename entityType contentId id name location { ...location } coordinates { ...coordinates } disneyOwned disneyOperated closed schedules { language startTime endTime date status closed } ... on Attraction { age { ...facet } height { ...facet } interests { ...facet } photopass fastPass singleRider mobilityDisabilities { ...facet } sensoryDisabilities { ...facet } serviceAnimals { ...facet } physicalConsiderations { ...facet } physicalWarning } } } fragment facet on Facet { id value urlFriendlyId iconFont } fragment location on Location { id value urlFriendlyId iconFont } fragment coordinates on MapCoordinates { lat lng type } ',
        variables: {
          market: parkDataController.config.language,
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
          ],
        },
      });

      return fetchedData.body;
    }, 1000 * 60 * 60 * 12); // 12 hours

    return data.data.activities;
  } catch (e) {
    console.error(`DLP error: getResortParkData ${e}`);
    throw e;
  }
}

/**
 * Get the park schedules for both parks at once.
 * This exists outside the scope of the park objects, so we can share the data between them.
 * @param {string} date Date to query in YYYY-MM-DD format
 */
async function getResortSchedules(date) {
  try {
    if (parkDataController === undefined) {
      return undefined;
    }

    // cache attraction data in the global cache
    const data = await parkDataController.cache.wrapGlobal(`dlp_parkschedules_${date}`, async () => {
      const fetchedData = await parkDataController.http('POST', `${parkDataController.config.apiBase}/query`, {
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

      return fetchedData.body;
    }, 1000 * 60 * 60 * 24 * 7); // 1 week

    return data.data.activitySchedules;
  } catch (e) {
    console.error(`DLP error: getResortSchedules(${date}) ${e}`);
    throw e;
  }
}


/**
 * Get the park wait times for both parks at once.
 * This exists outside the scope of the park objects, so we can share the data between them.
 */
async function getResortWaitTimes() {
  try {
    if (parkDataController === undefined) {
      return undefined;
    }

    return await parkDataController.cache.wrapGlobal(`dlp_waittimes`, async () => {
      return (await parkDataController.http('GET', `${parkDataController.config.apiBaseWaitTimes}waitTimes`)).body;
    }, 1000 * 30); // 30 seconds
  } catch (e) {
    console.error(`DLP error: getResortWaitTimes ${e}`);
    throw e;
  }
}

/**
 * Get the API key we need to get the API key
 */
async function getAuthApiKey() {
  if (parkDataController === undefined) {
    return undefined;
  }

  return await parkDataController.cache.wrapGlobal(`dlp_authapikey`, async () => {
    const data = await parkDataController.http('POST', `${parkDataController.config.standbyAuthURL}api-key`, null);
    return data?.headers?.['api-key'];
  }, 1000 * 60 * 60 * 24); // 24-hours, will be refreshed if we need to fetch a new one
}

/**
 * Get Auth token for fetching virtual queues
 */
async function getAuthToken() {
  let expiryTime = 1000 * 60 * 60; // default: 1 hour
  return await parkDataController.cache.wrapGlobal(`dlp_apikey`, async () => {
    const apiApiKey = await getAuthApiKey();
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
      return parkDataController.http('POST', `${parkDataController.config.standbyAuthURL}guest/login`, {
        'loginValue': parkDataController.config.standbyApiUser,
        'password': parkDataController.config.standbyApiPass,
      }, requestOptions);
    };
    const refresh = () => {
      console.log('Refreshing DLP token...');
      return parkDataController.http('POST', `${parkDataController.config.standbyAuthURL}guest/refresh-auth`, {
        'refreshToken': refreshToken,
      }, requestOptions);
    };

    // either login or refresh based on presense of our resfresh token
    const refreshToken = await parkDataController.cache.getGlobal('dlp_refreshtoken');
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
    await parkDataController.cache.setGlobal('dlp_refreshtoken', data.refresh_token, 1000 * 60 * 60 * 24 * 7);

    // return just our token
    return data.access_token;
  }, expiryTime);
}

/**
 * Get the virtual queue status for the resort
 */
async function getResortVirtualQueues() {
  if (!process.env.DLP_VQUEUE) {
    return [];
  }

  try {
    if (parkDataController === undefined) {
      return undefined;
    }

    return await parkDataController.cache.wrapGlobal(`dlp_virtualqueues`, async () => {
      try {
        const standByVirtualData = await parkDataController.http('GET', parkDataController.config.standbyApiBase);
        return standByVirtualData.body;
      } catch (err) {
        console.error('Error getting virtual queue', err);
        return undefined;
      }
    }, 1000 * 30); // 30 seconds
  } catch (e) {
    console.error(`DLP error: getResortVirtualQueues ${e}`);
    throw e;
  }
}

/**
 * Disneyland Paris Park Object
 */
export class DisneylandParisPark extends Park {
  /**
   * Create a new DisneylandParisPark object
   * @param {object} options
   */
  constructor(options = {}) {
    options.name = options.name || 'Disneyland Paris Park';
    options.timezone = options.timezone || 'Europe/Paris';

    options.apiKey = options.apiKey || '';
    options.apiBase = options.apiBase || '';
    options.apiBaseWaitTimes = options.apiBaseWaitTimes || '';
    options.parkId = options.parkId || '';
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

    if (!this.config.parkId) throw new Error('Missing Disneyland Paris Park ID');

    // attraction data domain
    this.injectForDomain({
      hostname: new URL(this.config.apiBase).hostname,
    }, async (method, url, data, options) => {
      options.headers['x-application-id'] = 'mobile-app';
      options.headers['x-request-id'] = uuid();
      options.json = true;
    });

    // live wait time domain
    this.injectForDomain({
      hostname: new URL(this.config.apiBaseWaitTimes).hostname,
    }, async (method, url, data, options) => {
      options.headers['x-api-key'] = this.config.apiKey,
      options.headers.accept = 'application/json, text/plain, */*';
    });

    // virtual queue domain
    this.injectForDomain({
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
        await this.cache.setGlobal('dlp_apikey', undefined, -1);
        return undefined;
      }

      return resp;
    });

    this.http.injectForDomainResponse({
      hostname: new URL(this.config.standbyAuthURL).hostname,
    }, async (resp) => {
      if (resp.statusCode === 400) {
        // fetch our API key and try again
        await this.cache.setGlobal('dlp_authapikey', undefined, -1);
        return undefined;
      }

      return resp;
    });
  }

  /**
   * @inheritdoc
   */
  async shutdown() {
    // if we've been relying on this instance for the shared data fetches
    //  then remove ourselves so the next caller can be assigned instead
    if (parkDataController === this) {
      parkDataController = undefined;
    }

    super.shutdown();
  }

  /**
   * Get data for our park attractions
   */
  async getParkData() {
    // if none is set already, set ourselves as the object to handle shared data fetches
    if (parkDataController === undefined) {
      parkDataController = this;
    }

    // fetch from our shared data function
    const parkData = await reusePromise(null, getResortParkData);

    // filter out things within our park
    return parkData.filter((x) => {
      return x?.location?.id === this.config.parkId;
    });
  }

  /**
   * @inheritdoc
   */
  async _init() {
    // populate attractions with all park attractions before we update
    const parkData = await this.getParkData();
    const attrs = parkData.filter((x) => x.entityType === 'attractions');
    await Promise.all(attrs.forEach((a) => {
      return this.findAttractionByID(a.id);
    }));
  }

  /**
   * @inheritdoc
   */
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
  }

  /**
   * @inheritdoc
   */
  async _update() {
    if (parkDataController === undefined) {
      parkDataController = this;
    }
    const data = await getResortWaitTimes();
    if (data === undefined) {
      throw new Error(`getResortWaitTimes() returned undefined`);
    }

    // fetch virtual queue states too (ignore errors if it fails)
    let vQData = [];
    try {
      vQData = await getResortVirtualQueues();
    } catch (e) {
      console.error(e);
      vQData = [];
    }

    if (!Array.isArray(data)) {
      // DLP API usually goes offline briefly every night around midnight (local Paris time)
      //  catch and ignore unless errors go on for significant time

      // increment API error by 1
      if (this.waitApiErrorCount === undefined) this.waitApiErrorCount = 0;
      this.waitApiErrorCount++;

      // get whether we think the park should be open right now
      const isParkOpen = (await this.getNextOpeningTime()) === 0;

      // if we get at least 12 errors in a row when updating, emit an error
      if (isParkOpen || this.waitApiErrorCount >= 12) {
        const errorMessage = data?.message;
        console.trace('Error communicating with DLP Wait Time API', errorMessage);
        this.emit('error', new Error(`getResortWaitTimes didn't return an Array ${JSON.stringify(data)}`));
        return;
      }

      // early-out our update loop
      return;
    }

    // reset our API error counter if we get this far
    this.waitApiErrorCount = 0;

    // filter for wait times for our park (the above returns wait times for both parks)
    const internalParkID = `0/P/${this.config.parkId}`;
    const waitTimes = data.filter((x) => x.parkId === internalParkID && x.type === 'Attraction');

    // TODO - get park refurb data from calendar

    await Promise.allSettled(waitTimes.map(async (time) => {
      // set ride status
      // TODO - sort refurbishment state for rides
      let rideStatus = statusType.operating;
      if (time.status === 'DOWN') {
        rideStatus = statusType.down;
      } else if (time.status === 'REFURBISHMENT') {
        rideStatus = statusType.refurbishment;
      } else if (time.status === 'CLOSED' || time.status === null) {
        rideStatus = statusType.closed;
      }
      await this.updateAttractionState(time.entityId, rideStatus);

      // update standby queue
      const waitTimeMinutes = rideStatus === statusType.operating ? Number(time.postedWaitMinutes) : null;
      await this.updateAttractionQueue(
          time.entityId,
        isNaN(waitTimeMinutes) ? null : waitTimeMinutes,
        queueType.standBy,
      );

      // look for virtual queues for this ride
      const rideVQueue = vQData.find((x) => x?.attractionId == time.entityId);
      if (rideVQueue !== undefined) {
        await this.updateAttractionQueue(
            time.entityId,
            {
              returnStart: moment.tz(rideVQueue.timeSlotStartDatetime, 'YYYY-MM-DD HH:mm', this.config.timezone),
              returnEnd: moment.tz(rideVQueue.timeSlotEndDatetime, 'YYYY-MM-DD HH:mm', this.config.timezone),
              state: rideVQueue.uiStatus === 'Available' ? returnTimeState.available : returnTimeState.finished,
            },
            queueType.returnTime,
        );
      } else {
        // no vqueue, make sure it is not present on the attraction at all
        await this.updateAttractionQueue(
            time.entityId,
            undefined,
            queueType.returnTime,
        );
      }

      // single rider line?
      if (time.singleRider?.isAvailable === true) {
        await this.updateAttractionQueue(
            time.entityId,
            rideStatus === statusType.operating ?
              Number(time.singleRider.singleRiderWaitMinutes) :
              null,
            queueType.singleRider,
        );
      } else {
        // remove single rider queue if it is no longer valid
        await this.updateAttractionQueue(
            time.entityId,
            undefined,
            queueType.singleRider,
        );
      }
    }));
  }

  /**
   * @inheritdoc
   */
  async _getOperatingHoursForDate(date) {
    if (parkDataController === undefined) {
      parkDataController = this;
    }
    // fetch all calendars for the day
    const dateString = date.format('YYYY-MM-DD');
    const dateCal = await getResortSchedules(dateString);
    if (dateCal === undefined) return undefined;

    // find our park's data in our calendar object
    const parkDate = dateCal.find((x) => x.id === this.config.parkId);
    if (parkDate === undefined) return undefined;

    const momentParseFormat = 'YYYY-MM-DDTHH:mm:ss';

    return parkDate.schedules.map((hours) => {
      return {
        openingTime: moment.tz(`${dateString}T${hours.startTime}`, momentParseFormat, this.config.timezone).format(),
        closingTime: moment.tz(`${dateString}T${hours.endTime}`, momentParseFormat, this.config.timezone).format(),
        // our graphql query only wants types of "OPERATING" or "EXTRA_MAGIC_HOURS", so we can ternery op this
        type: hours.status === 'EXTRA_MAGIC_HOURS' ? scheduleType.extraHours : scheduleType.operating,
      };
    });
  }

  /**
     * Return restaurant operating hours for the supplied date
     * @param {moment} date
     */
  async _getRestaurantOperatingHoursForDate(date) {
    if (parkDataController === undefined) {
      parkDataController = this;
    }

    // fetch all calendars for the day
    const dateString = date.format('YYYY-MM-DD');
    const dateCal = await getResortSchedules(dateString);
    if (dateCal === undefined) return undefined;

    const parkDate = dateCal.filter((x) => x.id.startsWith(this.config.parkId) && x.type == 'Restaurant');
    if (parkDate === undefined) return undefined;

    const momentParseFormat = 'YYYY-MM-DDTHH:mm:ss';

    return parkDate.map((restaurantActivity) => {
      return restaurantActivity.schedules.map((restaurantSchedule) => {
        let restaurantStatus = null;

        if (restaurantSchedule.status === 'CLOSED') {
          restaurantStatus = statusType.closed;
        } else if (restaurantSchedule.status === 'OPERATING') {
          restaurantStatus = statusType.operating;
        } else if (restaurantSchedule.status === 'REFURBISHMENT') {
          restaurantStatus = statusType.refurbishment;
        }

        if (restaurantStatus === null) {
          this.emit('error', new Error(`Unknown DLP restaurantStatus ${JSON.stringify(restaurantStatus)}`));
          console.log('Unknown DLP restaurantStatus', JSON.stringify(restaurantStatus));
        }

        return {
          restaurantID: restaurantActivity.id,
          // eslint-disable-next-line max-len
          openingTime: moment.tz(`${dateString}T${restaurantSchedule.startTime}`, momentParseFormat, this.config.timezone).format(),
          // eslint-disable-next-line max-len
          closingTime: moment.tz(`${dateString}T${restaurantSchedule.endTime}`, momentParseFormat, this.config.timezone).format(),
          type: restaurantStatus,
        };
      });
    }).flatMap((x) => x);
  }
}

export default DisneylandParisPark;

/**
 * Disneyland Paris - Magic Kingdom
 */
export class DisneylandParisMagicKingdom extends DisneylandParisPark {
  /**
   * @inheritdoc
   */
  constructor(options = {}) {
    options.name = options.name || 'Disneyland Paris - Magic Kingdom';
    options.parkId = options.parkId || 'P1';
    super(options);
  }
}

/**
 * Disneyland Paris - Walt Disney Studios
 */
export class DisneylandParisWaltDisneyStudios extends DisneylandParisPark {
  /**
   * @inheritdoc
   */
  constructor(options = {}) {
    options.name = options.name || 'Disneyland Paris - Walt Disney Studios';
    options.parkId = options.parkId || 'P2';
    super(options);
  }
}

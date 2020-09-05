import {v4 as uuid} from 'uuid';
import {Park} from '../park.js';
import {attractionType, statusType, queueType, tagType, scheduleType} from '../parkTypes.js';
import {reusePromise} from '../../reusePromises.js';
import moment from 'moment-timezone';

let parkDataController = undefined;
/**
 * Get the park data for both parks at once.
 * This exists outside the scope of the park objects, so we can share the data between them.
 */
async function getResortParkData() {
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
}

/**
 * Get the park schedules for both parks at once.
 * This exists outside the scope of the park objects, so we can share the data between them.
 * @param {string} date Date to query in YYYY-MM-DD format
 */
async function getResortSchedules(date) {
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
          'status': ['REFURBISHMENT', 'CLOSED'],
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
}

/**
 * Get the park wait times for both parks at once.
 * This exists outside the scope of the park objects, so we can share the data between them.
 */
async function getResortWaitTimes() {
  if (parkDataController === undefined) {
    return undefined;
  }

  return await parkDataController.cache.wrapGlobal(`dlp_waittimes`, async () => {
    return (await parkDataController.http('GET', `${parkDataController.config.apiBaseWaitTimes}waitTimes`)).body;
  }, 1000 * 30); // 30 seconds
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

    options.useragent = options.useragent || 'okhttp/3.12.1';

    options.configPrefixes = ['DLP'].concat(options.configPrefixes || []);

    options.cacheVersion = 2;

    super(options);

    if (!this.config.apiKey) throw new Error('Missing Disneyland Paris apiKey');
    if (!this.config.apiBase) throw new Error('Missing Disneyland Paris apiBase');
    if (!this.config.apiBaseWaitTimes) throw new Error('Missing Disneyland Paris apiBaseWaitTimes');

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

      // single rider line?
      if (time.singleRider?.isAvailable === true) {
        await this.updateAttractionQueue(
            time.entityId,
            rideStatus === statusType.operating ?
              Number(time.singleRider.singleRiderWaitMinutes) :
              null,
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

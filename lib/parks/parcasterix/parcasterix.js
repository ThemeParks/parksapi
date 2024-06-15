import { Destination } from '../destination.js';
import { attractionType, statusType, queueType, tagType, scheduleType, entityType } from '../parkTypes.js';
import moment from 'moment-timezone';

const queries = {
  getConfiguration: {
    "query": "query getConfiguration($language: String!) {\n  configuration(localeFilters: {locale: $language}) {\n    parkIsOpen\n    parkOpeningTime\n    parkClosingTime\n    parkText\n    parkInfoBanner\n    parkLatitude\n    parkLongitude\n    parkRadiusMeters\n    welcomeImage\n    mapColorShow\n    mapColorRestaurant\n    minimumVersionIos\n    minimumVersionAndroid\n    cloudinaryProxyUrl\n    enableMapDirections\n    enableBillet\n    enableFavoris\n    __typename\n  }\n  locales {\n    iso\n    label\n    __typename\n  }\n}\n"
  },
  getAttractions: {
    "query": "query getAttractions($language: String!) {\n  openAttractions(localeFilters: {locale: $language}, orderBy: [{field: TITLE, order: ASC}]) {\n    id\n    drupalId\n    title\n    slug\n    summary\n    description\n    experience {\n      id\n      drupalId\n      label\n      color\n      __typename\n    }\n    mapId\n    latitude\n    longitude\n    features {\n      id\n      label\n      value\n      icon\n      __typename\n    }\n    headerV1\n    thumbnailV1\n    headerV2\n    thumbnailV2\n    sliders {\n      picture\n      order\n      __typename\n    }\n    minAge\n    order\n    isNew\n    isBest\n    hasQueuingCut\n    hasQueuingCutFear\n    hasPicturePoint\n    blocks\n    labels\n    __typename\n  }\n}\n",
  },
  spectacles: {
    "query": "query spectacles($language: String!) {\n  openShows(localeFilters: {locale: $language}, orderBy: [{field: TITLE, order: ASC}]) {\n    id\n    drupalId\n    title\n    slug\n    summary\n    description\n    mapId\n    latitude\n    longitude\n    features {\n      label\n      value\n      icon\n      __typename\n    }\n    closingTimes {\n      startAt\n      endAt\n      timezone\n      __typename\n    }\n    headerV1\n    thumbnailV1\n    headerV2\n    thumbnailV2\n    sliders {\n      picture\n      order\n      __typename\n    }\n    minAge\n    order\n    isNew\n    isBest\n    schedules\n    scheduleIsFrom\n    blocks\n    labels\n    __typename\n  }\n}\n",
  },
  attractionLatency: {
    "query": "query attractionLatency {\n  attractionLatency {\n    drupalId\n    latency\n    closingTime\n    __typename\n  }\n}\n"
  },
  restaurants: {
    "query": "query restaurants($language: String!) {\n  restaurants(localeFilters: {locale: $language}, orderBy: [{field: TITLE, order: ASC}]) {\n    id\n    drupalId\n    title\n    slug\n    type\n    kind\n    kindDrupalId\n    theme\n    themeDrupalId\n    universe\n    mealType\n    withTerrace\n    summary\n    description\n    header\n    sliders {\n      picture\n      order\n      __typename\n    }\n    mapId\n    latitude\n    longitude\n    menuUrl\n    mobileUrl\n    related {\n      id\n      __typename\n    }\n    blocks\n    labels\n    __typename\n  }\n}\n",
  },
  getCalendar: {
    "query": "query getCalendar {\n  calendar {\n    day\n    times\n    type\n    __typename\n  }\n}\n",
  },
}

export class ParcAsterix extends Destination {
  constructor(options = {}) {
    options.timezone = options.timezone || 'Europe/Paris';

    options.apiBase = options.apiBase || '';
    options.language = options.language || 'en';

    // bump cache version when we need to wipe our cached query state
    options.cacheVersion = options.cacheVersion || 2;

    super(options);

    if (!this.config.apiBase) throw new Error('Missing apiBase');
  }

  /**
   * Make a graphql query against the API using a query hash
   * @param {string} operationName 
   * @param {string} queryHash 
   * @returns {object}
   */
  async makeCachedQuery(operationName, queryHash) {
    const query = {
      operationName,
      variables: {
        language: this.config.language,
      },
    };

    if (queries[operationName]) {
      for (const k in queries[operationName]) {
        query[k] = queries[operationName][k];
      }
    } else {
      query.extensions = {
        persistedQuery: {
          version: 1,
          sha256Hash: queryHash,
        }
      };
    }

    const resp = (await this.http(
      'GET',
      `${this.config.apiBase}graphql`,
      query,
    )).body;

    if (resp?.errors) {
      if (resp.errors[0] && resp.errors[0].message) {
        throw new Error(`makeCachedQuery ${operationName} error: ${resp.errors[0].message}`);
      }
      throw new Error(`makeCachedQuery ${operationName} error: ${JSON.stringify(resp.errors)}`);
    }

    return resp;
  }

  /**
   * Get some key resort data
   */
  async getResortData() {
    // cache for 6 hours
    '@cache|360';
    return this.makeCachedQuery('getConfiguration', '765d8930f5d5a09ca39affd57e43630246b2fb683331e18938d5b2dba7cb8e8a');
  }

  /**
   * Get raw attraction data
   */
  async getAttractionData() {
    // cache for 6 hours
    '@cache|360';
    return this.makeCachedQuery('getAttractions', '5609363783d826ec6c460caa620e3ca28e651897febf6753159836ab72d8139b');
  }

  /**
   * Get raw wait time data
   */
  async getWaitTimeData() {
    '@cache|1';
    return this.makeCachedQuery('attractionLatency', '41154df6dc22d5444dcfa749b69f3f177a3736031b0ed675c1730e7c7dfc9894');
  }

  /**
   * Get raw calendar data
   */
  async getCalendarData() {
    // cache for 6 hours
    '@cache|360';
    return this.makeCachedQuery('getCalendar', '4981b5364f50dce42cfc579b6e5cbe144f8ef12e6a5d1a6c2e8681c99545f39e');
  }

  /**
   * Get raw restaurant data
   */
  async getRestaurantData() {
    // cache for 6 hours
    '@cache|360';
    return this.makeCachedQuery('restaurants', '857561404b9f5c69e651d74e0f5c0403f5bd3bd02491a0958d11d60bd8526cc9');
  }

  /**
   * Get raw show data
   */
  async getShowData() {
    // cache for 6 hours
    '@cache|360';
    return this.makeCachedQuery('spectacles', 'a3a067a0edbfb3666228d5d966d5933b1572e271b4c7f2858ce1758a2490227e');
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
      entity.name = data.title || undefined;

      entity._id = data.drupalId;

      if (data.latitude && data.longitude) {
        entity.location = {
          latitude: data.latitude,
          longitude: data.longitude,
        };
      }

      entity.fastPass = !!data.hasQueuingCut;
    }

    return entity;
  }

  /**
   * Build the destination entity representing this destination
   */
  async buildDestinationEntity() {
    return {
      ...this.buildBaseEntityObject(),
      _id: 'parcasterix',
      slug: 'parcasterix', // all destinations must have a unique slug
      name: 'Parc Asterix',
      entityType: entityType.destination,
    };
  }

  /**
   * Build the park entities for this destination
   */
  async buildParkEntities() {
    const parkData = await this.getResortData();

    return [
      {
        ...this.buildBaseEntityObject(null),
        _id: 'parcasterixpark',
        _destinationId: 'parcasterix',
        _parentId: 'parcasterix',
        slug: 'ParcAsterixPark',
        name: 'Parc Asterix',
        entityType: entityType.park,
        location: {
          longitude: parkData.data.configuration.longitude || 2.573816,
          latitude: parkData.data.configuration.latitude || 49.136750,
        },
      }
    ];
  }

  /**
   * Build the attraction entities for this destination
   */
  async buildAttractionEntities() {
    const attrs = await this.getAttractionData();

    return attrs.data.openAttractions.filter((x) => {
      return x.__typename === 'Attraction';
    }).map((x) => {
      return {
        ...this.buildBaseEntityObject(x),
        entityType: entityType.attraction,
        attractionType: attractionType.ride,
        _destinationId: 'parcasterix',
        _parentId: 'parcasterixpark',
        _parkId: 'parcasterixpark',
      };
    }).filter((x) => {
      return !!x && x._id;
    });
  }

  /**
   * Build the show entities for this destination
   */
  async buildShowEntities() {
    const attrs = await this.getShowData();

    return [];

    // TODO - format shows when app returns some data
    return attrs.data.openShows.map((x) => {
      return {
        ...this.buildBaseEntityObject(x),
        entityType: entityType.show,
        _destinationId: 'parcasterix',
        _parentId: 'parcasterixpark',
        _parkId: 'parcasterixpark',
      };
    }).filter((x) => {
      return !!x && x._id;
    });
  }

  /**
   * Build the restaurant entities for this destination
   */
  async buildRestaurantEntities() {
    const attrs = await this.getRestaurantData();

    return attrs.data.restaurants.filter((x) => {
      return x.__typename === 'Restaurant';
    }).map((x) => {
      return {
        ...this.buildBaseEntityObject(x),
        entityType: entityType.restaurant,
        _destinationId: 'parcasterix',
        _parentId: 'parcasterixpark',
        _parkId: 'parcasterixpark',
      };
    }).filter((x) => {
      return !!x && x._id;
    });
  }

  /**
   * @inheritdoc
   */
  async buildEntityLiveData() {
    const waitTimes = await this.getWaitTimeData();

    return waitTimes.data.attractionLatency.map((x) => {
      const data = {
        _id: x.drupalId,
      };

      data.status = statusType.operating;

      if (x.latency === 'FERME') {
        data.status = statusType.closed;
      } else if (x.latency !== 'OUVERT') {
        data.queue = {
          [queueType.standBy]: {
            waitTime: null,
          }
        };

        if (x.latency !== null) {
          if (x.latency.match(/^\d+$/)) {
            data.queue[queueType.standBy].waitTime = parseInt(x.latency, 10);
          } else {
            // TODO - report error in parsing latency, unknown string!
            // assume closed
            data.status = statusType.closed;
          }
        }
      }

      return data;
    });
  }

  /**
   * Return schedule data for all scheduled entities in this destination
   * Eg. parks
   * @returns {array<object>}
   */
  async buildEntityScheduleData() {
    const calendarData = await this.getCalendarData();

    const dates = [];
    const matchHours = /(\d+)h - (\d+)h/;
    calendarData.data.calendar.forEach((x) => {
      x.times.split(' et ').forEach((times) => {
        const match = matchHours.exec(times);
        if (match) {
          const date = moment.tz(x.day, 'YYYY-MM-DD', this.config.timezone);
          date.set('minute', 0).set('hour', 0).set('second', 0).set('millisecond', 0);
          dates.push({
            date: x.day,
            type: "OPERATING",
            openingTime: date.clone().set('hour', parseInt(match[1], 10)).format(),
            closingTime: date.clone().set('hour', parseInt(match[2], 10)).format(),
          });
        }
      });
    });

    return [
      {
        _id: 'parcasterixpark',
        schedule: dates,
      },
    ];
  }
}

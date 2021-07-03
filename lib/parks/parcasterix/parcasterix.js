import {Destination} from '../destination.js';
import {attractionType, statusType, queueType, tagType, scheduleType, entityType} from '../parkTypes.js';

export class ParcAsterix extends Destination {
  constructor(options = {}) {
    options.timezone = options.timezone || 'Europe/Paris';

    options.apiBase = options.apiBase || '';
    options.language = options.language || 'en';

    super(options);

    if (!this.config.apiBase) throw new Error('Missing apiBase');
  }

  /**
   * Make a graphql query against the API using a query hash
   * @param {string} operationName 
   * @param {string} queryHash 
   * @returns 
   */
  async makeCachedQuery(operationName, queryHash) {
    return (await this.http(
      'GET',
      `${this.config.apiBase}graphql`,
      {
        operationName: operationName,
        variables: `{"language":"${this.config.language}"}`,
        extensions: `{"persistedQuery":{"version":1,"sha256Hash":"${queryHash}"}}`,
      }
    )).body;
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
    return this.makeCachedQuery('getAttractions', 'b050be5162f22dea1265c6a0a6fcbbc2b7b61d54e711b67239ed7f29f5d40be2');
  }

  /**
   * Get raw wait time data
   */
  async getWaitTimeData() {
    '@cache|1';
    return this.makeCachedQuery('attractionLatency', '41154df6dc22d5444dcfa749b69f3f177a3736031b0ed675c1730e7c7dfc9894');
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
          longitude: parkData.data.configuration.longitude,
          latitude: parkData.data.configuration.latitude,
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
        _parentId: 'parcasterix',
      };
    }).filter((x) => {
      return !!x && x._id;
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
    // TODO
    return [];
    return [
      {
        _id: 'internalId',
        schedule: [
          {
            "date": "2021-05-31",
            "type": "OPERATING",
            "closingTime": "2021-05-31T19:30:00+08:00",
            "openingTime": "2021-05-31T10:30:00+08:00",
          },
        ],
      }
    ];
  }
}

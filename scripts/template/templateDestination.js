import {Destination} from '../destination.js';
import {attractionType, statusType, queueType, tagType, scheduleType, entityType} from '../parkTypes.js';

export class TemplateDestination extends Destination {
  constructor(options = {}) {
    // all destinations must have a timezone, allow overriding in constructor
    options.timezone = options.timezone || 'Europe/Berlin';

    // TODO - setup any incoming options here
    //  allow modifying options using incoming options object
    options.resortId = options.resortId || '';

    // call super() with our options object
    super(options);

    // all our options will now be in this.config
    //  $env options will have overriden anything we set earlier, allowing quick deployment of config changes
    if (!this.config.resortId) throw new Error('Missing resortId');

    // setup some API hooks
    //  we can automatically auth/react to any http requests without having to constantly rewrite the same login logic
    const baseURLHostname = new URL(this.config.baseURL).hostname;

    // setup an "injection" for a domain
    //  first argument is a sift query object that can query any parameters of a URL object
    this.http.injectForDomain({
      hostname: baseURLHostname,
    }, async (method, url, data, options) => {
      // we get an async callback with needle-style arguments
      // TODO - when we get a request for our API domain, check if we have auth credentials
      //  if not, fetch them before allowing our HTTP request to continue
      // await this.cache.set('servicetoken', await getServiceToken(), 1000 * 60 * 30);
    });

    // similarly, we can also inject into HTTP responses
    //  if we detect an unauthorised response, we can unset our local auth tokens so they are refetched
    this.http.injectForDomainResponse({
      hostname: baseURLHostname,
    }, async (response) => {
      // look for 401 HTTP code (unauthorised)
      if (response.statusCode === 401) {
        // clear out our token and try again
        // await this.cache.set('servicetoken', undefined, -1);
        // returning undefined tells our HTTP wrapper we want to try the request again
        return undefined;
      }

      // otherwise, return the actual response
      return response;
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
    return entity;
  }

  /**
   * Build the destination entity representing this destination
   */
  async buildDestinationEntity() {
    // TODO - get our destination entity data and return its object
    const doc = {};
    return {
      ...this.buildBaseEntityObject(doc),
      _id: 'resortId',
      slug: 'resortslug', // all destinations must have a unique slug
      name: this.config.name,
      entityType: entityType.destination,
    };
  }

  /**
   * Build the park entities for this destination
   */
  async buildParkEntities() {
    return [
      {
        ...this.buildBaseEntityObject(null),
        _id: 'parkId',
        _destinationId: 'resortId',
        _parentId: 'resortId',
        name: this.config.name,
        entityType: entityType.park,
      }
    ];
  }

  /**
   * Build the attraction entities for this destination
   */
  async buildAttractionEntities() {
    return [];
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
    // this function should return all the live data for all entities in this destination
    return [
      {
        // use the same _id as our entity objects use
        _id: 'internalId',
        status: statusType.operating,
        queue: {
          [queueType.standBy]: {
            waitTime: 10,
          }
        },
      },
    ];
  }

  /**
   * Return schedule data for all scheduled entities in this destination
   * Eg. parks
   * @returns {array<object>}
   */
  async buildEntityScheduleData() {
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

import moment from 'moment-timezone';
import {Park} from '../park.js';
import {attractionType, entityType, queueType, scheduleType, statusType, tagType} from '../parkTypes.js';
import Resort from '../resort.js';
import {getEntityID, IndexedWDWDB} from './wdwdb.js';

let wdwDB = null;
/**
 * Get a reference to the WDW database
 * @return {IndexedWDWDB}
 */
export function getDatabase() {
  if (!wdwDB) {
    wdwDB = new IndexedWDWDB();
  }
  return wdwDB;
}

// entity types that count as "parks"
const parkTypes = [
  'theme-park',
  'water-park',
];

/**
 * Base Disney Park Class
 */
export class DisneyPark extends Park {
  /**
   * Create a new DisneyPark object
   * @param {object} options
   */
  constructor(options = {}) {
    options.resort_id = options.resort_id || '';
    options.park_id = options.park_id || '';

    if (!options.configPrefixes) {
      options.configPrefixes = ['wdw'];
    }

    super(options);

    if (this.config.park_id === '') {
      throw new Error(`Missing park_id for class ${this.constructor.name}`);
    }
    if (this.config.resort_id === '') {
      throw new Error(`Missing resort_id for class ${this.constructor.name}`);
    }

    this.refurbs = [];
  }

  /**
 * Get the live WDW database object
 * @return {object} wdwdb live database instance
 */
  static getDatabase() {
    if (!wdwDB) {
      wdwDB = new IndexedWDWDB();
    }
    return wdwDB;
  }

  /**
   * Get the channel ID for the facility status live update documents
   * @return {string}
   */
  getFacilityStatusChannelID() {
    return `${this.config.resort_id}.facilitystatus.1_0`;
  }

  /**
   * Get calendar document ID for resort. This will include closures, refurbishments etc.
   * @param {Moment} date
   * @return {string} Document ID
   */
  getCalendarDocumentIDForDate(date) {
    return `${this.config.resort_id}.calendar.1_0.${date.format('DD-MM')}`;
  }

  /**
   * Get calendar data from WDW database for a given date
   * @param {Moment} date
   */
  async getDatabaseCalendarForDate(date) {
    const docID = this.getCalendarDocumentIDForDate(date);
    await this.init(); // make sure we're setup
    return await this.db.get(docID);
  }

  /**
   * Update resort's refurbishment data
   */
  async updateRefurbishments() {
    const calendar = await this.getDatabaseCalendarForDate(await this.getActiveParkDateMoment());
    const refurbData = calendar?.refurbishments;

    // capture rides previously down for refurb and mark them as closed instead
    const oldRefurbs = JSON.parse(JSON.stringify(this.refurbs));

    this.refurbs = [];
    for (let i = 0; i < refurbData.length; i++) {
      if (refurbData[i].scheduleType !== 'Refurbishment') continue;

      const entityID = getEntityID(refurbData[i].facilityId);
      // search our index to make sure this attraction is in the correct park
      const updateIndexEntry = await this.db.getEntityIndex(entityID, {
        park_id: `${this.config.park_id}`,
      });

      if (updateIndexEntry.length === 0) continue;

      this.refurbs.push({
        entityID,
      });
    }

    // mark attractions that were previously refurbed, but now aren't, as closed instead
    for (let i = 0; i < oldRefurbs.length; i++) {
      if (this.refurbs.findIndex((x) => x.entityID === oldRefurbs[i].entityID) < 0) {
        await this.updateAttractionState(oldRefurbs[i].entityID, statusType.closed);
      }
    }

    // mark any entities in refurb list as down for refurbishment
    for (let i = 0; i < this.refurbs.length; i++) {
      await this.updateAttractionState(this.refurbs[i].entityID, statusType.refurbishment);
    }
  }

  /**
   * @inheritdoc
   */
  async _dateRefresh(newDate, oldDate) {
    // date has changed for our resort, update daily refurbishment schedule
    await this.updateRefurbishments();
  }

  /**
   * @inheritdoc
   */
  async _init() {
    // get a reference to our shared live database
    this.db = DisneyPark.getDatabase();

    // make sure the shared database is initialised
    await this.db.init();
  }

  /**
   * @inheritdoc
   */
  async _postInit() {
    // fetch latest refurb data
    await this.updateRefurbishments();

    // subscribe to any live facility status updates
    this.db.subscribeToChannel(this.getFacilityStatusChannelID(), async (doc) => {
      this._processAttractionStatusUpdate(doc);
    });

    // fetch the current attraction times
    const allStatusDocs = await this.db.getByChannel(this.getFacilityStatusChannelID());
    await Promise.allSettled(allStatusDocs.map(this._processAttractionStatusUpdate.bind(this)));
  }

  /**
   * Process a document update from a facilitystatus channel
   * @param {object} doc The updated document
   */
  async _processAttractionStatusUpdate(doc) {
    // get our clean attraction ID
    const entityID = getEntityID(doc.id);

    // check attraction is within our park
    const updateIndexEntry = await this.db.getEntityIndex(entityID, {
      park_id: `${this.config.park_id}`,
    });

    // if we have no entries, then attraction is not in our park
    if (updateIndexEntry.length === 0) {
      return;
    }

    // get full attraction document
    let attraction;
    try {
      attraction = await this.db.get(updateIndexEntry[0]._id);
    } catch (e) {
      return;
    }
    if (attraction === undefined) return;

    // figure out general ride status
    let status = statusType.operating;

    // if our status document contains singleRider, then tag it
    //  this is only available in live data, so we have to do it in our update
    await this.toggleAttractionTag(entityID, tagType.singleRider, !!doc.singleRider);

    // restaurants can have status "Capacity", "Walk-Up Disabled"
    //  currently these fallback to "Operating", which matches the resturant state well enough

    if (doc.status === 'Down') {
      status = statusType.down;
    } else if (doc.status === 'Closed') {
      status = statusType.closed;
    } else if (doc.status === 'Refurbishment') {
      status = statusType.refurbishment;
    }
    // TODO - "Virtual Queue" status

    // if name contains "Temporarily Unavailable", mark as closed
    if (attraction.name.indexOf(' - Temporarily Unavailable') > 0) {
      status = statusType.closed;
    }

    // check our refurb data and override any incoming status
    if (this.refurbs.find((x) => x.entityID === entityID) !== undefined) {
      status = statusType.refurbishment;
    }

    if (status == statusType.operating) {
      // override status if the lastUpdate is really out-of-date
      const statusUpdateTime = moment(doc.lastUpdate);
      const now = this.getTimeNowMoment();
      if (now.diff(statusUpdateTime, 'days') > 2) {
        status = statusType.closed;
        doc.waitMinutes = null;
      }
    }

    // update attraction state
    await this.updateAttractionState(entityID, status);

    // update attraction standby queue
    await this.updateAttractionQueue(entityID, doc.waitMinutes, queueType.standBy);

    // if the ride has a single rider queue, record one with "null" to say it exists, we just don't it's length
    await this.updateAttractionQueue(entityID, !!doc.singleRider ? null : undefined, queueType.singleRider);
  }

  /**
   * Build an attraction object from an ID
   * @param {string} attractionID Unique Attraction ID
   */
  async _buildAttractionObject(attractionID) {
    // find a document for our attraction ID
    const attr = await this.db.getEntityOne(attractionID);
    if (attr) {
      const tags = [];

      // pregnant persons advisory
      const pregnantWarning = attr.facets && !!attr.facets.find((f) => f.id === 'expectant-mothers');
      tags.push({
        type: tagType.unsuitableForPregnantPeople,
        value: pregnantWarning,
      });

      // fast pass
      tags.push({
        type: tagType.fastPass,
        value: !!attr.fastPassPlus,
      });

      // TODO - min height

      if (attr.longitude && attr.latitude) {
        // ride location tag
        tags.push({
          key: 'location',
          type: tagType.location,
          value: {
            longitude: Number(attr.longitude),
            latitude: Number(attr.latitude),
          },
        });
      }

      let attrEntityType = entityType.attraction;

      if (attr.type.toLowerCase() === 'restaurant') {
        attrEntityType = entityType.restaurant;
      }

      return {
        name: attr.name,
        entityType: attrEntityType,
        type: attr.type === 'Attraction' ? attractionType.ride : attractionType.other, // TODO - sort attraction types
        tags,
      };
    }

    return undefined;
  }

  /**
   * @inheritdoc
   */
  async _update() {
    // TODO - parks that don't use the live database need to implement this function
  }

  /**
   * Return the operating hours for the supplied date
   * @param {moment} date
   */
  async _getOperatingHoursForDate(date) {
    // TODO - wrap/cache this in Park so we don't keep fetching this date all the time
    const dateCalendar = await this.db.getByChannel(
        `${this.config.resort_id}.calendar.1_0`,
        {
          'id': date.format('DD-MM'),
        },
    );

    if (dateCalendar.length >= 1) {
      const calendar = dateCalendar[0];

      const validHours = calendar.parkHours.filter((h) => {
        // filter by hours for this park
        return getEntityID(h.facilityId) === this.config.park_id &&
          // that aren't closed hours (just ignore these)
          h.scheduleType !== 'Closed' &&
          // ignore annual pass blockout data
          h.scheduleType.indexOf('blockout') < 0;
      });

      return validHours.map((x) => {
        let hoursType = scheduleType.operating;

        switch (x.scheduleType) {
          case 'Operating':
            hoursType = scheduleType.operating;
            break;
          case 'Park Hopping':
            hoursType = scheduleType.informational;
            break;
          default:
            // default to a ticketed event
            hoursType = scheduleType.ticketed;
            break;
        }

        return {
          openingTime: moment(x.startTime).tz(this.config.timezone).format(),
          closingTime: moment(x.endTime).tz(this.config.timezone).format(),
          type: hoursType,
          description: hoursType != scheduleType.operating ? x.scheduleType : undefined,
        };
      });
    }

    return undefined;
  }
}

export default DisneyPark;


/**
 * A Resort class for a Disney live resort (WDW, DLR, HKDR)
 */
export class DisneyLiveResort extends Resort {
  /**
   * @inheritdoc
   */
  constructor(options = {}) {
    super(options);

    this.resortId = options.resortId;
    if (!this.resortId) {
      throw new Error('Missing Resort ID');
    }
    this.resortShortcode = options.resortShortcode;
    if (!this.resortShortcode) {
      throw new Error('Missing Resort Shortcode');
    }
    this.destinationDocumentIDRegex = new RegExp(`^${this.resortId};entityType=destination`);
    this.parkIds = options.parkIds || [];

    this.db = getDatabase();
  }

  /**
   * Initialise our Disney resort class
   */
  async _init() {
    await this.db.init();
  }

  /**
   * Get the channel ID for the facility status live update documents
   * @return {string}
   */
  getFacilityStatusChannelID() {
    return `${this.resortShortcode}.facilitystatus.1_0`;
  }

  /**
   * Given a status doc, build a live data object
   * @param {object} doc
   */
  async _buildLiveDataObject(doc) {
    return {
      _id: doc.id,
      __id: doc._id,
      status: doc.status,
    };
  }

  /**
   * Return all current live entity data
   */
  async buildEntityLiveData() {
    // fetch the current attraction times
    const allStatusDocs = await this.db.getByChannel(this.getFacilityStatusChannelID());
    // TODO - return objects
    const docs = await Promise.allSettled(allStatusDocs.map(this._buildLiveDataObject.bind(this)));

    // TODO - do something with invalid objects (?!)
    // const errors = docs.filter((x) => x.status !== 'fulfilled');

    return docs
        .filter((x) => x.status === 'fulfilled')
        .map((x) => x.value);
  }

  /**
   * Setup our live status update subscriptions
   */
  async initLiveStatusUpdates() {
    // subscribe to any live facility status updates
    // TODO
    /*
    this.db.subscribeToChannel(this.getFacilityStatusChannelID(), async (doc) => {
      this._processAttractionStatusUpdate(doc);
    });
    */
  }

  /**
   * Given a basic document build a generic entity doc.
   * This should include all fields that are in any entity type.
   * @param {object} doc
   * @return {object}
   */
  buildBaseEntityObject(doc) {
    const entity = {
      // add any resort-agnostic data from the parent first
      ...super.buildBaseEntityObject(doc),
      _id: doc.id,
      _docId: doc._id,
      name: doc.name.replace(' - Temporarily Unavailable', ''),
      // TODO - how to build good URL slugs?
      slug: doc.name.replace(' - Temporarily Unavailable', '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase(),
    };

    if (doc.longitude && doc.latitude) {
      entity.location = {
        longitude: Number(doc.longitude),
        latitude: Number(doc.latitude),
        // TODO - return entrance/exit/shop/etc. interesting points
        //  that aren't neccessarily the "main location"
        pointsOfInterest: [],
      };
    }

    // search for any related locations that is a theme-park - this tells us this entity is within this park!
    //  set this so we can correctly build our entity heirarchy
    // skip if our type is actuall "theme-park", as parks aren't parented to themselves
    if (parkTypes.indexOf(doc.type) < 0 && doc.relatedLocations && doc.relatedLocations.length > 0 && doc.relatedLocations[0].ancestors) {
      // try to find parkId (if it exists)
      const park = doc.relatedLocations[0].ancestors.find((x) => {
        return parkTypes.indexOf(x.type) >= 0;
      });
      if (park) {
        entity._parkId = park.id;
      }
    }

    // if we're not inside a park, parent ourselves to the *something*
    const nonParkParentPriority = [
      'theme-park',
      'water-park',
      'Entertainment-Venue', // eg. Disney Springs
      'destination',
    ];
    // look through list in order until we find an entity we can attach to
    let parentDoc;
    if (doc.relatedLocations && doc.relatedLocations.length > 0 && doc.relatedLocations[0].ancestors) {
      for (let parentTypeIdx = 0; parentTypeIdx < nonParkParentPriority.length; parentTypeIdx++) {
        const parentType = nonParkParentPriority[parentTypeIdx];
        parentDoc = doc.relatedLocations[0].ancestors.find((x) => {
          return x.type === parentType && x.id !== doc.relatedLocations[0].id;
        });
        if (parentDoc) break;
      }

      if (parentDoc) {
        entity._parentId = parentDoc.id;
      }
    }

    return entity;
  }

  /**
   * Return entity document for this resort
   */
  async buildResortEntity() {
    const resortIndex = await this.db.getEntityIndex(this.resortId, {
      entityType: 'destination',
    });
    if (resortIndex.length === 0) return undefined;

    const doc = await this.db.get(resortIndex[0]._id);

    return {
      ...this.buildBaseEntityObject(doc),
      entityType: entityType.resort,
    };
  }

  /**
   * Return all park entities for this resort
   */
  async buildParkEntities() {
    const parkData = (await Promise.all(this.parkIds.map(async (parkID) => {
      const parkDocIndex = await this.db.getEntityIndex(parkID, {
        $or: parkTypes.map((type) => {
          return {
            entityType: type,
          };
        }),
      });

      if (parkDocIndex.length === 0) return undefined;

      return this.db.get(parkDocIndex[0]._id);
    }))).filter((x) => !!x);

    const resort = await this.getResortEntity();

    return parkData.map((park) => {
      return {
        ...this.buildBaseEntityObject(park),
        entityType: entityType.park,
        // parks are parented to the resort
        _parentId: resort._id,
      };
    });
  }

  /**
   * @inheritdoc
   */
  async buildAttractionEntities() {
    const attractions = await this.db.find({
      type: 'Attraction',
      relatedLocations: {
        $elemMatch: {
          ancestors: {
            $elemMatch: {
              id: {
                $regex: this.destinationDocumentIDRegex,
              },
            },
          },
        },
      },
    });

    // filter out known bad names
    const ignoreAttractions = [
      /^Disney Park Pass$/,
      /Park Pass \- Afternoon$/,
      /Play Disney Parks/,
    ];

    const entities = attractions.filter((attr) => {
      return !ignoreAttractions.find((x) => {
        return !!attr.name.match(x);
      });
    }).map((attraction) => {
      // turn into entity objects

      // TODO - add extra meta data to entity objects
      let type = attractionType.unknown;
      const hasFacet = (facet) => {
        if (!attraction?.facets) return false;
        return !!attraction.facets.find((x) => {
          return x.id === facet;
        });
      };

      // figure out ride type from available facets...
      if (
        hasFacet('slow-rides') ||
        hasFacet('small-drops') ||
        hasFacet('thrill-rides') ||
        hasFacet('spinning')
      ) {
        type = attractionType.ride;
      }

      return {
        ...this.buildBaseEntityObject(attraction),
        entityType: entityType.attraction,
        attractionType: type,
      };
    });

    return entities;
  }

  /**
   * @inheritdoc
   */
  async buildRestaurantEntities() {
    return (await this.db.find({
      type: 'restaurant',
      relatedLocations: {
        $elemMatch: {
          ancestors: {
            $elemMatch: {
              id: {
                $regex: this.destinationDocumentIDRegex,
              },
            },
          },
        },
      },
    })).map((re) => {
      return {
        ...this.buildBaseEntityObject(re),
        entityType: entityType.restaurant,
      };
    });
  }
};

/**
 * Walt Disney World Resort
 */
export class WaltDisneyWorldResort extends DisneyLiveResort {
  /**
   * @inheritdoc
   */
  constructor(options = {}) {
    options.name = options.name || 'Walt Disney World Resort';
    options.timezone = options.timezone || 'America/New_York';

    options.resortId = options.resortId || 80007798;
    options.resortShortcode = options.resortShortcode || 'wdw';

    options.parkIds = options.parkIds || [
      80007944, // Magic Kingdom
      80007838, // Epcot
      80007998, // Hollywood Studios
      80007823, // Animal Kingdom
      // water parks
      80007981, // Typhoon Lagoon
      80007834, // Blizzard Beach
    ];

    super(options);
  }
}

/**
 * Disneyland Resort
 */
export class DisneylandResort extends DisneyLiveResort {
  /**
   * @inheritdoc
   */
  constructor(options = {}) {
    options.name = options.name || 'Disneyland Resort';
    // TODO - calculate this from resort entity's location
    options.timezone = options.timezone || 'America/Los_Angeles';

    options.resortId = options.resortId || 80008297;
    options.resortShortcode = options.resortShortcode || 'dlr';

    options.parkIds = options.parkIds || [
      330339, // Disneyland Park
      336894, // California Adventure
    ];

    super(options);
  }
}

/**
 * Hong Kong Disneyland Resort
 */
export class HongKongDisneyland extends DisneyLiveResort {
  /**
   * @inheritdoc
   */
  constructor(options = {}) {
    options.name = options.name || 'HongKong Disneyland';
    // TODO - calculate this from resort entity's location
    options.timezone = options.timezone || 'Asia/Hong_Kong';

    options.resortId = options.resortId || 'hkdl';
    options.resortShortcode = options.resortShortcode || 'hkdl';

    options.parkIds = options.parkIds || [
      'desHongKongDisneyland',
    ];

    super(options);
  }
}

/**
 * Walt Disney World - Magic Kingdom
 */
export class WaltDisneyWorldMagicKingdom extends DisneyPark {
  /**
   * @inheritdoc
   */
  constructor(options = {}) {
    options.park_id = '80007944';
    options.resort_id = 'wdw';
    options.name = 'Walt Disney World - Magic Kingdom';
    options.timezone = 'America/New_York';

    super(options);
  }
}

/**
 * Walt Disney World - Epcot
 */
export class WaltDisneyWorldEpcot extends DisneyPark {
  /**
   * @inheritdoc
   */
  constructor(options = {}) {
    options.park_id = '80007838';
    options.resort_id = 'wdw';
    options.name = 'Walt Disney World - Epcot';
    options.timezone = 'America/New_York';

    super(options);
  }
}

/**
 * Walt Disney World - Hollywood Studios
 */
export class WaltDisneyWorldHollywoodStudios extends DisneyPark {
  /**
   * @inheritdoc
   */
  constructor(options = {}) {
    options.park_id = '80007998';
    options.resort_id = 'wdw';
    options.name = 'Walt Disney World - Hollywood Studios';
    options.timezone = 'America/New_York';

    super(options);
  }
}

/**
 * Walt Disney World - Animal Kingdom
 */
export class WaltDisneyWorldAnimalKingdom extends DisneyPark {
  /**
   * @inheritdoc
   */
  constructor(options = {}) {
    options.park_id = '80007823';
    options.resort_id = 'wdw';
    options.name = 'Walt Disney World - Animal Kingdom';
    options.timezone = 'America/New_York';

    super(options);
  }
}

/**
 * Disneyland Resort - Magic Kingdom
 */
export class DisneylandResortMagicKingdom extends DisneyPark {
  /**
   * @inheritdoc
   */
  constructor(options = {}) {
    options.park_id = '330339';
    options.resort_id = 'dlr';
    options.name = 'Disneyland Resort - Magic Kingdom';
    options.timezone = 'America/Los_Angeles';

    super(options);
  }
}

/**
 * Disneyland Resort - California Adventure
 */
export class DisneylandResortCaliforniaAdventure extends DisneyPark {
  /**
   * @inheritdoc
   */
  constructor(options = {}) {
    options.park_id = '336894';
    options.resort_id = 'dlr';
    options.name = 'Disneyland Resort - California Adventure';
    options.timezone = 'America/Los_Angeles';

    super(options);
  }
}

/**
 * Hong Kong Disneyland
 */
export class HongKongDisneylandPark extends DisneyPark {
  /**
   * @inheritdoc
   */
  constructor(options = {}) {
    options.park_id = 'desHongKongDisneyland';
    options.resort_id = 'hkdl';
    options.name = 'Hong Kong Disneyland - Hong Kong Disneyland Park';
    options.timezone = 'Asia/Hong_Kong';

    super(options);
  }
}

import {IndexedWDWDB, getEntityID} from './wdwdb.js';
import {Park} from '../park.js';
import {attractionType, statusType, queueType, tagType, scheduleType, entityType} from '../parkTypes.js';
import moment from 'moment-timezone';
import Resort from '../resort.js';

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
    for (let i=0; i<refurbData.length; i++) {
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
    for (let i=0; i<oldRefurbs.length; i++) {
      if (this.refurbs.findIndex((x) => x.entityID === oldRefurbs[i].entityID) < 0) {
        await this.updateAttractionState(oldRefurbs[i].entityID, statusType.closed);
      }
    }

    // mark any entities in refurb list as down for refurbishment
    for (let i=0; i<this.refurbs.length; i++) {
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
    this.destinationDocumentIDRegex = new RegExp(`^${this.resortId};entityType=destination`);
    this.parkIds = options.parkIds || [];

    this.db = getDatabase();
  }

  /**
   * Given a basic document build a generic entity doc.
   * This should include all fields that are in any entity type.
   * @param {object} doc
   * @return {object}
   */
  buildBaseEntityObject(doc) {
    // TODO - add location information
    let location = undefined;
    if (doc.longitude && doc.latitude) {
      location = {
        longitude: Number(doc.longitude),
        latitude: Number(doc.latitude),
        // TODO - return entrance/exit/shop/etc. interesting points
        //  that aren't neccessarily the "main location"
        pointsOfInterest: [],
      };
    }

    const entity = {
      _id: doc.id,
      _docId: doc._id,
      name: doc.name,
      // TODO - how to build good URL slugs?
      slug: doc.name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase(),
      location,
    };

    if (doc.relatedLocations && doc.relatedLocations.length > 0 && doc.relatedLocations[0].ancestors) {
      // try to find parkId (if it exists)
      const park = doc.relatedLocations[0].ancestors.find((x) => {
        return x.type === 'theme-park';
      });
      if (park) {
        entity._parkId = park.id;
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
        entityType: 'theme-park',
      });

      if (parkDocIndex.length === 0) return undefined;

      return this.db.get(parkDocIndex[0]._id);
    }))).filter((x) => !!x);

    return parkData.map((park) => {
      return {
        ...this.buildBaseEntityObject(park),
        entityType: entityType.park,
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

    options.parkIds = options.parkIds || [
      80007944,
      80007838,
      80007998,
      80007823,
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

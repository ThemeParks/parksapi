import {IndexedWDWDB, getEntityID} from './wdwdb.js';
import {Park} from '../park.js';
import {attractionType, statusType, queueType, tagType, scheduleType, entityType} from '../parkTypes.js';
import moment from 'moment-timezone';

let wdwDB = null;

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
    const oldRefurbs = this.refurbs;

    this.refurbs = refurbData.map((x) => {
      if (x.scheduleType !== 'Refurbishment') return undefined;
      return {
        entityID: getEntityID(x.facilityId),
      };
    }).filter((x) => x !== undefined);

    // mark attractions that were previously refurbed, but now aren't, as closed instead
    for (let i=0; i<oldRefurbs.length; i++) {
      if (this.refurbs.find((x) => x.entityID === oldRefurbs[i].entityID) !== undefined) {
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

    // figure out general ride status
    let status = statusType.operating;

    // if our status document contains singleRider, then tag it
    //  this is only available in live data, so we have to do it in our update
    await this.toggleAttractionTag(entityID, tagType.singleRider, !!doc.singleRider);

    // TODO - if name contains "Temporarily Unavailable", mark as closed?

    if (doc.status === 'Down') {
      status = statusType.down;
    } else if (doc.status === 'Closed') {
      status = statusType.closed;
    } else if (doc.status === 'Refurbishment') {
      status = statusType.refurbishment;
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
      const parkHours = calendar.parkHours.find((h) => {
        return getEntityID(h.facilityId) === this.config.park_id &&
          h.scheduleType !== 'Closed' &&
          h.scheduleType.indexOf('blockout') < 0; // ignore annual pass blockouts;
      });

      if (parkHours) {
        // TODO - build up our opening hours data for this park
        //  include magic hours etc.?
        return [
          {
            openingTime: moment(parkHours.startTime).tz(this.config.timezone).format(),
            closingTime: moment(parkHours.endTime).tz(this.config.timezone).format(),
            type: scheduleType.operating,
          },
        ];
      }
    }

    return undefined;
  }
}

export default DisneyPark;

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

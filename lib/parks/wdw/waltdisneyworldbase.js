import {DisneyDB, getEntityID} from './wdwdb.js';
import {Park, ParkConstants} from '../park.js';

let wdwDB = null;
/**
 * Get the live WDW database object
 * @return {object} wdwdb live database instance
 */
export function getDatabase() {
  if (!wdwDB) {
    wdwDB = new DisneyDB();
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
  constructor(options) {
    options.resort_id = options.resort_id || '';
    options.park_id = options.park_id || '';

    super(options);

    if (this.config.park_id === '') {
      throw new Error(`Missing park_id for class ${this.constructor.name}`);
    }
    if (this.config.resort_id === '') {
      throw new Error(`Missing resort_id for class ${this.constructor.name}`);
    }

    // get a reference to our shared live database
    this.db = getDatabase();
  }

  /**
   * Get a unique ID for this park
   * @return {string}
   */
  getParkUniqueID() {
    return `${this.config.resort_id}_${this.config.park_id}`;
  }

  /**
   * Get the channel ID for the facility status live update documents
   * @return {string}
   */
  getFacilityStatusChannelID() {
    return `${this.config.resort_id}.facilitystatus.1_0`;
  }

  /**
   *
   */
  async _init() {
    console.log('Initialising...');

    // make sure the shared database is initialised
    await this.db.init();

    // subscribe to any live facility status updates
    this.db.subscribeToChannel(this.getFacilityStatusChannelID(), async (doc) => {
      this._processAttractionStatusUpdate(doc);
    });

    // fetch the current attraction times
    await Promise.all((
      // get all attractions with facility statuses
      await this.db.findByChannel(this.getFacilityStatusChannelID())
    ).map(this._processAttractionStatusUpdate.bind(this)));
  }

  /**
   * Process a document update from a facilitystatus channel
   * @param {object} doc The updated document
   */
  async _processAttractionStatusUpdate(doc) {
    // get our clean attraction ID
    const entityID = getEntityID(doc.id);

    // check attraction is within our park
    const updateIndexEntry = await this.db.findIndexEntity(entityID, {
      park_id: this.config.park_id,
    });
    // if we have no entries, then attraction is not in our park
    if (updateIndexEntry.length === 0) {
      return;
    }

    // figure out general ride status
    let status = ParkConstants.STATUS_OPERATING;
    if (doc.status === 'Down') {
      status = ParkConstants.STATUS_DOWN;
    } else if (doc.status === 'Closed') {
      status = ParkConstants.STATUS_CLOSED;
    } else if (doc.status === 'Refurbishment') {
      status = ParkConstants.STATUS_REFURBISHMENT;
    }

    // build our status object
    const state = {
      status,
      // all our queue types
      // TODO - how to detect virtual queue and FastPass availability?
      queues: [
        {
          type: ParkConstants.QUEUE_STANDBY,
          waitTime: doc.waitMinutes,
        },
      ],
    };

    // console.log(entityID, state);

    // update attraction status in base class
    await this._updateAttractionState(entityID, state);
  }

  /**
   * Build an attraction object from an ID
   * @param {string} attractionID Unique Attraction ID
   */
  async _buildAttractionObject(attractionID) {
    await this.db.init();

    // find a document for our attraction ID
    const attr = await this.db.findOne(attractionID);
    if (attr) {
      // TODO - build a full document about this attraction
      return {
        id: attractionID,
        name: attr.name,
      };
    }

    return undefined;
  }

  /**
   *
   */
  async _update() {
    // TODO - parks that don't use the live database need to implement this function
  }
}

export default DisneyPark;

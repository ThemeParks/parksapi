import PouchDB from 'pouchdb';
import ReplicationStream from 'pouchdb-replication-stream';
import sift from 'sift';

import {promises as fs, constants as fsConstants, createReadStream, createWriteStream} from 'fs';
import path from 'path';

import ConfigBase from '../../configBase.js';

import expressPouchDB from 'express-pouchdb';

// pouchdb-replication-stream allows us to "seed" the database with an initial database dump
//  incredibly useful for the wdw db, which is pretty huge
PouchDB.plugin(ReplicationStream.plugin);
PouchDB.adapter('writableStream', ReplicationStream.adapters.writableStream);

/**
 * Return the entity ID of an object
 * @param {object} doc Entity Document
 * @return {string} Entity ID, or undefined if unavailable
 */
export function getEntityID(doc) {
  const docId = doc?.id || doc;

  const stack = docId.split(':');
  const lowestLevelEntity = stack[stack.length - 1];

  const parts = lowestLevelEntity.split(';');
  if (parts <= 1) return undefined;

  return parts.find((p) => {
    // edge-case for some documents with no attraction attached (guessing test documents)
    if (p === 'Unassigned') return false;

    const keyval = p.split('=');
    return (keyval.length === 1);
  });
}

/**
 * Custom implementation of PouchDB for our WDW database sync
 */
class WDWPouchDB extends PouchDB {
  /**
   * Build our WDWPouchDB object (passes straight through to PouchDB())
   * @param  {...any} args
   */
  constructor(...args) {
    super(...args);

    // create our WDW indexes
    this._wdwIndex = {}; // general entityID -> docs index
    this._wdwFacilityStatusIndex = []; // facility status docs (ride times etc.)
    this._wdwChannelIndex = {}; // documents grouped by channel
  }
}

const delay = (time) => {
  return new Promise((resolve) => {
    setTimeout(resolve, time);
  });
};

const ancestorIndexes = [
  {
    key: 'ancestorLandId',
    index: 'land_id',
  },
  {
    key: 'ancestorResortId',
    index: 'resort_id',
  },
  {
    key: 'ancestorResortAreaId',
    index: 'resort_area_id',
  },
  {
    key: 'ancestorThemeParkId',
    index: 'park_id',
  },
];

// helper function that extracts the entity ID, type, and any other meta-data from a document using it's .id
const extractEntityKeys = (doc) => {
  if (!doc || !doc.id) return undefined;

  // some IDs are stacked using :
  const stack = doc.id.split(':');
  const lowestLevelEntity = stack[stack.length - 1];

  const parts = lowestLevelEntity.split(';');
  if (parts <= 1) return undefined;

  // some documents can have different parents, they're the same, but different path to get there
  const parentStackEl = stack.length > 1 ? stack[stack.length - 2] : undefined;
  const parent = parentStackEl ? extractEntityKeys({id: parentStackEl}).id : undefined;

  const ret = {
    parent,
  };

  parts.forEach((p) => {
    const keyval = p.split('=');
    if (keyval.length === 1) {
      ret.id = keyval[0];
    } else {
      ret[keyval[0]] = keyval[1];
    }
  });

  // if this document is in a "facilitystatus" channel, add an extra tag
  //  this is so we don't collide with the actaul document for this attraction
  //  but also so we can filter it easier later
  const channel = doc.channels?.length ? doc.channels[0] : undefined;
  if (channel && channel.indexOf('facilitystatus') >= 0) {
    ret.facilityStatus = true;
  }

  // include channel in our index
  ret.channel = channel;

  // add any ancestor data to our index (that we a) care about and b) can find) - see ancestorIndexes
  ancestorIndexes.forEach((ancestorIndex) => {
    if (doc[ancestorIndex.key]) {
      const ancestorID = getEntityID(doc[ancestorIndex.key]);
      if (ancestorID) {
        ret[ancestorIndex.index] = ancestorID;
      }
    }
  });

  return ret;
};

// figure out a document's intended language
const extractChannelLanguage = (doc) => {
  // pull channel from doc
  const channel = doc.channels?.length ? doc.channels[0] : undefined;
  if (!channel) return undefined;

  // extract language from the end of the channel name
  let lang = channel.slice(channel.lastIndexOf('.') + 1);

  // channels missing any locale are assumed English International (they are using "1_0" or similar)
  if (lang.indexOf('1') === 0) {
    lang = 'en_intl';
  }

  return lang;
};

/**
 * @private
 * @param {*} doc
 */
function IndexDocument(doc) {
  const entity = extractEntityKeys(doc);
  if (entity && entity.id && entity.entityType) {
    const id = entity.id;
    if (!this._wdwIndex[id]) {
      this._wdwIndex[id] = [];
    }

    const newIndexEntry = {
      ...entity,
      language: extractChannelLanguage(doc),
      _id: doc._id,
    };

    // special-case, index all facility status documents in another index
    if (newIndexEntry.facilityStatus) {
      const docExists = this._wdwFacilityStatusIndex.findIndex((x) => {
        return x.id === newIndexEntry.id;
      });
      if (docExists >= 0) {
        this._wdwFacilityStatusIndex[docExists] = newIndexEntry;
      } else {
        this._wdwFacilityStatusIndex.push(newIndexEntry);
      }
    }

    // index all documnets based on channel
    const channel = doc.channels?.length ? doc.channels[0] : undefined;
    if (channel) {
      if (!this._wdwChannelIndex[channel]) {
        this._wdwChannelIndex[channel] = [];
      }

      this._wdwChannelIndex[channel].push(newIndexEntry);
    }

    const newIndexKeys = Object.keys(newIndexEntry);

    const findExisting = this._wdwIndex[id].findIndex((x) => {
      // if # keys are different, not a match
      if (Object.keys(x).length !== newIndexKeys.length) return false;

      // look for any mismatches between the keys
      const findMismatch = newIndexKeys.find((key) => {
        // _id is supposed to be different, so ignore it regardless of if it matches or not
        if (key === '_id') return false;
        return (newIndexEntry[key] !== x[key]);
      });
      return !findMismatch;
    });

    if (findExisting < 0) {
      // entry doesn't exist, add to our list
      this._wdwIndex[id].push(newIndexEntry);
    } else {
      // replace existing entry that matches all the same properties
      this._wdwIndex[id][findExisting] = newIndexEntry;
    }
  }
};

const pouchBulkDocs = PouchDB.prototype.bulkDocs;

/**
 * @private
 * @param  {...any} args
 * @return {*}
 */
function WDWIndexPluginBulkDocs(...args) {
  const body = args[0];
  const docs = Array.isArray(body) ? body : body.docs;

  docs.forEach((doc) => {
    if (!doc._deleted) {
      // doc not deleted, index it!
      IndexDocument.call(this, doc);
    } else {
      // remove from any existing index we have for this document
      Object.keys(this._wdwIndex).forEach((id) => {
        const entry = this._wdwIndex[id];
        const containsID = entry.findIndex((x) => x._id === doc._id);
        if (containsID >= 0) {
          entry.splice(containsID, 1);
        }
      });

      // clear out the channel index on document deletion
      const channel = doc.channels?.length ? doc.channels[0] : undefined;
      if (channel) {
        const channelIndex = this._wdwChannelIndex;
        if (channelIndex) {
          const docIndex = channelIndex.findIndex((x) => x._id === doc._id);
          if (docIndex >= 0) {
            channelIndex.splice(docIndex, 1);
          }
        }
      }
    }
  });

  // All documents check out. Pass them to PouchDB.
  return pouchBulkDocs.call(this, ...args);
}

const WDWIndexPlugin = {
  bulkDocs: WDWIndexPluginBulkDocs,
};

// plugin to our localdb so we can index entity IDs to the correct document
WDWPouchDB.plugin(WDWIndexPlugin);

/**
 * Live Database object for Disney parks using couchbase databases
 * Will syncronise databae locally before accessing, allowing fast queries
 * @class
 */
export default class DisneyLiveDB extends ConfigBase {
  /**
     * Create a new DisneyLiveDB object
     * @param {*} options
     */
  constructor(options = {}) {
    if (!options.dbName) {
      options.dbName = 'wdw';
    }

    // env variables can override with
    //  env.WDWDB_HOST, env.WDWDB_USERNAME, env.WDWDB_PASSWORD etc.
    if (!options.configPrefixes) {
      options.configPrefixes = ['wdwdb'];
    }

    options.host = options.host || '';
    options.username = options.username || '';
    options.password = options.password || '';
    // TODO - get latest useragent for app
    options.useragent = options.useragent || 'CouchbaseLite/1.3 (1.4.1/8a21c5927a273a038fb3b66ec29c86425e871b11)';

    // how often to take database checkpoints (default 15 minutes)
    options.checkpointTime = options.checkpointTime || 1000 * 60 * 15;

    super(options);

    // create our database objects
    this.localDB = new WDWPouchDB(`localdb/${this.config.dbName}`, {
      auto_compaction: true,
    });
    this.remoteDB = new PouchDB(this.config.host, {
      auth: {
        username: this.config.username,
        password: this.config.password,
      },
      skip_setup: true,
      // override user-agent header when syncing remote database
      fetch: (url, opts) => {
        opts.headers.set('User-Agent', this.config.useragent);
        return PouchDB.fetch(url, opts);
      },
    });

    this.synced = false;

    this.initPromiseSync = null;

    // start the database disk scheduler
    this._scheduleDBDump();

    // optionally hook into an Express server for a GUI
    if (this.config.http) {
      this.config.http.use('/db', expressPouchDB(PouchDB));
    }
  }

  /**
   * Initialise the live database, returns once finished an initial sync
   */
  async init() {
    if (this.synced) {
      return;
    }

    if (this.initPromiseSync) return this.initPromiseSync;

    // first, syncronise our database before we start rolling updates
    this.initPromiseSync = this._loadAndInit();
    // keep the Promise as a variable so we can keep returning it for any additional init() calls
    await this.initPromiseSync;
    this.initPromiseSync = null;

    console.log(`Database ${this.config.dbName} finished setup!`);

    this.synced = true;

    if (!this.config.skipSync) {
      // start rolling replicate to keep our local database in-sync
      PouchDB.replicate(this.remoteDB, this.localDB, {
        live: true,
        retry: true,
      });
    }
  }

  /**
   * Internal function
   * Loads and performs an initial sync on the database
   * @private
   */
  async _loadAndInit() {
    // first, try and restore from disk
    await this.load();

    // optionally skip replicating with remote (for local fast testing)
    if (this.config.skipSync) {
      return;
    }

    // then perform an initial replication from remote to local
    console.log('Performing initial replication...');
    return await PouchDB.replicate(this.remoteDB, this.localDB, {
      batch_size: 500,
    });
  }

  /**
   * Get the filename we use for saving backups of the database to disk
   * Used for creating simple "snapshots" to reduce initial sync times
   * @param {string} [postfix] Optional postfix for the filename
   * @return{string}
   */
  getDumpFilename(postfix = '') {
    return path.join('localdb', `${this.config.dbName}${postfix}.db`);
  }

  /**
   * Restore a database backup from disk
   * Perform this after running "dump()" on a previous synced database
   * This will help to reduce the initial sync time for large databases
   */
  async load() {
    const dumpPath = this.getDumpFilename();

    // if our database dump doesn't exist, then early out and we'll do a normal sync
    try {
      await fs.access(dumpPath, fsConstants.F_OK);
    } catch (error) {
      return;
    }

    console.log('Restoring database from disk...');

    // otherwise, load up our database from disk
    const ws = createReadStream(dumpPath);
    return this.localDB.load(ws, {
      batch_size: 500,
    });
  }

  /**
   * Dump this live database to disk
   * This will be used to "seed" the database to speed up syncs for future runs
   */
  async dump() {
    if (this.databaseDumpPendingPromise) {
      return this.databaseDumpPendingPromise;
    }

    console.log('Dumping database to disk...');

    const dumpPath = this.getDumpFilename();
    const dumpPathNew = this.getDumpFilename('_new');

    // dump database to our new location
    const ws = createWriteStream(dumpPathNew);
    this.databaseDumpPendingPromise = this.localDB.dump(ws, {
      batch_size: 500,
    });
    // save Promise so multiple "dump()" calls can stack cleanly
    await this.databaseDumpPendingPromise;
    this.databaseDumpPendingPromise = null;

    // rename new database dump to our final intended location
    return fs.rename(dumpPathNew, dumpPath);
  }

  /**
   * Begin a database dump loop
   * This will dump the database to disk every 15 minutes (override with options.checkpointTime)
   *  to speed up initial syncs
   * @private
   */
  async _scheduleDBDump() {
    // make sure database is initialised before writing anything to disk
    await this.init();
    await this.dump();

    // schedule another database disk write
    await delay(this.config.checkpointTime);
    process.nextTick(this._scheduleDBDump.bind(this));
  }

  /**
   * Get a document from this live database
   * Will wait until database is syncronised before returning
   * See PouchDB.get(...) for options
   */
  async get(...args) {
    await this.init();
    return await this.localDB.get.apply(this, args);
  }

  /**
   * Get an array of documents from an array of _id
   * @param {array<string>} ids
   */
  async getDocsById(ids) {
    await this.init();

    return (await Promise.all(ids.map((id) => {
      // fetch each document using our local DB
      return this.localDB.get(id);
    }))).filter((doc) => {
      // filter our any docs that failed to be fetched (they have been deleted etc.)
      return doc !== undefined;
    });
  }

  /**
   * Find search index entries by ID
   * @param {string} id
   * @param {object} [filter]
   */
  async findIndexEntity(id, filter = {}) {
    await this.init();

    const indexEntry = this.localDB._wdwIndex[id];
    if (!indexEntry) return undefined;

    // filter entries by supplied filter options before resolving
    return indexEntry.filter(sift(filter));
  }

  /**
   * Search for an entity in the WDW database
   * @param {string} id Entity ID
   * @param {object} [filter] Filter index by field
   */
  async findEntity(id, filter = {}) {
    const entities = await this.findIndexEntity(id, filter);

    // resolve each index entry to our full documents
    return this.getDocsById(entities.map((entry) => {
      return entry._id;
    }));
  }

  /**
   * Search for an entity in the WDW database
   * Attempts to return the "best candidate" single document that matches the incoming ID
   * @param {string} id Entity ID
   * @param {object} [filter] Optional index filter
   */
  async findOne(id, filter = {}) {
    const entities = await this.findIndexEntity(id, filter);
    if (entities.length === 0) return undefined;

    // filter to find the best document of the ones available
    //  prioritise language en_intl
    const enIntl = entities.find((doc) => {
      return doc.language === 'en_intl' && !doc.facilityStatus; // don't include facilityStatus docs by-default
    });
    if (enIntl) {
      return await this.get(enIntl._id);
    }

    //  2nd priority: en_US
    const enUS = entities.find((doc) => {
      return doc.language === 'en_us' && !doc.facilityStatus; // don't include facilityStatus docs by-default
    });
    if (enUS) {
      return await this.get(enUS._id);
    }

    // otherwise just return the first entry in out list
    return await this.get(entities[0]._id);
  }

  /**
   * Get the live facility status for a given entity ID
   * @param {string} id Entity ID
   */
  async findFacilityStatus(id) {
    await this.init();

    // look up entity ID in our facility status index
    const indexEntity = this.localDB._wdwFacilityStatusIndex.find((x) => {
      return x.id === id;
    });
    if (!indexEntity) return undefined;

    return await this.get(indexEntity._id);
  }

  /**
   * Find all documents by channel
   * eg. 'wdw.facilitystatus.1_0' to get all WDW facility status documents
   * @param {string} channel Channel ID
   * @param {object} [filter] Optional document index filter
   */
  async findByChannel(channel, filter = {}) {
    await this.init();

    const channelIndex = this.localDB._wdwChannelIndex[channel];
    if (!channelIndex) {
      return [];
    }

    // return resolved documents for the channel
    return this.getDocsById(channelIndex.filter(sift(filter)).map((entry) => {
      return entry._id;
    }));
  }

  /**
   * Return all documents in the database that match the given filter
   * @param {object} [filter]
   */
  async find(filter = {}) {
    await this.init();

    const docs = await this.localDB.allDocs({
      include_docs: true,
    });

    return docs.rows.map((row) => row.doc).filter(sift(filter));
  }
}

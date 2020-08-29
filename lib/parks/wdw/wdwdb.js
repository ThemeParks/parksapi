import PouchDB from 'pouchdb';
import ReplicationStream from 'pouchdb-replication-stream';
import sift from 'sift';
import {promises as fs, constants as fsConstants, createReadStream, createWriteStream} from 'fs';
import path from 'path';
import nodefetch from 'node-fetch';
import toughcookie from 'tough-cookie';
import fetchcookie from 'fetch-cookie';

import {parseConfig} from '../../configBase.js';

const fetch = fetchcookie(nodefetch, new toughcookie.CookieJar());

/**
 * Given a document, return it's entity ID for the WDW database
 * @param {object|string} doc CouchDB document or a document ID
 * @return {string}
 */
export function getEntityID(doc) {
  const docId = doc?.id || doc;

  if (!docId) {
    console.trace('Unable to find ID from', JSON.stringify(doc));
    return undefined;
  }

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

// internal key names for our indexes. Stored as constants to save typing these over and over
const constants = {
  INDEX_FACILITYSTATUS: 'facilityStatus',
  INDEX_CHANNELS: 'channels',
  INDEX_ENTITIES: 'entities',
};

// ancestors to include in our index
//  we add these into our index objects to identify unique documents to index
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

// Super() function to call when we setup this class as a plugin
const pouchBulkDocs = PouchDB.prototype.bulkDocs;

/**
 * An indexed live WDW database
 * Replicated WDW database to local disk for fast access
 * While replicating, will build an in-memory index of entities for fast lookup
 * Options to dump database to a single file or load a snapshot for quicker database boot ups
 */
export class IndexedWDWDB extends PouchDB {
  /**
   * Construct a new IndexedWDWDB object
   * @param {object} opts PouchDB options object
   * @param {string} [opts.remoteHost] Remote database to replicate
   * @param {string} [opts.remoteUsername] Remote database username to authenticate
   * @param {string} [opts.remotePassword] Remote database password to authenticate
   * @param {string} [opts.dbName='wdw'] Local database name
   * @param {string} [opts.snapshot] File location of a snapshot to 'seed' the database during startup
   * @param {string} [opts.skipSync] Skip network replication, only use data already on disk
   * @extends PouchDB
   */
  constructor(opts = {}) {
    // default to enable auto_compaction
    opts.auto_compaction = opts.auto_compaction || true;

    opts.remoteHost = '';
    opts.remoteUsername = '';
    opts.remotePassword = '';
    opts.dbName = opts.dbName || 'wdw';
    opts.snapshot = ''; // optional snapshot to use when starting database
    // 'name' is the config option pouchdb uses for the storage path
    opts.name = opts.name || IndexedWDWDB.getDatabaseFilePath(opts.dbName);

    opts.skipSync = opts.skipSync === undefined ? false : opts.skipSync;

    opts.restartTimeout = opts.restartTimeout || 5;

    opts.configPrefixes = ['WDWDB'].concat(opts.configPrefixes || []);
    const config = parseConfig(opts);

    super(config);
    this.config = config;

    // setup our remote host to replicate locally
    if (this.config.remoteHost) {
      const remoteHostOptions = {
        skip_setup: true,
      };
      if (this.config.remoteUsername && this.config.remotePassword) {
        remoteHostOptions.auth = {
          username: this.config.remoteUsername,
          password: this.config.remotePassword,
        };

        let fetchCookie = null;

        remoteHostOptions.fetch = (url, args) => {
          args.headers.set('user-agent', 'CouchbaseLite/2.7.1-6 (Java; Android 9; ONEPLUS A5000) CE/release, Commit/2fb25069+ Core/2.7.1 (6)');

          args.compress = true;

          if (fetchCookie !== null) {
            args.headers.set('cookie', fetchCookie);
          }

          // console.log(url);

          return fetch(url, args).then(async (resp) => {
            // intercept and remember cookie
            const cookie = resp.headers.get('set-cookie');
            if (cookie) {
              fetchCookie = cookie.split(';')[0];
            }
            return resp;
          });
        };
      }

      this.remoteDB = new PouchDB(this.config.remoteHost, remoteHostOptions);
    }

    this.synced = false;
    this.replicating = false;

    this._index = {};
    this._setupPromise = null;
    this._indexSetup = false;
  }

  /**
 * Get the LevelDOWN database location to use
 * @param {string} name Database name
 * @return {string}
 */
  static getDatabaseFilePath(name) {
    return path.join(process.cwd(), `db.${name}`);
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

    console.log(`Database finished setup!`);

    this.synced = true;

    if (!this.config.skipSync && this.remoteDB) {
      this._replicate();
    }
  }

  /**
   * Start database replication
   * @private
   */
  _replicate() {
    if (this.replicating) return;
    this.replicating = true;

    let noChangeTimeout = null;
    let replicationHandle = null;

    const noChangeTimer = Number(this.config.restartTimeout) || 5; // how many minutes before killing and restarting replication

    // function to reboot the replicate based on various possible failure states
    const rebootReplicator = (err) => {
      if (noChangeTimeout) {
        clearTimeout(noChangeTimeout);
      }
      if (replicationHandle) {
        replicationHandle.cancel();
        replicationHandle = null;
      }

      if (err) {
        console.error('Replication Error!', new Date(), err);
      }

      console.log('Restarting replicator...');
      this.replicating = false;
      setTimeout(this._replicate.bind(this), 1000);
    };

    const resetTimeoutTimer = () => {
      if (noChangeTimeout) {
        clearTimeout(noChangeTimeout);
      }
      noChangeTimeout = setTimeout(() => {
        console.log('Replicator timed out...');
        rebootReplicator();
      }, 1000 * 60 * noChangeTimer);
    };

    try {
      replicationHandle = PouchDB.replicate(this.remoteDB, this, {
        live: true,
        retry: true,
      }).on('change', () => {
        // reset a timer whenever we get a change
        //  if the timer is ever fired, we will restart the replicator
        resetTimeoutTimer();
      }).on('error', (e) => {
        rebootReplicator(e);
      });

      // always start the change timer immediately
      //  otherwise if we start repliating in the middle of the night (when no changes are happening)
      //  on('change') never fires, so we can lose connection and never fire the timeout
      resetTimeoutTimer();
    } catch (e) {
      rebootReplicator(e);
    }
  }

  /**
   * Internal function
   * Loads and performs an initial sync on the database
   * @private
   */
  async _loadAndInit() {
    // first, try and restore from disk (will check if an existing snapshot exists)
    await this.loadSnapshot();

    // load up our indexes
    await this._initIndexes();

    // reindex every document once we've initialised from disk
    //  do this before replication, since all new docs will be auto-indexed
    const docs = await this.allDocs({
      include_docs: true,
    });
    console.log('Building index...');
    await Promise.allSettled(docs.rows.map((doc) => {
      return this._indexWDWDocument(doc.doc);
    }));

    // optionally skip replicating with remote (for local fast testing)
    if (this.config.skipSync || !this.remoteDB) {
      return;
    }

    // then perform an initial replication from remote to local
    console.log('Performing initial replication...');
    return await PouchDB.replicate(this.remoteDB, this, {
      batch_size: 500,
    }).catch((e) => {
      console.error(`Replication error: ${e}`);
    });
  }

  /**
   * Get the filename we use for saving backups of the database to disk
   * Used for creating simple "snapshots" to reduce initial sync times
   * @param {string} [postfix] Optional postfix for the filename
   * eg. Use postfix to generate a temporary version of a file to write to before replacing the "real" database
   * @return {string}
   */
  getDumpFilename(postfix = '') {
    return path.join('localdb', `${this.config.dbName}${postfix}.db`);
  }

  /**
   * Restore a database backup from disk
   * Perform this after running "dump()" on a previous synced database
   * This will help to reduce the initial sync time for large databases
   * @param {string} [snapshotFile] File path of the snapshot to restore into the database
   * snapshotFile will use default saveSnapshot result location if not supplied
   */
  async loadSnapshot(snapshotFile = '') {
    if (this.synced || this.replicating) {
      console.warn('Trying to load database snapshot when replication has already started');
      return;
    }

    const useCustomSnapshot = !!snapshotFile;
    const dumpPath = useCustomSnapshot ? snapshotFile : this.getDumpFilename();

    // if our database dump doesn't exist, then early out and we'll do a normal sync
    try {
      await fs.access(dumpPath, fsConstants.F_OK);
    } catch (error) {
      return;
    }

    console.log('Restoring database from disk...');

    // otherwise, load up our database from disk
    const ws = createReadStream(dumpPath);
    return this.load(ws, {
      batch_size: 500,
    });
  }

  /**
   * Save a snapshot of this live database to disk
   * This will be used to "seed" the database to speed up syncs for future runs
   * @return {string} Path to resulting database snapshot
   */
  async saveSnapshot() {
    if (this.databaseDumpPendingPromise) {
      return this.databaseDumpPendingPromise;
    }

    console.log('Dumping database to disk...');

    const dumpPath = this.getDumpFilename();
    const dumpPathNew = this.getDumpFilename('_new');

    // dump database to our new location
    const ws = createWriteStream(dumpPathNew);
    this.databaseDumpPendingPromise = this.dump(ws, {
      batch_size: 500,
    });
    // save Promise so multiple "dump()" calls can stack cleanly
    await this.databaseDumpPendingPromise;
    this.databaseDumpPendingPromise = null;

    // rename new database dump to our final intended location
    return fs.rename(dumpPathNew, dumpPath).then(() => {
      // finally, return the actual path of the snapshot
      return dumpPath;
    });
  }

  /**
   * Index initialisation
   * This function wraps taking care of creating our indexes once only
   * @private
   */
  async _initIndexes() {
    if (this._indexSetup) {
      return;
    }

    if (this._setupPromise) {
      return this._setupPromise;
    }

    this._setupPromise = this._createIndexes();
    await this._setupPromise;
    this._indexSetup = true;
    return;
  }

  /**
   * Setup our WDW indexes
   * @private
   */
  async _createIndexes() {
    await this._createIndex(constants.INDEX_ENTITIES);
    await this._createIndex(constants.INDEX_CHANNELS);
    await this._createIndex(constants.INDEX_FACILITYSTATUS, []);
  }

  /**
   * Get the internal index object for the given index type
   * @param {object} name Index name (see constants.INDEX_*)
   * @return {*}
   * @private
   */
  getIndex(name) {
    return this._index[name].index;
  }

  /**
   * Create an index object to be used by this database
   * @param {string} name Index name
   * @param {*} defaultIndex Index initial object state
   * @private
   */
  async _createIndex(name, defaultIndex = {}) {
    this._index[name] = {
      index: defaultIndex,
    };
  }

  /**
   * Given a WDW document, extract key identifiable data
   * This is used to build a look-up index of unique document types
   * See ancestorIndexes for some of the keys we use
   * This is important so we can tell the difference between entities with the same ID, but different purposes
   * eg. an entity ID can have multiple documents, one for the attraction itself, one for it's wait times, etc.
   * These need to both be in the index under the same entity ID, but with different properties to make them distinct
   * @param {object} doc WDW Database Document
   * @return {object} Index object containing important identifying data
   * @private
   */
  _extractEntityKeys(doc) {
    if (!doc || !doc.id) return undefined;

    // some IDs are stacked using :
    const stack = doc.id.split(':');
    const lowestLevelEntity = stack[stack.length - 1];

    const parts = lowestLevelEntity.split(';');
    if (parts <= 1) return undefined;

    // some documents can have different parents, they're the same, but different path to get there
    const parentStackEl = stack.length > 1 ? stack[stack.length - 2] : undefined;
    const parent = parentStackEl ? this._extractEntityKeys({id: parentStackEl}).id : undefined;

    const ret = {
      parent,
    };

    // special case for calendars
    if (doc.channels.find((x) => x.indexOf('.calendar.') >= 0) !== undefined) {
      ret.entityType = 'calendar';
    }

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
    const facilityStatus = doc.channels && (doc.channels.find((x) => x.indexOf('facilitystatus') >= 0) !== undefined);
    if (facilityStatus) {
      ret.facilityStatus = true;
    }

    // include channels in our index
    if (doc.channels) {
      const channels = JSON.parse(JSON.stringify(doc.channels));
      channels.sort();
      ret.channel = channels.join(',');
    }

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
  }

  /**
   * Given a WDW database document, try to return its language
   * @param {object} doc
   * @return {string} Language of this document. Eg. en_intl, en_us
   * @private
   */
  _extractChannelLanguage(doc) {
    // pull channel from doc
    if (!doc.channels) return undefined;

    const langs = doc.channels.map((x) => {
      // extract last \.* from the end of the channel name
      // language-specific channels end with "en_us" or something
      // channels without locale end with a version number eg. "1_0"
      return x.slice(x.lastIndexOf('.') + 1);
    }).filter((x) => {
      // check each one to see the language tag starts with a version number
      return isNaN(Number(x.slice(0, 1)));
    });

    // default to 'en_intl' if we cannot find a language in our channels
    return langs[0] || 'en_intl';
  }

  /**
   * Remove all indexes referencing docID from the given index
   * @param {object} index
   * @param {string} docID
   */
  _removeFromArrayIndex(index, docID) {
    Object.keys(index).forEach((key) => {
      const indexIDs = index[key].map(
          (x, idx) => {
            return x._id === docID ? idx : undefined;
          }).
          filter((x) => x !== undefined);

      indexIDs.forEach((idx) => {
        index[key].splice(idx, 1);
      });
    });
  }

  /**
   * Add a document to the database index
   * Used for fast lookups of entities etc. to the correct documents
   * @param {object} doc CouchDB document to index
   * @private
   */
  async _indexWDWDocument(doc) {
    if (doc._deleted) {
      // remove document from all indexes

      // facility status
      //  quick hack to turn the facility status index into the same type as the others so I can reuse my code
      const facilityIndexObject = {index: this.getIndex(constants.INDEX_FACILITYSTATUS)};
      this._removeFromArrayIndex(facilityIndexObject, doc._id);

      // channels
      this._removeFromArrayIndex(this.getIndex(constants.INDEX_CHANNELS), doc._id);

      // entity index
      this._removeFromArrayIndex(this.getIndex(constants.INDEX_ENTITIES), doc._id);

      return;
    }

    const entity = this._extractEntityKeys(doc);
    if (entity && entity.id && entity.entityType) {
      const id = entity.id;

      const newIndexEntry = {
        ...entity,
        language: this._extractChannelLanguage(doc),
        _id: doc._id,
      };

      // special-case, index all facility status documents in another index
      if (newIndexEntry.facilityStatus) {
        const facilityIndex = this.getIndex(constants.INDEX_FACILITYSTATUS);

        const docExists = facilityIndex.findIndex((x) => {
          return x.id === newIndexEntry.id;
        });
        if (docExists >= 0) {
          facilityIndex[docExists] = newIndexEntry;
        } else {
          facilityIndex.push(newIndexEntry);
        }
      }

      // index all documents based on channel
      if (doc.channels) {
        const channelIndex = this.getIndex(constants.INDEX_CHANNELS);
        doc.channels.forEach((channel) => {
          if (!channelIndex[channel]) {
            channelIndex[channel] = [];
          }
          channelIndex[channel].push(newIndexEntry);
        });
      }

      const newIndexKeys = Object.keys(newIndexEntry);

      const entityIndex = this.getIndex(constants.INDEX_ENTITIES);
      if (!entityIndex[id]) {
        entityIndex[id] = [];
      }
      const findExisting = entityIndex[id].findIndex((x) => {
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
        entityIndex[id].push(newIndexEntry);
      } else {
        // replace existing entry that matches all the same properties
        if (entityIndex[id][findExisting]._id !== newIndexEntry._id) {
          entityIndex[id][findExisting] = newIndexEntry;
        }
      }
    }
  }

  /**
   * Get an array of documents from an array of _id
   * @param {array<string>} ids
   */
  async getDocsById(ids) {
    await this.init();

    return (await Promise.all(ids.map((id) => {
      // fetch each document using our local DB
      return this.get(id);
    }))).filter((doc) => {
      // filter our any docs that failed to be fetched (they have been deleted etc.)
      return doc !== undefined;
    });
  }

  /**
   * Find search index entries by ID
   * If you want the actual document and not just the meta-index data, use getEntity() instead
   * @param {string} id
   * @param {object} [filter]
   * @return {array<object>} Returns the index data for this entity ID
   */
  async getEntityIndex(id, filter = {}) {
    await this.init();

    const entityIndex = this.getIndex(constants.INDEX_ENTITIES);
    const indexEntry = entityIndex[id];
    if (!indexEntry) return [];

    // filter entries by supplied filter options before resolving
    return indexEntry.filter(sift(filter));
  }

  /**
   * Search for an entity in the WDW database
   * @param {string} id Entity ID
   * @param {object} [filter] Filter index by field
   * @return {array<object>} Returns all documents for this entity ID
   */
  async getEntity(id, filter = {}) {
    const entities = await this.getEntityIndex(id, filter);

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
   * @return {object} Returns the best candidate single document, or undefined
   */
  async getEntityOne(id, filter = {}) {
    const entities = await this.getEntityIndex(id, filter);
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
   * @return {object} Facility status document, or undefined
   */
  async getFacilityStatus(id) {
    await this.init();

    const statusIndex = this.getIndex(constants.INDEX_FACILITYSTATUS);

    // look up entity ID in our facility status index
    const indexEntity = statusIndex.find((x) => {
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
   * @return {array<object>} All documents in this channel (or empty array)
   */
  async getByChannel(channel, filter = {}) {
    await this.init();

    const channelIndex = this.getIndex(constants.INDEX_CHANNELS);

    const channelData = channelIndex[channel];
    if (!channelData) {
      return [];
    }

    // return resolved documents for the channel
    return this.getDocsById(channelData.filter(sift(filter)).map((entry) => {
      return entry._id;
    }));
  }

  /**
   * Return all documents in the database that match the given filter
   * This is a slow operation! Use sparingly!
   * @param {object} [filter]
   * @return {array<object>}
   */
  async find(filter = {}) {
    await this.init();

    const docs = await this.allDocs({
      include_docs: true,
    });

    return docs.rows.map((row) => row.doc).filter(sift(filter));
  }

  /**
   * Subscribe to all database changes with an optional mongo-style filter
   * @param {object} [filter]
   * @param {function} callback
   */
  subscribeToChanges(filter, callback) {
    if (typeof filter === 'function') {
      // if no filter passed in, call ourselves with an empty set
      this.subscribeToChanges({}, callback);
    } else {
      // listen to changes from now onwards, passing in our filter function
      this.changes({
        since: 'now',
        live: true,
        include_docs: true,
        filter: sift(filter),
      }).on('change', (change) => {
        callback(change.doc);
      });
    }
  }

  /**
   * Subscribe to all changes to a channel
   * @param {string} channel
   * @param {function} callback
   */
  subscribeToChannel(channel, callback) {
    // only return documents that contain the supplied channel
    this.subscribeToChanges({
      channels: {
        $elemMatch: channel,
      },
    }, callback);
  }

  /**
   * Plugin function to intercept bulkDocs function
   * We index any WDW documents we find for easier lookup later
   * @param  {...any} args bulkDocs in
   * @private
   */
  static async _pluginBulkDocs(...args) {
    await this._initIndexes();

    const body = args[0];
    const docs = Array.isArray(body) ? body : body.docs;

    // index each document being added to the database
    await Promise.allSettled(docs.map((doc) => {
      return this._indexWDWDocument(doc);
    }));

    // All documents check out. Pass them to PouchDB.
    return pouchBulkDocs.call(this, ...args);
  }
}

// add our plugin function
IndexedWDWDB.plugin({
  bulkDocs: IndexedWDWDB._pluginBulkDocs,
});

// pouchdb-replication-stream allows us to "seed" the database with an initial database dump
//  incredibly useful for the wdw db, which is pretty huge
IndexedWDWDB.plugin(ReplicationStream.plugin);
PouchDB.adapter('writableStream', ReplicationStream.adapters.writableStream);

export default IndexedWDWDB;

/**
 * Cache provider
 */



// import CacheLevel from './cache/cacheLevel.js';
import CacheLmdb from './cache/cacheLmdb.js';

// our global cache instance
let CacheInstance = null;
// const cacheLevel = new CacheLevel();
const cacheLmdb = new CacheLmdb();

/**
 * Create a new Cache Instance.
 * This function should only be called once for the lifetime of the module.
 */
async function createCacheInstance() {
  // TODO - accept configured caches through environment variables (or other?)
  return cacheLmdb;
}

/**
  * Get the configured Cache implementation
  */
export async function getCache() {
  if (CacheInstance === null) {
    CacheInstance = await createCacheInstance();
  }

  return CacheInstance;
}

export default {
  getCache,
};

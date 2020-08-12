/**
 * Cache provider for this module.
 * Various cache types are available, we default to using "leveldown" via the Level library.
 */

import CacheLevel from './cache/cacheLevel.js';

// our global cache instance
let CacheInstance = null;

/**
 * Create a new Cache Instance.
 * This function should only be called once for the lifetime of the module.
 */
async function createCacheInstance() {
  // TODO - accept configured caches through environment variables (or other?)
  return new CacheLevel();
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

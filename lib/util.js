
/**
 * Get the cache name for a function & args set
 * @param {string} functionName 
 * @param {Array<*>} args 
 * @returns 
 */
export function getFunctionCacheKey(functionName, args) {
  let funcCacheName = `metacache_${functionName}`;
  if (args.length > 0) {
    funcCacheName = `metacache_${functionName}_${args.map((x) => JSON.stringify(x)).join(',')}`;
  }
  return funcCacheName;
}

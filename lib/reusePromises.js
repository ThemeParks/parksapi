/**
 * Module that wraps re-using the same Promise multiple times.
 * This allows a function to be called multiple times before returning, but only return once.
 * Useful for latent network requests,
 *  such as requesting a document from multiple sources, but only making one HTTP request.
 */

const activeFunctions = [];

/**
 * Find the active function with these arguments
 * @param {*} self
 * @param {function} fn
 * @param {string} argsSerialised
 * @return {number}
 * @private
 */
function findActiveFunctionIndex(self, fn, argsSerialised) {
  return activeFunctions.findIndex((x) => {
    return x.self === self && x.fn === fn && x.args === argsSerialised;
  });
}

/**
 * Reuse a function until it resolves
 * @param {*} self
 * @param {function} fn
 * @param  {...any} args Arguments to pass to the function
 * @return {Promise}
 */
export function reusePromise(self, fn, ...args) {
  return _reusePromise(false, self, fn, ...args);
}

/**
 * Reuse a function, returning it's result forever
 * @param {*} self
 * @param {function} fn
 * @param  {...any} args Arguments to pass to the function
 * @return {Promise}
 */
export function reusePromiseForever(self, fn, ...args) {
  return _reusePromise(true, self, fn, ...args);
}

/**
 * Internal call to run a Promise once time (and optionally keep result forever)
 * @param {boolean} useResultForever
 * @param {*} self
 * @param {function} fn
 * @param  {...any} args
 * @return {Promise}
 * @private
 */
function _reusePromise(useResultForever, self, fn, ...args) {
  // search for existing promise that hasn't resolved yet
  const argsSerialise = args ? JSON.stringify(args) : null;
  const existingFunctionIndex = findActiveFunctionIndex(self, fn, argsSerialise);
  const existingFunction = existingFunctionIndex >= 0 ? activeFunctions[existingFunctionIndex] : undefined;
  if (existingFunction) {
    if (existingFunction.resolved) {
      return existingFunction.value;
    }
    return existingFunction.promise;
  }

  const cleanupPendingFunction = () => {
    const pendingFunctionIDX = findActiveFunctionIndex(self, fn, argsSerialise);
    if (pendingFunctionIDX >= 0) {
      if (!useResultForever) {
      // clean up pending Promise
        activeFunctions.splice(pendingFunctionIDX, 1);
      }
    }
  };

  // didn't find a pending existing promise, make a new one!
  const newPromise = (self !== null && self !== undefined) ? fn.apply(self, args) : fn(...args);
  newPromise.then((value) => {
    // clean up our pending Promise
    if (!useResultForever) {
      cleanupPendingFunction();
    } else {
      const pendingFunctionIDX = findActiveFunctionIndex(self, fn, argsSerialise);
      if (pendingFunctionIDX >= 0) {
      // store result so we can re-use it for future calls
        activeFunctions[pendingFunctionIDX].resolved = true;
        activeFunctions[pendingFunctionIDX].value = value;
      }
    }

    return value;
  }).catch((err) => {
    cleanupPendingFunction();
    throw err;
  });
  activeFunctions.push({
    fn,
    self,
    args: argsSerialise,
    promise: newPromise,
    resolved: false,
  });
  return newPromise;
}

export default reusePromise;

import {Router as expressRouter, json as expressParseJSON} from 'express';

import {getFunctionCacheKey} from '../../lib/util.js';

import {sendMessage} from './livefeed.js';

import {v4 as uuidv4} from 'uuid';

const ignoreMethods = [
  "setMaxListeners",
  "getMaxListeners",
  "emit",
  "addListener",
  "on",
  "prependListener",
  "once",
  "prependOnceListener",
  "removeListener",
  "off",
  "removeAllListeners",
  "listeners",
  "rawListeners",
  "listenerCount",
  "eventNames",
  "__defineGetter__",
  "__defineSetter__",
  "hasOwnProperty",
  "__lookupGetter__",
  "__lookupSetter__",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toString",
  "valueOf",
  "toLocaleString",
  // ignore our internal log function
  'log',
];
// list all methods of an object
const getMethods = (obj) => {
  let properties = new Set()
  let currentObj = obj
  do {
    Object.getOwnPropertyNames(currentObj).map(item => properties.add(item))
  } while ((currentObj = Object.getPrototypeOf(currentObj)))
  return [...properties.keys()].filter(item => typeof obj[item] === 'function' && item !== 'constructor' && !ignoreMethods.includes(item))
}

class DebugDestination {
  constructor({
    destination,
  }) {
    this.destination = new destination();
    this._injectDestination();
    this.router = expressRouter();

    this.router.get('/', this.httpGetState.bind(this));

    const methods = getMethods(this.destination);
    this.router.get('/methods', (req, res) => {
      res.json({methods});
    });
    methods.forEach((method) => {
      this.router.post(`/methods/${method}`, expressParseJSON(), async (req, res) => {
        if (!this.destination[method]) {
          res.status(404).json({error: `Method ${method} not found`});
        }

        const args = req.body?.args || [];

        // test if we have this method in the cache
        const cacheKey = getFunctionCacheKey(method, args);
        const cacheData = await this.destination.cache.get(cacheKey, true);
        const now = +new Date();

        const resultObj = {
          requestStart: now,
        };

        resultObj.cache = {};
        resultObj.cache.valid = (cacheData?.expires && cacheData.expires >= now);
        resultObj.cache.expires = cacheData?.expires || null;
        resultObj.cache.expiresIn = cacheData?.expires ? cacheData.expires - now : null;

        this.destination[method](...args).then((result) => {
          res.json({
            ...resultObj,
            result: result,
            requestEnd: +new Date(),
          });
        });
      });
    });

    // return result body for a given function call id
    this.results = [];
    this.router.get('/methods/_results/:uuid', (req, res) => {
      const uuid = req.params.uuid;
      const result = this.results.find((result) => result.id === uuid);
      if (!result) {
        res.status(404).json({error: `Result ${uuid} not found`});
      }
      res.json(result);
    });
  }

  _injectDestination() {
    // intercept all methods of the destination
    const methods = getMethods(this.destination);
    for (const method of methods) {
      const originalFunction = this.destination[method];
      this.destination[method] = (...args) => {
        // broadcast to livefeed that this function was called
        const functionCallId = uuidv4();
        sendMessage({
          id: functionCallId,
          type: 'function_call',
          method,
          args,
        });

        // call original function
        try {
          const result = originalFunction.apply(this.destination, args);

          const broadcastResult = (resultData) => {
            // remember result
            this.results.push({
              id: functionCallId,
              result: resultData,
            });
            
            // broadcast function result
            sendMessage({
              id: functionCallId,
              type: 'function_result',
              method,
              args,
              // data is too big to send constantly to client, request it separately
              // resultData: Buffer.isBuffer(resultData) ? '[buffer]' : resultData,
            });
          };

          if (result instanceof Promise) {
            // if the result is a promise, wait for it to resolve
            return result.then((result) => {
              broadcastResult(result);
              return result;
            });
          } else {
            // if the result is not a promise, broadcast immediately
            broadcastResult(result);
          }

          return result;
        } catch (err) {
          sendMessage({
            idx: functionCallIdx,
            type: 'function_error',
            method,
            args,
            error: err,
          });
          throw err;
        }
      };
    }
  }

  getRouter() {
    return this.router;
  }

  getDestination() {
    return this.destination;
  }

  httpGetState(req, res) {
    res.json({
      name: this.destination.name,
      time: this.destination.getTimeNow(),
    });
  }
}

export default DebugDestination;

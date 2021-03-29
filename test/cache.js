import assert from 'assert';

import Cache from '../lib/cache/scopedCache.js';

import LmdbCache from '../lib/cache/cacheLmdb.js';
import LevelCache from '../lib/cache/cacheLevel.js';
import MemoryCache from '../lib/cache/cacheMemory.js';

const cacheTypes = {
  'LMDB': new LmdbCache(),
  'Level': new LevelCache(),
  'Memory': new MemoryCache(),
};

// TODO - create cache in-memory for testing

const wait = async (ms) => {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

/**
 * Test a specific cache type
 * @param {cacheObject} cache
 */
async function testCacheType(cache) {
  // test set/get
  for (let i=0; i<1000; i++) {
    await cache.set('test', i);
    const value = await cache.get('test');
    assert(value === i, `Failed to get set value of ${value}`);
  }
  await cache.set('test', 2021);
  const getValue = await cache.get('test');
  assert(getValue === 2021, `Getting set value is invalid ${getValue}`);

  // test set with minor variation
  await cache.set('test', 2020);
  const getValue2 = await cache.get('test');
  assert(getValue2 === 2020, `Getting set value 2nd time is invalid ${getValue2}`);

  // test delete through negative ttl
  await cache.set('test', undefined, -1);
  const getValue3 = await cache.get('test');
  assert(getValue3 === undefined, `Getting set value 3rd time should be undefined: ${getValue3}`);

  await cache.set('testkey1', undefined, -1);
  await cache.set('testkey2', undefined, -1);

  // test setting multiple keys and then using getKeys
  await cache.set('testkey1', 1);
  await cache.set('testkey2', 2);

  const keys = await cache.getKeys();
  assert(keys.indexOf('testkey1') >= 0, 'getKeys() must return our first test key');
  assert(keys.indexOf('testkey2') >= 0, 'getKeys() must return our second test key');
}

describe('Base Cache Behaviour', function() {
  for (const dbName of Object.keys(cacheTypes)) {
    it(`${dbName}`, async function() {
      await testCacheType(cacheTypes[dbName]);
    });
  };
});

/**
 * Test a specific cache type for transactions support
 * @param {cacheBash} cacheObject
 */
async function testCacheTransactions(cacheObject) {
  const cache = new Cache('transactions_01', 0, cacheObject);
  await cache.runTransaction(async (lock) => {
    await lock.set('test', 1);
    const val = await lock.get('test');
    assert(val === 1, 'Data set should be valid within transaction');
  });

  const val = await cache.get('test');
  assert(val === 1, `Data set should be present when transaction finishes, ${val}`);

  // test running a get while a transaction is pending...
  //  note no "await" before runTransaction
  const val2Tester = 50 + Math.floor(Math.random() * 999);
  await cache.set('test_2', 0);
  cache.runTransaction(async (lock) => {
    await wait(50);
    await lock.set('test_2', val2Tester);
  });

  await wait(10);
  const val2 = await cache.get('test_2');
  assert(val2 === val2Tester, `Cache get must not return until transaction is done ${val2Tester} vs ${val2}`);

  // test running multiple transactions blocking a single get operation
  const val3Tester = 50 + Math.floor(Math.random() * 999);
  await cache.set('test_3', 0);
  let secondTransactionDone = false;
  cache.runTransaction(async (lock) => {
    await wait(50);
    await lock.set('test_3', val3Tester);
  });
  cache.runTransaction(async (lock) => {
    await wait(70);
    secondTransactionDone = true;
  });

  const val3Test1 = await cache.get('test_3');
  assert(val3Test1 === val3Tester, 'Get request waited until first transaction completed');
  assert(secondTransactionDone, 'Second transaction did not finish before get request was unblocked');
}

describe('Cache Transactions', function() {
  for (const dbName of Object.keys(cacheTypes)) {
    it(`${dbName} Transactions`, async function() {
      await testCacheTransactions(cacheTypes[dbName]);
    });
  };
});

import assert from 'assert';

import Cache from '../lib/cache/scopedCache.js';

// TODO - create cache in-memory for testing

const wait = async (ms) => {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

describe('Transactions', function() {
  it('#commit()', async function() {
    const cache = new Cache('blockUntilCommit');

    await cache.set('test', 1337);
    const testSetter = await cache.get('test');
    assert(testSetter === 1337, `Cache setter+getter failed: ${testSetter}`);

    const lock = cache.createLock();
    const lockGetter = await lock.get('test');
    assert(lockGetter === 1337, `Lock getter failed: ${lockGetter}`);

    // update and release the lock
    setTimeout(async () => {
      await lock.set('test', 1338);
      await lock.commit();
    }, 10);

    const postCommitGetter = await cache.get('test');
    assert(postCommitGetter === 1338, `Post-Commit getter failed: ${postCommitGetter}`);
  });

  it('#rollback()', async function() {
    const cache = new Cache('blockUntilRollback');

    await cache.set('test', 1337);
    const testSetter = await cache.get('test');
    assert(testSetter === 1337, `Cache setter+getter failed: ${testSetter}`);

    const lock = cache.createLock();
    const lockGetter = await lock.get('test');
    assert(lockGetter === 1337, `Lock getter failed: ${lockGetter}`);

    // rollback and release the lock
    setTimeout(async () => {
      await lock.set('test', 1338);
      await lock.rollback();
    }, 10);

    const postRollbackGetter = await cache.get('test');
    assert(postRollbackGetter === 1337, `Post-Rollback getter failed: ${postRollbackGetter}`);
  });

  it('multiple blocks', async function() {
    const cache = new Cache('multipleBlocks');

    await cache.set('test', 1337);
    const testSetter = await cache.get('test');
    assert(testSetter === 1337, `Cache setter+getter failed: ${testSetter}`);

    const lock = cache.createLock();
    const lockGetter = await lock.get('test');
    assert(lockGetter === 1337, `Lock getter failed: ${lockGetter}`);

    // test that having two pending get()s both fire after commit
    let passedBlock1 = false;
    let passedBlock2 = false;
    setTimeout(async () => {
      const val = await cache.get('test');
      passedBlock1 = (val === 1337);
    }, 10);
    setTimeout(async () => {
      const val = await cache.get('test');
      passedBlock2 = (val === 1337);
    }, 10);

    await wait(50);
    assert(!passedBlock1 && !passedBlock2, 'Blocks should not released until commit');
    await lock.commit();
    await wait(50);

    assert(passedBlock1 && passedBlock2, 'Both blocks were not triggered after lock is committed');
  });

  it('multiple locks', async function() {
    const cache = new Cache('multiLocks');

    await cache.set('test', 1337);
    const testSetter = await cache.get('test');
    assert(testSetter === 1337, `Cache setter+getter failed: ${testSetter}`);

    const lock1 = cache.createLock();
    const lockGetter = await lock1.get('test');
    assert(lockGetter === 1337, `Lock getter failed: ${lockGetter}`);

    const lock2 = cache.createLock();
    const lock3 = cache.createLock();

    let lock2Blocked = true;
    setTimeout(async () => {
      const lock2Getter = await lock2.get('test');
      assert(lock2Getter === 1337);
      lock2Blocked = false;
    }, 10);
    let lock3Blocked = true;
    setTimeout(async () => {
      const lock3Getter = await lock3.get('test');
      assert(lock3Getter === 1337);
      lock3Blocked = false;
    }, 10);

    await wait(50);
    assert(lock2Blocked, 'Lock 2 should be blocked until lock 1 is released');
    assert(lock3Blocked, 'Lock 3 should be blocked until lock 1 is released');

    await lock1.commit();
    await wait(10);
    assert(!lock2Blocked, 'Lock 2 should be unlocked once lock 1 is released');
    assert(lock3Blocked, 'Lock 3 should be blocked until lock 2 is released');

    await lock2.commit();
    await wait(10);
    assert(!lock3Blocked, 'Lock 3 should be unlocked once lock 2 is released');
  });
});

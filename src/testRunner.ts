/**
 * Generic test runner for any park implementation
 * Tests all required Destination methods
 */

import {Destination} from './destination.js';
import {Entity, LiveData, EntitySchedule} from '@themeparks/typelib';
import {getQueueLength} from './http.js';
import {tracing} from './tracing.js';
import {typeDetector} from './typeDetector.js';
import {findOrphanIds} from './orphanCheck.js';
import {findDuplicateEntityIds, describeDuplicateEntityIds} from './duplicateCheck.js';

export type TestResult = {
  testName: string;
  passed: boolean;
  error?: string;
  duration: number;
  details?: any;
};

export type ParkTestSummary = {
  parkName: string;
  parkId: string;
  passed: boolean;
  totalTests: number;
  passedTests: number;
  failedTests: number;
  duration: number;
  results: TestResult[];
};

/**
 * Wait for HTTP queue to clear
 */
async function waitForQueue(timeoutMs: number = 30000): Promise<void> {
  const startTime = Date.now();
  while (getQueueLength() > 0) {
    if (Date.now() - startTime > timeoutMs) {
      throw new Error(`HTTP queue timeout after ${timeoutMs}ms`);
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

/**
 * Run a single test with timing
 */
async function runTest(
  testName: string,
  testFn: () => Promise<any>
): Promise<TestResult> {
  const startTime = Date.now();
  try {
    const result = await testFn();
    const duration = Date.now() - startTime;
    return {
      testName,
      passed: true,
      duration,
      details: result,
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    return {
      testName,
      passed: false,
      error: error instanceof Error ? error.message : String(error),
      duration,
    };
  }
}

/**
 * Test a park implementation
 */
export async function testPark(
  parkId: string,
  parkName: string,
  park: Destination,
  options: {
    verbose?: boolean;
    skipLiveData?: boolean;
    skipSchedules?: boolean;
    detectTypes?: boolean;
    sourceFilePath?: string;
    realClassName?: string;
  } = {}
): Promise<ParkTestSummary> {
  const { verbose = false, skipLiveData = false, skipSchedules = false, detectTypes = false, sourceFilePath, realClassName } = options;
  const results: TestResult[] = [];
  const startTime = Date.now();

  // Register source file path for type detection
  if (detectTypes && sourceFilePath && realClassName) {
    typeDetector.registerSourceFile(realClassName, sourceFilePath);
  }

  if (verbose) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Testing: ${parkName}`);
    console.log(`${'='.repeat(60)}\n`);
  }

  // Helper to run tests (with or without tracing)
  const executeTests = async () => {
    // Test 1: getDestinations()
    if (verbose) console.log('1. Testing getDestinations()...');
    const destResult = await runTest('getDestinations', async () => {
    const destinations = await park.getDestinations();
    await waitForQueue();

    if (!Array.isArray(destinations)) {
      throw new Error('getDestinations() must return an array');
    }
    if (destinations.length === 0) {
      throw new Error('getDestinations() returned empty array');
    }

    // Validate destination structure
    destinations.forEach((dest, idx) => {
      if (!dest.id) throw new Error(`Destination ${idx} missing 'id'`);
      if (!dest.name) throw new Error(`Destination ${idx} missing 'name'`);
      if (!dest.entityType) throw new Error(`Destination ${idx} missing 'entityType'`);
      if (dest.entityType !== 'DESTINATION') {
        throw new Error(`Destination ${idx} has wrong entityType: ${dest.entityType}`);
      }
    });

    return { count: destinations.length, destinations };
  });
  results.push(destResult);
  if (verbose) {
    console.log(destResult.passed
      ? `   ✓ Found ${destResult.details.count} destination(s) (${destResult.duration}ms)`
      : `   ✗ Failed: ${destResult.error}`);
  }

  // Test 2: getEntities()
  if (verbose) console.log('\n2. Testing getEntities()...');
  const entitiesResult = await runTest('getEntities', async () => {
    const entities = await park.getEntities();
    await waitForQueue();

    if (!Array.isArray(entities)) {
      throw new Error('getEntities() must return an array');
    }
    if (entities.length === 0) {
      throw new Error('getEntities() returned empty array');
    }

    // Validate entity structures
    const ID_CHARSET = /^[\w.-]+$/;
    entities.forEach((entity, idx) => {
      if (!entity.id) throw new Error(`Entity ${idx} missing 'id'`);
      if (!entity.name) throw new Error(`Entity ${idx} missing 'name'`);
      if (!entity.entityType) throw new Error(`Entity ${idx} missing 'entityType'`);
      if (!ID_CHARSET.test(entity.id)) {
        // Report invisible/non-ASCII chars verbosely for diagnosis
        const escaped = JSON.stringify(entity.id);
        throw new Error(`Entity ${idx} id has unsafe characters: ${escaped} ("${entity.name}")`);
      }
    });

    // Structural uniqueness requirement: an id identifies one entity.
    //
    // A hard failure rather than a warning, unlike the orphan and missing-
    // location reports below. An orphan row is dead weight a consumer ignores;
    // a duplicate id means one of the two entities is silently discarded on
    // the way out, and there is no legitimate reason to emit one twice. It
    // stays invisible otherwise: Walibi Holland shipped two Walibi Express
    // stations under one CMS wait-time id, and Station 2 has never existed on
    // the wiki as a result.
    //
    // Safe to fail hard: surveyed across all 80 destinations, Walibi Holland
    // was the only one, and it is fixed alongside this check.
    const duplicateIds = findDuplicateEntityIds(entities);
    if (duplicateIds.length > 0) {
      throw new Error(`Duplicate entity ids: ${describeDuplicateEntityIds(duplicateIds)}`);
    }

    // Structural location requirement: DESTINATION + PARK must have location.
    // These are the anchor points for the whole hierarchy — a missing coord
    // almost always indicates a mapEntities wiring bug.
    const missingAnchorLocation = entities.filter(
      (e) => (e.entityType === 'DESTINATION' || e.entityType === 'PARK') && !e.location,
    );
    if (missingAnchorLocation.length > 0) {
      const list = missingAnchorLocation.map((e) => `${e.entityType} "${e.name}" (${e.id})`).join(', ');
      throw new Error(`Anchor entities missing 'location': ${list}`);
    }

    // Count by type
    const entityTypes = entities.reduce((acc, e) => {
      acc[e.entityType] = (acc[e.entityType] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    // Non-anchor entities without location — report as a count, not a failure
    // (some venues genuinely don't publish coords for every attraction).
    const missingLocation = entities.reduce((acc, e) => {
      if (e.entityType !== 'DESTINATION' && e.entityType !== 'PARK' && !e.location) {
        acc[e.entityType] = (acc[e.entityType] || 0) + 1;
      }
      return acc;
    }, {} as Record<string, number>);

    return { count: entities.length, entityTypes, entities, missingLocation };
  });
  results.push(entitiesResult);
  if (verbose) {
    if (entitiesResult.passed) {
      console.log(`   ✓ Found ${entitiesResult.details.count} entities (${entitiesResult.duration}ms)`);
      Object.entries(entitiesResult.details.entityTypes).forEach(([type, count]) => {
        console.log(`     - ${type}: ${count}`);
      });
      const missing = entitiesResult.details.missingLocation as Record<string, number>;
      if (missing && Object.keys(missing).length > 0) {
        const summary = Object.entries(missing).map(([type, n]) => `${type}:${n}`).join(' ');
        console.log(`     ⚠ Missing location: ${summary}`);
      }
    } else {
      console.log(`   ✗ Failed: ${entitiesResult.error}`);
    }
  }

  // IDs the destination actually publishes. Live data and schedules keyed to
  // anything outside this set can't be looked up by a consumer, so they are
  // dead weight in the output. Empty when getEntities() failed, in which case
  // the orphan checks below stay quiet rather than reporting every row.
  const publishedIds = new Set<string>(
    entitiesResult.passed
      ? ((entitiesResult.details?.entities ?? []) as Array<{id: string}>).map((e) => e.id)
      : [],
  );

  const findOrphans = (rows: Array<{id?: string}>): string[] => findOrphanIds(rows, publishedIds);

  const reportOrphans = (orphans: string[], label: string): void => {
    if (orphans.length === 0) return;
    const sample = orphans.slice(0, 5).join(', ');
    const more = orphans.length > 5 ? `, +${orphans.length - 5} more` : '';
    console.log(`     ⚠ ${label} for unpublished entities: ${orphans.length} (${sample}${more})`);
  };

  // Test 3: getLiveData()
  if (!skipLiveData) {
    if (verbose) console.log('\n3. Testing getLiveData()...');
    const liveDataResult = await runTest('getLiveData', async () => {
      const liveData = await park.getLiveData();
      await waitForQueue();

      if (!Array.isArray(liveData)) {
        throw new Error('getLiveData() must return an array');
      }

      // Count by status
      const statuses = liveData.reduce((acc, l) => {
        acc[l.status || 'UNKNOWN'] = (acc[l.status || 'UNKNOWN'] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);

      // Count entries with wait times
      const withWaitTimes = liveData.filter(l => l.queue?.STANDBY?.waitTime !== undefined).length;

      const orphanIds = findOrphans(liveData);

      return { count: liveData.length, statuses, withWaitTimes, liveData, orphanIds };
    });
    results.push(liveDataResult);
    if (verbose) {
      if (liveDataResult.passed) {
        console.log(`   ✓ Found ${liveDataResult.details.count} live data entries (${liveDataResult.duration}ms)`);
        console.log(`     - With wait times: ${liveDataResult.details.withWaitTimes}`);
        Object.entries(liveDataResult.details.statuses).forEach(([status, count]) => {
          console.log(`     - ${status}: ${count}`);
        });
        reportOrphans(liveDataResult.details.orphanIds ?? [], 'Live data');
      } else {
        console.log(`   ✗ Failed: ${liveDataResult.error}`);
      }
    }
  }

  // Test 4: getSchedules()
  if (!skipSchedules) {
    if (verbose) console.log('\n4. Testing getSchedules()...');
    const schedulesResult = await runTest('getSchedules', async () => {
      const schedules = await park.getSchedules();
      await waitForQueue();

      if (!Array.isArray(schedules)) {
        throw new Error('getSchedules() must return an array');
      }

      // Validate schedule structures
      schedules.forEach((schedule, idx) => {
        if (!schedule.id) throw new Error(`Schedule ${idx} missing 'id'`);
        if (!schedule.schedule) throw new Error(`Schedule ${idx} missing 'schedule' array`);
        if (!Array.isArray(schedule.schedule)) {
          throw new Error(`Schedule ${idx} 'schedule' must be an array`);
        }
      });

      const totalDays = schedules.reduce((sum, s) => sum + s.schedule.length, 0);

      const orphanIds = findOrphans(schedules);
      const orphanIdSet = new Set(orphanIds);
      const orphanDays = schedules
        .filter((s) => orphanIdSet.has(s.id))
        .reduce((sum, s) => sum + s.schedule.length, 0);

      return { count: schedules.length, totalDays, schedules, orphanIds, orphanDays };
    });
    results.push(schedulesResult);
    if (verbose) {
      if (schedulesResult.passed) {
        console.log(`   ✓ Found ${schedulesResult.details.count} schedule(s) with ${schedulesResult.details.totalDays} total days (${schedulesResult.duration}ms)`);
        const orphanIds = (schedulesResult.details.orphanIds ?? []) as string[];
        reportOrphans(orphanIds, 'Schedules');
        if (orphanIds.length > 0) {
          console.log(`       (${schedulesResult.details.orphanDays} of ${schedulesResult.details.totalDays} days affected)`);
        }
      } else {
        console.log(`   ✗ Failed: ${schedulesResult.error}`);
      }
    }
  }

    const duration = Date.now() - startTime;
    const passedTests = results.filter(r => r.passed).length;
    const failedTests = results.filter(r => !r.passed).length;
    const passed = failedTests === 0;

    if (verbose) {
      console.log(`\n${passed ? '✅' : '❌'} ${parkName}: ${passedTests}/${results.length} tests passed (${duration}ms)`);
    }

    return {
      parkName,
      parkId,
      passed,
      totalTests: results.length,
      passedTests,
      failedTests,
      duration,
      results,
    };
  };

  // Execute tests with or without tracing
  if (detectTypes) {
    const traceResult = await tracing.trace(executeTests, { parkId, parkName });
    return traceResult.result;
  } else {
    return await executeTests();
  }
}

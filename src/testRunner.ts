/**
 * Generic test runner for any park implementation
 * Tests all required Destination methods
 */

import {Destination} from './destination.js';
import {Entity, LiveData, EntitySchedule} from '@themeparks/typelib';
import {getQueueLength} from './http.js';
import {tracing} from './tracing.js';
import {typeDetector} from './typeDetector.js';

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
  } = {}
): Promise<ParkTestSummary> {
  const { verbose = false, skipLiveData = false, skipSchedules = false, detectTypes = false, sourceFilePath } = options;
  const results: TestResult[] = [];
  const startTime = Date.now();

  // Register source file path for type detection
  if (detectTypes && sourceFilePath) {
    const className = park.constructor.name;
    typeDetector.registerSourceFile(className, sourceFilePath);
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
    entities.forEach((entity, idx) => {
      if (!entity.id) throw new Error(`Entity ${idx} missing 'id'`);
      if (!entity.name) throw new Error(`Entity ${idx} missing 'name'`);
      if (!entity.entityType) throw new Error(`Entity ${idx} missing 'entityType'`);
    });

    // Count by type
    const entityTypes = entities.reduce((acc, e) => {
      acc[e.entityType] = (acc[e.entityType] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    return { count: entities.length, entityTypes, entities };
  });
  results.push(entitiesResult);
  if (verbose) {
    if (entitiesResult.passed) {
      console.log(`   ✓ Found ${entitiesResult.details.count} entities (${entitiesResult.duration}ms)`);
      Object.entries(entitiesResult.details.entityTypes).forEach(([type, count]) => {
        console.log(`     - ${type}: ${count}`);
      });
    } else {
      console.log(`   ✗ Failed: ${entitiesResult.error}`);
    }
  }

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

      return { count: liveData.length, statuses, withWaitTimes, liveData };
    });
    results.push(liveDataResult);
    if (verbose) {
      if (liveDataResult.passed) {
        console.log(`   ✓ Found ${liveDataResult.details.count} live data entries (${liveDataResult.duration}ms)`);
        console.log(`     - With wait times: ${liveDataResult.details.withWaitTimes}`);
        Object.entries(liveDataResult.details.statuses).forEach(([status, count]) => {
          console.log(`     - ${status}: ${count}`);
        });
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

      return { count: schedules.length, totalDays, schedules };
    });
    results.push(schedulesResult);
    if (verbose) {
      if (schedulesResult.passed) {
        console.log(`   ✓ Found ${schedulesResult.details.count} schedule(s) with ${schedulesResult.details.totalDays} total days (${schedulesResult.duration}ms)`);
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

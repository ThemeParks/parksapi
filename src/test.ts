/**
 * Flexible test harness for ParksAPI
 *
 * Usage:
 *   npm run dev                          # Test all parks
 *   npm run dev -- universalorlando      # Test specific park
 *   npm run dev -- --list                # List available parks
 *   npm run dev -- --category Universal  # Test all Universal parks
 */

import {getAllDestinations, getDestinationById, getDestinationsByCategory, listDestinationIds} from './destinationRegistry.js';
import {testPark, ParkTestSummary} from './testRunner.js';
import {typeDetector} from './typeDetector.js';
import {CacheLib} from './cache.js';

/**
 * Parse CLI arguments
 */
function parseArgs(): {
  mode: 'list' | 'single' | 'category' | 'all';
  parkId?: string;
  category?: string;
  verbose?: boolean;
  skipLiveData?: boolean;
  skipSchedules?: boolean;
  detectTypes?: boolean;
  ignoreCache?: boolean;
} {
  const args = process.argv.slice(2);

  if (args.includes('--list')) {
    return { mode: 'list' };
  }

  const categoryIdx = args.indexOf('--category');
  if (categoryIdx !== -1 && args[categoryIdx + 1]) {
    const detectTypes = args.includes('--detect-types');
    return {
      mode: 'category',
      category: args[categoryIdx + 1],
      verbose: args.includes('--verbose') || args.includes('-v'),
      skipLiveData: args.includes('--skip-live-data'),
      skipSchedules: args.includes('--skip-schedules'),
      detectTypes,
      ignoreCache: args.includes('--ignore-cache') || detectTypes, // --detect-types implies --ignore-cache
    };
  }

  // Check for specific park ID
  const parkId = args.find(arg => !arg.startsWith('--') && !arg.startsWith('-'));
  if (parkId) {
    const detectTypes = args.includes('--detect-types');
    return {
      mode: 'single',
      parkId,
      verbose: args.includes('--verbose') || args.includes('-v'),
      skipLiveData: args.includes('--skip-live-data'),
      skipSchedules: args.includes('--skip-schedules'),
      detectTypes,
      ignoreCache: args.includes('--ignore-cache') || detectTypes, // --detect-types implies --ignore-cache
    };
  }

  const detectTypes = args.includes('--detect-types');
  return {
    mode: 'all',
    verbose: args.includes('--verbose') || args.includes('-v'),
    skipLiveData: args.includes('--skip-live-data'),
    skipSchedules: args.includes('--skip-schedules'),
    detectTypes,
    ignoreCache: args.includes('--ignore-cache') || detectTypes, // --detect-types implies --ignore-cache
  };
}

/**
 * List all available parks
 */
async function listParks(): Promise<void> {
  console.log('\n📋 Available Parks:\n');

  const parks = await getAllDestinations();

  // Build category map - parks can appear in multiple categories
  const byCategory: Record<string, typeof parks> = {};
  parks.forEach(park => {
    const categories = Array.isArray(park.category) ? park.category : [park.category];
    categories.forEach(category => {
      if (!byCategory[category]) byCategory[category] = [];
      byCategory[category].push(park);
    });
  });

  // Sort categories alphabetically
  const sortedCategories = Object.keys(byCategory).sort();

  sortedCategories.forEach(category => {
    console.log(`${category}:`);
    byCategory[category].forEach(park => {
      const categories = Array.isArray(park.category) ? park.category : [park.category];
      const categoryTag = categories.length > 1 ? ` [${categories.join(', ')}]` : '';
      console.log(`  ${park.id.padEnd(25)} - ${park.name}${categoryTag}`);
    });
    console.log('');
  });

  console.log(`Total: ${parks.length} parks\n`);
  console.log('Usage:');
  console.log('  npm run dev -- <parkId>                  # Test specific park');
  console.log('  npm run dev -- --category <category>     # Test all parks in category');
  console.log('  npm run dev                              # Test all parks');
  console.log('  npm run dev -- --verbose                 # Verbose output');
  console.log('  npm run dev -- --skip-live-data          # Skip live data tests');
  console.log('  npm run dev -- --skip-schedules          # Skip schedule tests');
  console.log('  npm run dev -- --detect-types            # Generate type files from HTTP responses');
  console.log('  npm run dev -- --ignore-cache            # Use fresh in-memory cache (implied by --detect-types)\n');
}

/**
 * Print summary of all test results
 */
function printSummary(summaries: ParkTestSummary[]): void {
  console.log('\n\n' + '='.repeat(80));
  console.log('📊 TEST SUMMARY');
  console.log('='.repeat(80) + '\n');

  const passed = summaries.filter(s => s.passed);
  const failed = summaries.filter(s => !s.passed);

  // Overall stats
  const totalTests = summaries.reduce((sum, s) => sum + s.totalTests, 0);
  const passedTests = summaries.reduce((sum, s) => sum + s.passedTests, 0);
  const totalDuration = summaries.reduce((sum, s) => sum + s.duration, 0);

  console.log(`Parks Tested:    ${summaries.length}`);
  console.log(`Parks Passed:    ${passed.length} ✅`);
  console.log(`Parks Failed:    ${failed.length} ${failed.length > 0 ? '❌' : ''}`);
  console.log(`Total Tests:     ${passedTests}/${totalTests}`);
  console.log(`Total Duration:  ${(totalDuration / 1000).toFixed(2)}s\n`);

  // Individual results
  if (summaries.length > 1) {
    console.log('Individual Results:');
    summaries.forEach(summary => {
      const icon = summary.passed ? '✅' : '❌';
      const testInfo = `${summary.passedTests}/${summary.totalTests}`;
      const duration = `${(summary.duration / 1000).toFixed(2)}s`;
      console.log(`  ${icon} ${summary.parkName.padEnd(40)} ${testInfo.padEnd(10)} ${duration}`);
    });
    console.log('');
  }

  // Failed test details
  if (failed.length > 0) {
    console.log('Failed Tests:');
    failed.forEach(summary => {
      console.log(`\n  ❌ ${summary.parkName}:`);
      summary.results.filter(r => !r.passed).forEach(result => {
        console.log(`     - ${result.testName}: ${result.error}`);
      });
    });
    console.log('');
  }

  console.log('='.repeat(80));
  if (failed.length === 0) {
    console.log('🎉 ALL TESTS PASSED!');
  } else {
    console.log(`⚠️  ${failed.length} park(s) failed testing`);
  }
  console.log('='.repeat(80) + '\n');
}

/**
 * Main test runner
 */
async function main() {
  console.log('🎢 ParksAPI Test Suite\n');

  const config = parseArgs();

  // List mode
  if (config.mode === 'list') {
    await listParks();
    process.exit(0);
  }

  const summaries: ParkTestSummary[] = [];

  // Enable temporary cache mode if requested
  if (config.ignoreCache) {
    CacheLib.enableTemporaryMode();
  }

  // Start type detector if enabled
  if (config.detectTypes) {
    typeDetector.start();
  }

  try {
    // Single park mode
    if (config.mode === 'single') {
      const parkEntry = await getDestinationById(config.parkId!);
      if (!parkEntry) {
        console.error(`❌ Park not found: ${config.parkId}`);
        console.log('\nAvailable parks:');
        const ids = await listDestinationIds();
        ids.forEach(id => console.log(`  - ${id}`));
        process.exit(1);
      }

      const park = new parkEntry.DestinationClass();

      // Store real class name on instance for type detection
      if (config.detectTypes) {
        (park as any).__className__ = parkEntry.DestinationClass.name;
      }

      const summary = await testPark(config.parkId!, parkEntry.name, park, {
        verbose: true,
        skipLiveData: config.skipLiveData,
        skipSchedules: config.skipSchedules,
        detectTypes: config.detectTypes,
        sourceFilePath: parkEntry.sourceFilePath,
        realClassName: parkEntry.DestinationClass.name,
      });
      summaries.push(summary);
    }
    // Category mode
    else if (config.mode === 'category') {
      const parks = await getDestinationsByCategory(config.category as any);
      if (parks.length === 0) {
        console.error(`❌ No parks found in category: ${config.category}`);
        process.exit(1);
      }

      console.log(`Testing ${parks.length} parks in category: ${config.category}\n`);

      for (const parkEntry of parks) {
        const park = new parkEntry.DestinationClass();

        // Store real class name on instance for type detection
        if (config.detectTypes) {
          (park as any).__className__ = parkEntry.DestinationClass.name;
        }

        const summary = await testPark(parkEntry.id, parkEntry.name, park, {
          verbose: config.verbose || parks.length === 1,
          skipLiveData: config.skipLiveData,
          skipSchedules: config.skipSchedules,
          detectTypes: config.detectTypes,
          sourceFilePath: parkEntry.sourceFilePath,
          realClassName: parkEntry.DestinationClass.name,
        });
        summaries.push(summary);
      }
    }
    // All parks mode
    else {
      const parks = await getAllDestinations();
      console.log(`Testing all ${parks.length} parks\n`);

      for (const parkEntry of parks) {
        const park = new parkEntry.DestinationClass();

        // Store real class name on instance for type detection
        if (config.detectTypes) {
          (park as any).__className__ = parkEntry.DestinationClass.name;
        }

        const summary = await testPark(parkEntry.id, parkEntry.name, park, {
          verbose: config.verbose,
          skipLiveData: config.skipLiveData,
          skipSchedules: config.skipSchedules,
          detectTypes: config.detectTypes,
          sourceFilePath: parkEntry.sourceFilePath,
          realClassName: parkEntry.DestinationClass.name,
        });
        summaries.push(summary);

        // Brief progress indicator if not verbose
        if (!config.verbose) {
          const icon = summary.passed ? '✅' : '❌';
          console.log(`${icon} ${parkEntry.name} (${summary.passedTests}/${summary.totalTests} tests)`);
        }
      }
    }

    // Print summary
    printSummary(summaries);

    // Generate type files if type detection was enabled
    if (config.detectTypes) {
      console.log('\n' + '='.repeat(80));
      console.log('🔍 GENERATING TYPE FILES');
      console.log('='.repeat(80) + '\n');

      typeDetector.stop();
      const summary = typeDetector.getSummary();

      if (summary.length === 0) {
        console.log('⚠️  No HTTP responses captured for type detection\n');
      } else {
        console.log(`Captured ${summary.length} unique HTTP method(s):\n`);
        summary.forEach(({ key, count }) => {
          console.log(`  📦 ${key}: ${count} response(s)`);
        });
        console.log('');

        console.log('Generating TypeScript type files...\n');
        const results = await typeDetector.generateTypeFiles();

        const succeeded = results.filter(r => r.success);
        const failed = results.filter(r => !r.success);

        succeeded.forEach(({ filePath }) => {
          console.log(`  ✅ ${filePath}`);
        });

        if (failed.length > 0) {
          console.log('');
          failed.forEach(({ filePath, error }) => {
            console.log(`  ❌ ${filePath}: ${error}`);
          });
        }

        console.log('');
        console.log(`Generated ${succeeded.length}/${results.length} type file(s)`);
        console.log('='.repeat(80) + '\n');
      }
    }

    // Exit with appropriate code
    const allPassed = summaries.every(s => s.passed);
    process.exit(allPassed ? 0 : 1);

  } catch (error) {
    console.error('\n❌ Test suite failed:', error);
    process.exit(1);
  }
}

// Run tests
main();

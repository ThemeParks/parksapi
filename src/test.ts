/**
 * Manual test harness for Universal Studios parks
 * Run with: npm run dev
 */

import {UniversalOrlando, UniversalStudios} from './parks/universal/universal.js';
import {processHttpQueue, getQueueLength} from './http.js';

async function testUniversalOrlando() {
  console.log('\n========================================');
  console.log('Testing Universal Orlando Resort');
  console.log('========================================\n');

  const park = new UniversalOrlando();

  try {
    // Test 1: Get Destinations
    console.log('1. Fetching destinations...');
    const destinations = await park.getDestinations();
    console.log(`✓ Found ${destinations.length} destination(s):`);
    destinations.forEach(d => console.log(`  - ${d.name} (${d.id})`));

    // Wait for HTTP queue to process
    while (getQueueLength() > 0) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    // Test 2: Get Entities
    console.log('\n2. Fetching all entities...');
    const entities = await park.getEntities();
    console.log(`✓ Found ${entities.length} total entities`);

    // Wait for HTTP queue
    while (getQueueLength() > 0) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    // Break down by type
    const entityTypes = entities.reduce((acc, e) => {
      acc[e.entityType] = (acc[e.entityType] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    Object.entries(entityTypes).forEach(([type, count]) => {
      console.log(`  - ${type}: ${count}`);
    });

    // Show sample entities
    console.log('\n  Sample entities:');
    const parks = entities.filter(e => e.entityType === 'PARK').slice(0, 3);
    parks.forEach(p => console.log(`    [PARK] ${p.name} (${p.id})`));

    const attractions = entities.filter(e => e.entityType === 'ATTRACTION').slice(0, 5);
    attractions.forEach(a => console.log(`    [ATTRACTION] ${a.name} (${a.id})`));

    // Test 3: Get Live Data
    console.log('\n3. Fetching live data...');
    const liveData = await park.getLiveData();
    console.log(`✓ Found ${liveData.length} live data entries`);

    // Wait for HTTP queue
    while (getQueueLength() > 0) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    // Sample live data
    console.log('\n  Sample live data:');
    const operating = liveData.filter(l => l.status === 'OPERATING').slice(0, 5);
    operating.forEach(l => {
      const entity = entities.find(e => e.id === l.id);
      const queueInfo = l.queue?.STANDBY?.waitTime !== undefined
        ? `Wait: ${l.queue.STANDBY.waitTime} min`
        : 'No wait time';
      console.log(`    ${entity?.name || l.id}: ${l.status} (${queueInfo})`);
    });

    // Test 4: Get Schedules
    console.log('\n4. Fetching schedules...');
    const schedules = await park.getSchedules();
    console.log(`✓ Found ${schedules.length} schedule(s)`);

    // Wait for HTTP queue
    while (getQueueLength() > 0) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    // Sample schedules
    schedules.forEach(s => {
      const entity = entities.find(e => e.id === s.id);
      console.log(`\n  ${entity?.name || s.id}:`);
      s.schedule.slice(0, 3).forEach(day => {
        console.log(`    ${day.date}: ${day.openingTime} - ${day.closingTime} (${day.type})`);
      });
      if (s.schedule.length > 3) {
        console.log(`    ... and ${s.schedule.length - 3} more days`);
      }
    });

    console.log('\n✅ All tests passed for Universal Orlando!');
  } catch (error) {
    console.error('\n❌ Test failed:', error);
    throw error;
  }
}

async function main() {
  console.log('🎢 ParksAPI TypeScript Test Suite');
  console.log('==================================\n');

  try {
    await testUniversalOrlando();

    console.log('\n\n========================================');
    console.log('✅ All tests completed successfully!');
    console.log('========================================\n');

    process.exit(0);
  } catch (error) {
    console.error('\n❌ Test suite failed:', error);
    process.exit(1);
  }
}

// Run tests
main();

/**
 * Park health check — validates each park's core API endpoints.
 * Catches API changes (404s, auth failures, format changes) proactively.
 *
 * Usage:
 *   npm run health                     # Check all parks
 *   npm run health -- efteling          # Check specific park
 *   npm run health -- --category Disney # Check all Disney parks
 */

import { getAllDestinations, getDestinationById, getDestinationsByCategory } from '../destinationRegistry.js';
import { Destination } from '../destination.js';
import { waitForHttpQueue, stopHttpQueue } from '../http.js';

type HealthResult = {
  parkId: string;
  parkName: string;
  destinations: { ok: boolean; count: number; error?: string };
  entities: { ok: boolean; count: number; error?: string };
  liveData: { ok: boolean; count: number; error?: string };
  schedules: { ok: boolean; count: number; error?: string };
  duration: number;
};

async function checkPark(parkId: string, parkName: string, park: Destination): Promise<HealthResult> {
  const start = Date.now();
  const result: HealthResult = {
    parkId,
    parkName,
    destinations: { ok: false, count: 0 },
    entities: { ok: false, count: 0 },
    liveData: { ok: false, count: 0 },
    schedules: { ok: false, count: 0 },
    duration: 0,
  };

  // Check destinations
  try {
    const dests = await park.getDestinations();
    await waitForHttpQueue();
    result.destinations = { ok: dests.length > 0, count: dests.length };
  } catch (e: any) {
    result.destinations = { ok: false, count: 0, error: e.message?.substring(0, 100) };
  }

  // Check entities
  try {
    const entities = await park.getEntities();
    await waitForHttpQueue();
    result.entities = { ok: entities.length > 0, count: entities.length };
  } catch (e: any) {
    result.entities = { ok: false, count: 0, error: e.message?.substring(0, 100) };
  }

  // Check live data
  try {
    const liveData = await park.getLiveData();
    await waitForHttpQueue();
    result.liveData = { ok: true, count: liveData.length };
  } catch (e: any) {
    result.liveData = { ok: false, count: 0, error: e.message?.substring(0, 100) };
  }

  // Check schedules
  try {
    const schedules = await park.getSchedules();
    await waitForHttpQueue();
    result.schedules = { ok: true, count: schedules.length };
  } catch (e: any) {
    result.schedules = { ok: false, count: 0, error: e.message?.substring(0, 100) };
  }

  result.duration = Date.now() - start;
  return result;
}

function printResult(r: HealthResult): void {
  const icon = (ok: boolean) => ok ? 'OK' : 'FAIL';
  const pad = (s: string, n: number) => s.padEnd(n);

  console.log(`\n${pad(r.parkName, 35)} (${r.parkId})`);
  console.log(`  Destinations: ${icon(r.destinations.ok)} (${r.destinations.count})${r.destinations.error ? ` — ${r.destinations.error}` : ''}`);
  console.log(`  Entities:     ${icon(r.entities.ok)} (${r.entities.count})${r.entities.error ? ` — ${r.entities.error}` : ''}`);
  console.log(`  Live Data:    ${icon(r.liveData.ok)} (${r.liveData.count})${r.liveData.error ? ` — ${r.liveData.error}` : ''}`);
  console.log(`  Schedules:    ${icon(r.schedules.ok)} (${r.schedules.count})${r.schedules.error ? ` — ${r.schedules.error}` : ''}`);
  console.log(`  Duration:     ${(r.duration / 1000).toFixed(1)}s`);
}

function printSummary(results: HealthResult[]): void {
  console.log('\n' + '='.repeat(70));
  console.log('HEALTH CHECK SUMMARY');
  console.log('='.repeat(70));

  const healthy = results.filter(r => r.destinations.ok && r.entities.ok);
  const unhealthy = results.filter(r => !r.destinations.ok || !r.entities.ok);

  console.log(`\nParks checked:  ${results.length}`);
  console.log(`Healthy:        ${healthy.length}`);
  console.log(`Unhealthy:      ${unhealthy.length}`);

  if (unhealthy.length > 0) {
    console.log('\nUnhealthy parks:');
    for (const r of unhealthy) {
      const issues: string[] = [];
      if (!r.destinations.ok) issues.push(`destinations: ${r.destinations.error || 'failed'}`);
      if (!r.entities.ok) issues.push(`entities: ${r.entities.error || 'failed'}`);
      if (!r.liveData.ok) issues.push(`liveData: ${r.liveData.error || 'failed'}`);
      if (!r.schedules.ok) issues.push(`schedules: ${r.schedules.error || 'failed'}`);
      console.log(`  ${r.parkName}: ${issues.join(', ')}`);
    }
  }

  const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);
  console.log(`\nTotal duration: ${(totalDuration / 1000).toFixed(1)}s`);
  console.log('='.repeat(70));
}

async function main() {
  const args = process.argv.slice(2);
  const categoryIdx = args.indexOf('--category');
  const category = categoryIdx !== -1 ? args[categoryIdx + 1] : undefined;
  const parkIdArg = args.find(a => !a.startsWith('--') && a !== category);

  const results: HealthResult[] = [];

  try {
    if (parkIdArg) {
      // Single park
      const entry = await getDestinationById(parkIdArg);
      if (!entry) {
        console.error(`Park not found: ${parkIdArg}`);
        process.exit(1);
      }
      console.log(`Health check: ${entry.name}`);
      const park = new entry.DestinationClass();
      const result = await checkPark(entry.id, entry.name, park);
      printResult(result);
      results.push(result);
    } else if (category) {
      // Category
      const parks = await getDestinationsByCategory(category);
      console.log(`Health check: ${parks.length} parks in category "${category}"`);
      for (const entry of parks) {
        const park = new entry.DestinationClass();
        const result = await checkPark(entry.id, entry.name, park);
        printResult(result);
        results.push(result);
      }
    } else {
      // All parks
      const parks = await getAllDestinations();
      console.log(`Health check: ${parks.length} parks`);
      for (const entry of parks) {
        const park = new entry.DestinationClass();
        const result = await checkPark(entry.id, entry.name, park);
        printResult(result);
        results.push(result);
      }
    }

    printSummary(results);
  } finally {
    stopHttpQueue();
  }

  const allHealthy = results.every(r => r.destinations.ok && r.entities.ok);
  process.exit(allHealthy ? 0 : 1);
}

main();

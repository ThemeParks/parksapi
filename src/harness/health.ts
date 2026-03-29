/**
 * Park health check — validates each park's core API endpoints.
 * Catches API changes (404s, auth failures, format changes) proactively.
 *
 * Usage:
 *   npm run health                         # Quick check all parks (entities only)
 *   npm run health -- efteling             # Check specific park
 *   npm run health -- --full               # Full check (entities + live data + schedules)
 *   npm run health -- --category Disney    # Check all Disney parks
 */

import { getAllDestinations, getDestinationById, getDestinationsByCategory } from '../destinationRegistry.js';
import { Destination } from '../destination.js';
import { waitForHttpQueue, stopHttpQueue } from '../http.js';

type CheckResult = { ok: boolean; count: number; error?: string };

type HealthResult = {
  parkId: string;
  parkName: string;
  destinations: CheckResult;
  entities: CheckResult;
  liveData?: CheckResult;
  schedules?: CheckResult;
  duration: number;
};

async function checkPark(parkId: string, parkName: string, park: Destination, full: boolean): Promise<HealthResult> {
  const start = Date.now();
  const result: HealthResult = {
    parkId,
    parkName,
    destinations: { ok: false, count: 0 },
    entities: { ok: false, count: 0 },
    duration: 0,
  };

  // Always check destinations (fast — usually hardcoded)
  try {
    const dests = await park.getDestinations();
    await waitForHttpQueue();
    result.destinations = { ok: dests.length > 0, count: dests.length };
  } catch (e: any) {
    result.destinations = { ok: false, count: 0, error: e.message?.substring(0, 120) };
  }

  // Always check entities (validates main POI/facilities endpoint)
  try {
    const entities = await park.getEntities();
    await waitForHttpQueue();
    result.entities = { ok: entities.length > 0, count: entities.length };
  } catch (e: any) {
    result.entities = { ok: false, count: 0, error: e.message?.substring(0, 120) };
  }

  // Full mode: also check live data + schedules
  if (full) {
    try {
      const liveData = await park.getLiveData();
      await waitForHttpQueue();
      result.liveData = { ok: true, count: liveData.length };
    } catch (e: any) {
      result.liveData = { ok: false, count: 0, error: e.message?.substring(0, 120) };
    }

    try {
      const schedules = await park.getSchedules();
      await waitForHttpQueue();
      result.schedules = { ok: true, count: schedules.length };
    } catch (e: any) {
      result.schedules = { ok: false, count: 0, error: e.message?.substring(0, 120) };
    }
  }

  result.duration = Date.now() - start;
  return result;
}

function printCondensedResult(r: HealthResult): void {
  const ok = r.destinations.ok && r.entities.ok &&
    (!r.liveData || r.liveData.ok) && (!r.schedules || r.schedules.ok);
  const icon = ok ? 'OK  ' : 'FAIL';

  const parts = [`dest:${r.destinations.count}`, `ent:${r.entities.count}`];
  if (r.liveData) parts.push(`live:${r.liveData.count}`);
  if (r.schedules) parts.push(`sched:${r.schedules.count}`);
  parts.push(`${(r.duration / 1000).toFixed(1)}s`);

  const errors: string[] = [];
  if (!r.destinations.ok && r.destinations.error) errors.push(r.destinations.error);
  if (!r.entities.ok && r.entities.error) errors.push(r.entities.error);
  if (r.liveData && !r.liveData.ok && r.liveData.error) errors.push(r.liveData.error);
  if (r.schedules && !r.schedules.ok && r.schedules.error) errors.push(r.schedules.error);

  console.log(`  ${icon}  ${r.parkName.padEnd(35)} ${parts.join('  ')}${errors.length ? '\n        ' + errors[0] : ''}`);
}

function printSummary(results: HealthResult[]): void {
  const healthy = results.filter(r => r.destinations.ok && r.entities.ok);
  const unhealthy = results.filter(r => !r.destinations.ok || !r.entities.ok);
  const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);
  const totalEntities = results.reduce((sum, r) => sum + r.entities.count, 0);

  console.log(`\n${healthy.length}/${results.length} healthy  |  ${totalEntities} entities  |  ${(totalDuration / 1000).toFixed(0)}s total`);

  if (unhealthy.length > 0) {
    console.log(`\nUnhealthy: ${unhealthy.map(r => r.parkId).join(', ')}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const full = args.includes('--full');
  const categoryIdx = args.indexOf('--category');
  const category = categoryIdx !== -1 ? args[categoryIdx + 1] : undefined;
  const parkIdArg = args.find(a => !a.startsWith('--') && a !== category);

  const results: HealthResult[] = [];

  try {
    let entries: Array<{ id: string; name: string; DestinationClass: new () => Destination }>;

    if (parkIdArg) {
      const entry = await getDestinationById(parkIdArg);
      if (!entry) {
        console.error(`Park not found: ${parkIdArg}`);
        process.exit(1);
      }
      entries = [entry];
    } else if (category) {
      entries = await getDestinationsByCategory(category);
    } else {
      entries = await getAllDestinations();
    }

    console.log(`Health check: ${entries.length} park${entries.length !== 1 ? 's' : ''}${full ? ' (full)' : ''}\n`);

    for (const entry of entries) {
      const park = new entry.DestinationClass();
      const result = await checkPark(entry.id, entry.name, park, full);
      printCondensedResult(result);
      results.push(result);
    }

    printSummary(results);
  } finally {
    stopHttpQueue();
  }

  const allHealthy = results.every(r => r.destinations.ok && r.entities.ok);
  process.exit(allHealthy ? 0 : 1);
}

main();

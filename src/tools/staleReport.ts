/**
 * @module
 * Read-only staleness report: what the API still serves that the feed dropped.
 *
 * Closes nothing. Prints a table and writes a CSV so the diff can be read
 * before anything acts on it — at fleet scale this list is several hundred
 * rows, so it is reviewed, not trusted.
 *
 *   npm run stale                 # every registered destination
 *   npm run stale -- universalorlando disneylandparis
 */
import {writeFileSync} from 'node:fs';
import https from 'node:https';
import {getDestinationById, getAllDestinations} from '../destinationRegistry.js';
import {reconcileLiveRows, type ServedRow, type StaleRow} from './staleLiveRows.js';

const API = 'https://api.themeparks.wiki/v1';

function getJSON(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (err) { reject(err); }
      });
    }).on('error', reject);
  });
}

/**
 * Live rows the API serves for a destination, joined to entity metadata.
 *
 * Joined on the published `externalId`, which is the parksapi DESTINATION
 * entity id (`universalresort_orlando`), NOT the registry id
 * (`universalorlando`). The two differ for most destinations.
 */
async function fetchServedRows(destinationEntityIds: string[]): Promise<ServedRow[]> {
  const wanted = new Set(destinationEntityIds);
  const destinations = await getJSON(`${API}/destinations`);
  const remote = destinations.destinations?.find((d: any) => wanted.has(d.externalId));
  if (!remote) return [];

  const rows: ServedRow[] = [];
  for (const park of remote.parks ?? []) {
    const [live, children] = await Promise.all([
      getJSON(`${API}/entity/${park.id}/live`),
      getJSON(`${API}/entity/${park.id}/children`),
    ]);
    const meta = new Map<string, {externalId?: string; entityType?: string}>();
    meta.set(park.id, {externalId: park.externalId, entityType: 'PARK'});
    for (const child of children.children ?? []) {
      meta.set(child.id, {externalId: child.externalId, entityType: child.entityType});
    }
    for (const row of live.liveData ?? []) {
      rows.push({
        id: row.id,
        name: row.name,
        status: row.status,
        lastUpdated: row.lastUpdated,
        ...meta.get(row.id),
      });
    }
  }
  return rows;
}

async function main(): Promise<void> {
  const requested = process.argv.slice(2).filter(arg => !arg.startsWith('-'));
  const ids = requested.length
    ? requested
    : (await getAllDestinations()).map(entry => entry.id);

  const all: Array<StaleRow & {destination: string}> = [];
  const now = new Date();

  for (const id of ids) {
    let produced: string[] = [];
    let destinationEntityIds: string[] = [];
    try {
      const entry = await getDestinationById(id);
      if (!entry) { console.log(`${id.padEnd(28)} not registered`); continue; }
      const destination = new entry.DestinationClass();
      produced = (await destination.getLiveData()).map(row => row.id);
      destinationEntityIds = (await destination.getDestinations()).map(entity => entity.id);
    } catch (err) {
      // A destination that cannot build says nothing about staleness — its
      // absent rows are a broken build, not retired entities.
      console.log(`${id.padEnd(28)} SKIPPED — build failed: ${String(err).slice(0, 70)}`);
      continue;
    }

    const served = await fetchServedRows(destinationEntityIds).catch(() => [] as ServedRow[]);
    if (!served.length) { console.log(`${id.padEnd(28)} no published live rows`); continue; }

    const result = reconcileLiveRows(produced, served, now);
    const flag = result.degraded ? `  ⚠ ${result.degraded}` : '';
    console.log(
      `${id.padEnd(28)} produced ${String(result.produced).padStart(4)} | ` +
      `served ${String(result.servedLive).padStart(4)} | stale ${String(result.stale.length).padStart(4)}${flag}`,
    );
    if (result.degraded) continue; // untrustworthy: report the count, not the rows
    all.push(...result.stale.map(row => ({...row, destination: id})));
  }

  all.sort((a, b) => b.ageHours - a.ageHours);

  console.log(`\n${all.length} stale live rows across ${ids.length} destination(s)\n`);
  for (const row of all.slice(0, 25)) {
    console.log(
      `  ${String(Math.round(row.ageHours / 24)).padStart(5)}d  ${row.status.padEnd(9)} ` +
      `${row.destination.slice(0, 22).padEnd(22)} ${row.name.slice(0, 40)}`,
    );
  }
  if (all.length > 25) console.log(`  … and ${all.length - 25} more`);

  const csv = ['destination,externalId,guid,name,entityType,status,ageHours']
    .concat(all.map(r =>
      [r.destination, r.externalId, r.id, `"${r.name.replace(/"/g, '""')}"`, r.entityType, r.status, r.ageHours].join(',')))
    .join('\n');
  const path = `/tmp/stale-live-rows.csv`;
  writeFileSync(path, csv);
  console.log(`\nCSV: ${path}`);
}

await main();
process.exit(0);

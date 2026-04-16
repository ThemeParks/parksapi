/**
 * Entity ID Migration Tool
 *
 * Usage: npm run migrate -- <parkId>
 *
 * Generates old→new entity ID mappings for a park, then serves
 * a browser-based review UI for approving and committing changes
 * to the ThemeParks.wiki API.
 */

import {getAllDestinations} from '../../destinationRegistry.js';
import {stopHttpQueue} from '../../http.js';
import {generateMappings, getUnmatchedNewEntities} from './matcher.js';
import {startMigrationServer} from './server.js';
import type {WikiEntity, NewEntity} from './matcher.js';

const WIKI_API_URL = process.env.WIKI_API_URL || 'https://api.themeparks.wiki';
const WIKI_USERNAME = process.env.WIKI_USERNAME || '';
const WIKI_API_KEY = process.env.WIKI_API_KEY || '';
const PORT = parseInt(process.env.MIGRATE_PORT || '9900', 10);

async function main() {
  const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const flagArgs = process.argv.slice(2).filter(a => a.startsWith('--'));
  const parkId = args[0];
  const wikiSlugOverride = flagArgs
    .find(a => a.startsWith('--wiki-slug='))
    ?.split('=')[1];
  if (!parkId) {
    console.error('Usage: npm run migrate -- <parkId> [--wiki-slug=<wikiSlug>]');
    console.error('Example: npm run migrate -- walibiholland');
    process.exit(1);
  }

  console.log(`\nEntity ID Migration Tool`);
  console.log(`========================\n`);

  // ── Step 1: Generate new entities from TS park ─────────────

  console.log(`[1/3] Generating new entities from TS park "${parkId}"...`);

  const allDests = await getAllDestinations();
  const dest = allDests.find(d => d.id === parkId);
  if (!dest) {
    console.error(`Park "${parkId}" not found in registry.`);
    console.error('Available:', allDests.map(d => d.id).sort().join(', '));
    process.exit(1);
  }

  // Instantiate the park and get entities
  const instance = new dest.DestinationClass();
  const destinations = await instance.getDestinations();
  const entities = await instance.getEntities();

  const newEntities: NewEntity[] = entities.map((e: any) => ({
    newId: e.id,
    name: typeof e.name === 'string' ? e.name : (e.name?.en || e.name?.nl || Object.values(e.name || {})[0] || ''),
    entityType: e.entityType,
    latitude: e.location?.latitude,
    longitude: e.location?.longitude,
  }));

  console.log(`  Found ${newEntities.length} entities (${newEntities.filter(e => e.entityType === 'ATTRACTION').length} attractions, ${newEntities.filter(e => e.entityType === 'SHOW').length} shows, ${newEntities.filter(e => e.entityType === 'RESTAURANT').length} restaurants)`);

  // ── Step 2: Fetch current entities from wiki API ───────────

  console.log(`\n[2/3] Fetching current entities from ${WIKI_API_URL}...`);

  let wikiEntities: WikiEntity[] = [];

  try {
    // Find destination by slug
    const destsResp = await fetch(`${WIKI_API_URL}/v1/destinations`);
    if (!destsResp.ok) throw new Error(`Failed to fetch destinations: ${destsResp.status}`);
    const destsData = await destsResp.json() as any;

    const candidates = wikiSlugOverride
      ? [wikiSlugOverride]
      : [parkId, `${parkId}resort`, `${parkId}-resort`, `${parkId}destination`];
    let wikiDest: any = null;
    for (const candidate of candidates) {
      wikiDest = destsData.destinations?.find((d: any) => d.slug === candidate);
      if (wikiDest) {
        if (candidate !== parkId) {
          console.log(`  Resolved wiki slug "${candidate}" (parksapi id: "${parkId}")`);
        }
        break;
      }
    }
    if (!wikiDest) {
      console.warn(`  Warning: destination "${parkId}" not found in wiki API.`);
      console.warn(`  Tried slugs: ${candidates.join(', ')}`);
      console.warn(`  Available slugs: ${destsData.destinations?.map((d: any) => d.slug).filter(Boolean).sort().join(', ')}`);
      console.warn(`  Re-run with --wiki-slug=<slug> to override, or proceed with empty wiki entities.`);
    } else {
      console.log(`  Found wiki destination: ${wikiDest.name} (${wikiDest.id})`);

      // Fetch children
      const childResp = await fetch(`${WIKI_API_URL}/v1/entity/${wikiDest.id}/children`);
      if (!childResp.ok) throw new Error(`Failed to fetch children: ${childResp.status}`);
      const childData = await childResp.json() as any;

      wikiEntities = (childData.children || []).map((c: any) => ({
        wikiId: c.id,
        externalId: c.externalId || c._id,
        name: c.name,
        entityType: c.entityType,
        latitude: c.location?.latitude,
        longitude: c.location?.longitude,
      }));

      console.log(`  Found ${wikiEntities.length} wiki entities`);
    }
  } catch (err: any) {
    console.warn(`  Warning: Could not fetch wiki data: ${err.message}`);
    console.warn(`  Proceeding without wiki data — review-only mode.`);
  }

  // ── Step 3: Match and serve review UI ──────────────────────

  console.log(`\n[3/3] Generating mappings...`);

  const mappings = generateMappings(wikiEntities, newEntities);
  const unmatchedNew = getUnmatchedNewEntities(mappings, newEntities);

  const exact = mappings.filter(m => m.confidence === 'exact').length;
  const fuzzy = mappings.filter(m => m.confidence === 'fuzzy').length;
  const unmatched = mappings.filter(m => m.confidence === 'unmatched').length;
  console.log(`  ${exact} exact, ${fuzzy} fuzzy, ${unmatched} unmatched`);
  if (unmatchedNew.length > 0) {
    console.log(`  ${unmatchedNew.length} new entities not in wiki (will be created on next sync)`);
  }

  // Keep the process alive — Express listen() alone isn't enough if
  // stopHttpQueue() clears the HTTP interval timer before Express binds.
  // This interval is a no-op but prevents Node from exiting.
  const keepAlive = setInterval(() => {}, 60000);
  stopHttpQueue();

  // Resolve park name for display
  const parkName = destinations[0]?.name
    ? (typeof destinations[0].name === 'string' ? destinations[0].name : destinations[0].name.en || Object.values(destinations[0].name)[0])
    : parkId;

  // Filter to non-PARK/DESTINATION new entities for the dropdown
  const allNewForDropdown = newEntities.filter(
    n => n.entityType !== 'PARK' && n.entityType !== 'DESTINATION',
  );

  // Start the review server
  startMigrationServer({
    mappings,
    unmatchedNew,
    allNewEntities: allNewForDropdown,
    parkName: parkName as string,
    wikiApiUrl: WIKI_API_URL,
    wikiUsername: WIKI_USERNAME,
    wikiApiKey: WIKI_API_KEY,
    port: PORT,
  });
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

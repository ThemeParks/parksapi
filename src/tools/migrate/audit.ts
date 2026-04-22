/**
 * Audit destination externalIds
 *
 * For every park in the parksapi registry, fetch the destinations it emits
 * and check whether each one's externalId matches what's currently on the
 * wiki. Any mismatch means the new TS collector will 400 on init for that
 * park ("Resort <id> isn't available on remote API server").
 *
 * Optionally rename mismatches with --fix. Uses WIKI_TOKEN from env.
 *
 * Usage:
 *   npm run audit:externalids                 # read-only
 *   npm run audit:externalids -- --fix        # rename on wiki
 *   npm run audit:externalids -- --only=kennywood,plopsaland
 */
import {getAllDestinations} from '../../destinationRegistry.js';
import {stopHttpQueue} from '../../http.js';

type WikiDest = {
  id: string;
  name: string;
  slug: string;
  externalId: string;
};

type Mismatch = {
  parksApiId: string;
  emittedExternalId: string;
  wikiUuid: string | null;
  wikiCurrentExternalId: string | null;
  wikiName: string | null;
};

const WIKI_API_URL = process.env.WIKI_API_URL || 'https://api.themeparks.wiki';
const WIKI_TOKEN = process.env.WIKI_TOKEN || '';

async function fetchWikiDestinations(): Promise<WikiDest[]> {
  const r = await fetch(`${WIKI_API_URL}/v1/destinations`);
  if (!r.ok) throw new Error(`GET /v1/destinations: ${r.status}`);
  const data = (await r.json()) as {destinations: WikiDest[]};
  return data.destinations;
}

async function renameExternalId(wikiUuid: string, newExternalId: string): Promise<void> {
  if (!WIKI_TOKEN) throw new Error('WIKI_TOKEN must be set to rename externalIds');
  const r = await fetch(`${WIKI_API_URL}/v1/entity/${wikiUuid}/_id`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${WIKI_TOKEN}`,
    },
    body: JSON.stringify({_id: newExternalId}),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`PUT _id → ${r.status}: ${body.slice(0, 200)}`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const fix = args.includes('--fix');
  const only = args.find(a => a.startsWith('--only='))?.split('=')[1]?.split(',').map(s => s.trim()).filter(Boolean);

  console.log(`Auditing destination externalIds${only ? ` (filtered: ${only.join(', ')})` : ''}...\n`);

  const wikiDests = await fetchWikiDestinations();
  const wikiByExtId = new Map<string, WikiDest>();
  const wikiBySlug = new Map<string, WikiDest>();
  for (const d of wikiDests) {
    wikiByExtId.set(d.externalId, d);
    wikiBySlug.set(d.slug, d);
  }

  const registry = await getAllDestinations();
  const parksToCheck = only ? registry.filter(r => only.includes(r.id)) : registry;

  const mismatches: Mismatch[] = [];
  let checked = 0;
  let emittedCount = 0;

  for (const entry of parksToCheck) {
    checked++;
    const inst = new entry.DestinationClass();
    let dests: Array<{id: string; name: string}>;
    try {
      dests = await (inst as any).getDestinations();
    } catch (e: any) {
      console.log(`  [skip] ${entry.id}: getDestinations threw (${e.message.slice(0, 60)})`);
      continue;
    }

    for (const d of dests) {
      emittedCount++;
      const onWikiByExt = wikiByExtId.get(d.id);
      if (onWikiByExt) continue;   // match — all good

      // Try to locate the same destination on the wiki under a different
      // externalId. We key on slug first (stable historical identifier),
      // then exact name match. If nothing resolves, this is a new park not
      // yet on the wiki — not a "rename needed" case.
      const name = typeof d.name === 'string' ? d.name : JSON.stringify(d.name);
      const normalisedName = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '');
      let match: WikiDest | undefined = wikiBySlug.get(d.id) ?? wikiBySlug.get(normalisedName);
      if (!match) {
        match = wikiDests.find(w => w.name.toLowerCase() === String(name).toLowerCase());
      }
      if (!match) continue;  // new destination, not a rename case — silently skipped

      mismatches.push({
        parksApiId: entry.id,
        emittedExternalId: d.id,
        wikiUuid: match.id,
        wikiCurrentExternalId: match.externalId,
        wikiName: match.name,
      });
    }
  }

  console.log(`Checked ${checked} parksapi destinations emitting ${emittedCount} wiki destinations.`);
  console.log(`Wiki knows ${wikiDests.length} destinations in total.\n`);

  if (mismatches.length === 0) {
    console.log('✓ All emitted externalIds match wiki. Nothing to fix.');
    return;
  }

  console.log(`✗ ${mismatches.length} mismatch(es) — will 400 on collector init until renamed:\n`);
  for (const m of mismatches) {
    console.log(`  ${m.parksApiId}:`);
    console.log(`    emits    : ${m.emittedExternalId}`);
    console.log(`    wiki has : ${m.wikiCurrentExternalId}  (uuid ${m.wikiUuid})`);
    console.log(`    wiki name: ${m.wikiName}`);
    console.log('');
  }

  if (!fix) {
    console.log(`Re-run with --fix to rename the wiki externalIds to match parksapi.`);
    process.exitCode = 1;
    return;
  }

  // Apply fixes
  console.log('Applying renames...');
  for (const m of mismatches) {
    if (!m.wikiUuid) {
      console.log(`  [skip] ${m.parksApiId}: no wiki entry located, can't rename`);
      continue;
    }
    try {
      await renameExternalId(m.wikiUuid, m.emittedExternalId);
      console.log(`  ✓ ${m.parksApiId}: ${m.wikiCurrentExternalId} → ${m.emittedExternalId}`);
    } catch (e: any) {
      console.log(`  ✗ ${m.parksApiId}: ${e.message}`);
    }
  }
}

main()
  .catch(err => {
    console.error('Fatal:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    stopHttpQueue();
  });

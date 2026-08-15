/**
 * README destination table generator.
 *
 * Usage:
 *   npm run readme            Rewrite the generated blocks in README.md
 *   npm run readme -- --check Exit 1 if they are stale (used by the gate test)
 *
 * The table is derived data that was living in prose, so it drifted: it stood
 * at 74 rows against 80 registered destinations, missing 15 and listing 9 that
 * are not registry entries at all. Generating it from the registry is the only
 * way it stays true, since the alternative is remembering to hand-edit a table
 * every time a destination lands.
 *
 * Two blocks are owned here, both marker-delimited so the surrounding prose
 * stays hand-written:
 *
 *   <!-- destinations:count -->80<!-- /destinations:count -->
 *   <!-- destinations:table --> … <!-- /destinations:table -->
 */

import {readFileSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {getAllDestinations} from '../../destinationRegistry.js';
import {stopHttpQueue} from '../../http.js';

const README = resolve(dirname(fileURLToPath(import.meta.url)), '../../../README.md');

const COUNT_OPEN = '<!-- destinations:count -->';
const COUNT_CLOSE = '<!-- /destinations:count -->';
const TABLE_OPEN = '<!-- destinations:table -->';
const TABLE_CLOSE = '<!-- /destinations:table -->';

/**
 * Sub-parks are not registry entries: Cedar Point, Knott's Berry Farm and the
 * rest of that estate are served through a single parent controller, so they
 * have no id of their own to list. They used to sit in the table unmarked,
 * which is what made it look longer than the registry while still being
 * short of it.
 */
const SUBPARK_NOTE =
  'Some parks are served through a parent destination rather than an id of ' +
  'their own — Cedar Point and Knott\'s Berry Farm arrive under the Six Flags ' +
  'controller, for instance — so they are entities in the output rather than ' +
  'rows here.';

export type ReadmeBlocks = {count: string; table: string};

/** The two generated blocks, from the live registry. */
export async function buildBlocks(): Promise<ReadmeBlocks> {
  const destinations = await getAllDestinations();
  const rows = [...destinations]
    .sort((a, b) => a.name.localeCompare(b.name, 'en'))
    .map((d) => `| ${d.name} | \`${d.id}\` |`);

  const table = [
    '',
    `${destinations.length} destinations across Disney, Universal, Cedar Fair, Six Flags, Merlin, and many more.`,
    '',
    SUBPARK_NOTE,
    '',
    'Run `npm run dev -- --list` for the same list with categories.',
    '',
    '<details>',
    '<summary>All destinations</summary>',
    '',
    '| Destination | ID |',
    '|---|---|',
    ...rows,
    '',
    '</details>',
    '',
  ].join('\n');

  return {count: String(destinations.length), table};
}

/** Replace the content between a marker pair. Throws if the pair is missing. */
export function replaceBlock(
  source: string,
  open: string,
  close: string,
  content: string,
): string {
  const start = source.indexOf(open);
  const end = source.indexOf(close);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `README.md is missing the ${open}…${close} markers. ` +
      `They delimit generated content and must not be removed.`,
    );
  }
  return source.slice(0, start + open.length) + content + source.slice(end);
}

/** README.md with both generated blocks brought up to date. */
export async function renderReadme(source: string): Promise<string> {
  const {count, table} = await buildBlocks();
  return replaceBlock(
    replaceBlock(source, COUNT_OPEN, COUNT_CLOSE, count),
    TABLE_OPEN,
    TABLE_CLOSE,
    table,
  );
}

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  const current = readFileSync(README, 'utf8');
  const rendered = await renderReadme(current);

  if (current === rendered) {
    console.log(check ? 'README destination list is up to date' : 'README already up to date');
    return;
  }

  if (check) {
    console.error('README destination list is stale. Run: npm run readme');
    process.exitCode = 1;
    return;
  }

  writeFileSync(README, rendered);
  console.log('README destination list rewritten');
}

// Only run when invoked directly, so the gate test can import the helpers.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
  // Loading the registry imports every park module, which starts the HTTP
  // queue's interval. Nothing here makes a request, but the timer keeps the
  // event loop alive and the command would never return.
  stopHttpQueue();
}

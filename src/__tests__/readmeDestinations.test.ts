import {describe, it, expect, afterAll} from 'vitest';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {renderReadme, buildBlocks, replaceBlock} from '../tools/readme/destinations.js';
import {getAllDestinations} from '../destinationRegistry.js';
import {stopHttpQueue} from '../http.js';

/**
 * The gate that stops the table drifting again.
 *
 * It stood at 74 rows against 80 registered destinations — missing 15, and
 * listing 9 sub-parks that are not registry entries — while the line above it
 * claimed to be the output of `npm run dev -- --list`. Generating it is only
 * half a fix; without this, the next destination lands and the file is stale
 * again with nothing to say so.
 */
const README = resolve(dirname(fileURLToPath(import.meta.url)), '../../README.md');

// Loading the registry imports every park module, which starts the HTTP
// queue's interval. Nothing here makes a request.
afterAll(() => stopHttpQueue());

describe('README destination list', () => {
  it('is up to date with the registry', async () => {
    const current = readFileSync(README, 'utf8');

    expect(await renderReadme(current)).toBe(current);
  });

  it('lists every registered destination exactly once', async () => {
    const current = readFileSync(README, 'utf8');
    const destinations = await getAllDestinations();

    for (const d of destinations) {
      const rows = current.split('\n').filter((l) => l.includes(`| \`${d.id}\` |`));
      expect(rows, `${d.id} (${d.name})`).toHaveLength(1);
    }
  });

  it('lists nothing that is not registered', async () => {
    const current = readFileSync(README, 'utf8');
    const registered = new Set((await getAllDestinations()).map((d) => d.id));

    const listed = [...current.matchAll(/^\| .+ \| `([a-z0-9]+)` \|$/gm)].map((m) => m[1]);

    expect(listed.length).toBeGreaterThan(0);
    expect(listed.filter((id) => !registered.has(id))).toEqual([]);
  });

  it('states the registry size in the opening paragraph', async () => {
    const current = readFileSync(README, 'utf8');
    const {count} = await buildBlocks();

    expect(current).toContain(
      `<!-- destinations:count -->${count}<!-- /destinations:count -->`,
    );
  });

  it('fails loudly if the markers are removed rather than writing a mangled file', () => {
    expect(() => replaceBlock('no markers here', '<!-- a -->', '<!-- /a -->', 'x'))
      .toThrow(/missing the <!-- a -->/);
  });
});

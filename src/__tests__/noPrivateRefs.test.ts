import {describe, it, expect} from 'vitest';
import {readFileSync, readdirSync, statSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, resolve, relative} from 'node:path';

/**
 * This repository is public. Issues, pull requests, commits and code comments
 * are all world-readable, and the comments here are written while working from
 * a private tracker whose numbering means nothing to anyone outside.
 *
 * Four comments had already picked up a private card number, in the form
 * "Regression for <tracker>#86". Harmless-looking, and useless to a reader
 * who cannot open it, but it advertises that the tracker exists and lets an
 * outsider correlate our internal numbering with dated public commits.
 *
 * The other half is worse and is what this gate mainly exists for: a session
 * trailer. The tooling offers to append a `Claude-Session:` line pointing at a
 * transcript URL, and a transcript is not something to hand to a park's legal
 * team.
 *
 * Kept narrow deliberately, so it stays switched on: it reads `src/` and the
 * README, which is where prose that ships publicly actually lives. It cannot
 * see commit messages or PR bodies, which are the other half of the exposure
 * and have to stay a matter of discipline.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SELF = resolve(ROOT, 'src/__tests__/noPrivateRefs.test.ts');

const FORBIDDEN: Array<{name: string; pattern: RegExp}> = [
  // A bare card number against the private tracker, e.g. "programme#86".
  {name: 'private tracker card reference', pattern: /\bprogramme\s*#\s*\d+/i},
  {name: 'private tracker repository', pattern: /ThemeParks\/programme/i},
  // GitHub Projects node ids: project, item, single-select field.
  {name: 'project/field id', pattern: /\bPVT(?:I|SSF)?_[A-Za-z0-9]/},
  // Session transcript links, in either the trailer or bare URL form.
  {name: 'session transcript link', pattern: /claude\.ai\/code\/session_/i},
  {name: 'session trailer', pattern: /^\s*Claude-Session\s*:/im},
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = resolve(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules' || name === 'dist' || name === 'fixtures') continue;
      walk(full, out);
    } else if (/\.(ts|js|json|md)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

describe('no private references leak into the public repository', () => {
  const files = [...walk(resolve(ROOT, 'src')), resolve(ROOT, 'README.md')]
    .filter((f) => f !== SELF);

  it('has files to check (the walk itself must not silently find nothing)', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  for (const {name, pattern} of FORBIDDEN) {
    it(`contains no ${name}`, () => {
      const hits: string[] = [];
      for (const file of files) {
        const text = readFileSync(file, 'utf8');
        if (!pattern.test(text)) continue;
        for (const [i, line] of text.split('\n').entries()) {
          // Test each line separately so the message names the exact site.
          if (new RegExp(pattern.source, pattern.flags.replace('m', '')).test(line)) {
            hits.push(`${relative(ROOT, file)}:${i + 1}`);
          }
        }
      }
      expect(hits, `remove the ${name} at:\n  ${hits.join('\n  ')}`).toEqual([]);
    });
  }
});

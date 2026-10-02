import {describe, it, expect} from 'vitest';
import {readFileSync, readdirSync, statSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join, relative, resolve} from 'node:path';

/**
 * `includeRaw` is applied in one place: the public getters strip `raw` when
 * it is off. Everything that builds data attaches its pieces unconditionally.
 *
 * A builder that branched on the flag would make its output depend on the
 * setting at the time it ran. Inside a `@cache` method that result outlives
 * the call, so a value cached with the flag off would serve a consumer who has
 * since turned it on, without its pieces, until the entry expired. With one
 * reader the cache holds the same thing under either setting and the flag can
 * be flipped at any time.
 */
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sourceFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

describe('includeRaw is read only by the public getters', () => {
  it('appears nowhere in src outside destination.ts', () => {
    const offenders = sourceFiles(SRC)
      .filter((path) => relative(SRC, path) !== 'destination.ts')
      .filter((path) => /\bincludeRaw\b/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(SRC, path));
    expect(offenders).toEqual([]);
  });

  it('is read in destination.ts only to strip raw', () => {
    const lines = readFileSync(join(SRC, 'destination.ts'), 'utf8')
      .split('\n')
      .filter((line) => /this\.includeRaw\b/.test(line));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line.trim()).toMatch(/^if \(!this\.includeRaw\)/);
  });
});

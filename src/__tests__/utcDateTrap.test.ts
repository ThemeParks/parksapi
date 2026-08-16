import {describe, it, expect} from 'vitest';
import {readFileSync, readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, resolve, relative} from 'node:path';

/**
 * The gate that stops the UTC-day trap being written a third time.
 *
 * Deriving a park's calendar day from `toISOString()` gives the UTC day, which
 * is not the park's day for several hours of every evening (4-7h behind for the
 * US parks, and the other way round for Asia-Pacific). Anything keyed on it
 * silently asks for the wrong date.
 *
 * It has been written twice already, independently:
 *
 *   enchantedparks.ts — "off by ±1 day across the local-midnight boundary,
 *   which could drop a day from the query range (e.g. at 11pm UTC for an
 *   America/Chicago park, the local date is already the next day but UTC is
 *   still on the current day)"
 *
 *   seaworld.ts (#314) — searchDate on every availability call, so from 20:00
 *   Eastern the API was asked for tomorrow while the park was still open, and
 *   every show published the next day's showtimes right through the evening
 *   event window.
 *
 * Both fixes were the same one line: `formatDate(date, timezone)`, which has
 * been in src/datetime.ts the whole time. The trap is that the broken idiom is
 * shorter to type and looks right.
 *
 * Deliberate UTC arithmetic on a date that is ALREADY a calendar day is fine
 * and common (anchor at T00:00:00Z or T12:00:00Z, add days, read it back).
 * Those sites opt out with an `utc-date-ok:` marker giving the reason, which
 * keeps the check narrow enough to stay switched on.
 */

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** `x.toISOString()` immediately sliced down to a YYYY-MM-DD. */
const DATE_SLICE = /\.toISOString\(\)\s*\.\s*(?:slice|substring)\(\s*0\s*,\s*10\s*\)|\.toISOString\(\)\s*\.\s*split\(\s*['"`]T['"`]\s*\)\s*\[\s*0\s*\]/;

const OPT_OUT = 'utc-date-ok';

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, {withFileTypes: true})) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      sourceFiles(full, acc);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      acc.push(full);
    }
  }
  return acc;
}

describe('UTC-day trap', () => {
  it('never derives a calendar day from toISOString() without an explicit reason', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(SRC)) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (!DATE_SLICE.test(line)) return;
        // The marker may sit on the offending line or in the comment block
        // immediately above it, so a reason can run to a few lines.
        const context = [lines[i - 3], lines[i - 2], lines[i - 1], line]
          .filter((l) => l !== undefined)
          .join('\n');
        if (context.includes(OPT_OUT)) return;
        offenders.push(`${relative(SRC, file)}:${i + 1}\n      ${line.trim()}`);
      });
    }

    expect(
      offenders,
      offenders.length === 0 ? '' :
        `\n\nA calendar day is being derived from toISOString(), which yields the UTC ` +
        `day, not the park's.\n\n` +
        offenders.map((o) => `  ${o}`).join('\n\n') +
        `\n\n  To fix: use formatDate(date, this.timezone) from src/datetime.ts.\n` +
        `  If this really is deliberate UTC arithmetic on an already-anchored\n` +
        `  calendar date, add a "${OPT_OUT}: <reason>" comment on or above the line.\n`,
    ).toEqual([]);
  });

  it('still recognises the offending shapes', () => {
    // Guards the regex itself: a check that cannot fail is worse than no check.
    for (const shape of [
      `const d = new Date().toISOString().slice(0, 10);`,
      `return today.toISOString().slice(0,10);`,
      `const s = now.toISOString().substring(0, 10);`,
      `const s = now.toISOString().split('T')[0];`,
    ]) {
      expect(DATE_SLICE.test(shape), shape).toBe(true);
    }

    for (const shape of [
      `const iso = d.toISOString();`,
      `const t = d.toISOString().slice(11, 16);`,
      `return formatDate(new Date(), this.timezone);`,
    ]) {
      expect(DATE_SLICE.test(shape), shape).toBe(false);
    }
  });
});

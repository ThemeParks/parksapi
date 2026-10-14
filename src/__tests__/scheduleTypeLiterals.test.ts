import {describe, it, expect} from 'vitest';
import {readFileSync, readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, resolve, relative, join} from 'node:path';
import {ScheduleTypeEnum} from '@themeparks/typelib';
import {scanScheduleTypes} from './helpers/scheduleTypeScan.js';

/**
 * No park may build a schedule entry with a type the schedule definition lacks.
 *
 * `getSchedules()` drops such an entry at run time (see
 * scheduleTypeGuard.test.ts), which keeps it from being mis-read downstream but
 * also means that park's days vanish. This is the other half: it fails the
 * build while the mistake is still a line in a diff. One park published every
 * open day as `PARK_OPEN` for months because its entries were assembled as
 * untyped objects and cast, so nothing ever compared the string with the
 * definition.
 *
 * It reads the park sources from disk, so `vitest --changed` never selects it;
 * it is listed with the other structural gates in .githooks/pre-commit.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PARKS = resolve(ROOT, 'src/parks');
const ALLOWED = new Set<string>(Object.values(ScheduleTypeEnum));

function parkSources(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, {withFileTypes: true})) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== '__tests__') out.push(...parkSources(p));
    } else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('.d.ts')) {
      out.push(p);
    }
  }
  return out.sort();
}

const sources = parkSources(PARKS).map(file => ({
  file: relative(ROOT, file),
  text: readFileSync(file, 'utf8'),
}));
const findings = sources.flatMap(s => scanScheduleTypes(s.file, s.text));

describe('schedule entry types across src/parks', () => {
  it('every type a park can publish is in the schedule definition', () => {
    const bad = findings
      .flatMap(f => f.values.filter(v => !ALLOWED.has(v)).map(v => `${f.file}:${f.line}  ${JSON.stringify(v)}  (${f.text})`));

    expect(bad, `types the schedule definition lacks (${[...ALLOWED].join(', ')}):\n${bad.join('\n')}`).toEqual([]);
  });

  it('every type expression can be read from the source', () => {
    const unread = findings
      .filter(f => f.unresolved.length || !f.values.length)
      .map(f => `${f.file}:${f.line}  ${f.text}  -> ${f.unresolved.join(', ') || 'no literal found'}`);

    expect(
      unread,
      'build the entry type from string literals (a literal, a ternary of literals, or a variable assigned them) ' +
      `so it can be checked:\n${unread.join('\n')}`,
    ).toEqual([]);
  });

  it('every park that builds schedules has entries the scan can see', () => {
    // A park assembling entries some other way (Object.assign, a class, a
    // spread of a shared base) would be invisible to the checks above.
    const definesBuild = /(?:protected|public)\s+(?:async\s+)?buildSchedules\s*\(/;
    const withFindings = new Set(findings.map(f => f.file));
    const blind = sources
      .filter(s => definesBuild.test(s.text) && !withFindings.has(s.file))
      .map(s => s.file);

    expect(blind, `these implement buildSchedules() but no entry literal was found:\n${blind.join('\n')}`).toEqual([]);
  });

  it('the scan is looking at the real tree', () => {
    // Not a count to maintain: a floor that proves the walk found the parks and
    // the resolver reached the types, so the checks above are not vacuous.
    expect(sources.length).toBeGreaterThan(40);
    expect(findings.length).toBeGreaterThan(40);
    const seen = new Set(findings.flatMap(f => f.values));
    for (const t of ['OPERATING', 'INFO', 'EXTRA_HOURS', 'TICKETED_EVENT']) expect(seen).toContain(t);
  });
});

describe('the scan itself', () => {
  const scan = (body: string) => scanScheduleTypes('probe.ts', body);

  it('flags a literal the definition lacks', () => {
    const [f] = scan(`const e = {date: d, type: 'PARK_OPEN', openingTime: a, closingTime: b};`);
    expect(f.values).toEqual(['PARK_OPEN']);
    expect(f.values.filter(v => !ALLOWED.has(v))).toEqual(['PARK_OPEN']);
  });

  it('reads through as, parentheses and satisfies', () => {
    const found = scan(`
      const a = {type: 'OPERATING' as const, openingTime: 1, closingTime: 2};
      const b = {type: ('INFO'), openingTime: 1, closingTime: 2};
      const c = {type: ('EXTRA_HOURS' satisfies string), openingTime: 1, closingTime: 2};
    `);
    expect(found.map(f => f.values)).toEqual([['OPERATING'], ['INFO'], ['EXTRA_HOURS']]);
  });

  it('reads both branches of a ternary and both sides of ||', () => {
    const found = scan(`
      const a = {type: x ? 'OPERATING' : 'BOGUS', openingTime: 1, closingTime: 2};
      const b = {type: y || 'INFO', openingTime: 1, closingTime: 2};
    `);
    expect(found[0].values).toEqual(['BOGUS', 'OPERATING']);
    expect(found[1].unresolved).toEqual(['y']);
    expect(found[1].values).toEqual(['INFO']);
  });

  it('follows a variable through its declaration and its reassignments', () => {
    const [f] = scan(`
      function build(s: string) {
        let type: string = 'OPERATING';
        if (s === 'x') type = 'EXTRA_HOURS';
        else if (s === 'y') type = 'NOT_A_TYPE';
        return {date: 'd', openingTime: 1, closingTime: 2, type};
      }
    `);
    expect(f.values).toEqual(['EXTRA_HOURS', 'NOT_A_TYPE', 'OPERATING']);
    expect(f.unresolved).toEqual([]);
  });

  it('reads a parameter through the string literal types it is annotated with', () => {
    const [f] = scan(`
      const entry = (kind: 'OPERATING' | 'NOT_A_TYPE') => ({date: 'd', openingTime: 1, closingTime: 2, type: kind});
    `);
    expect(f.values).toEqual(['NOT_A_TYPE', 'OPERATING']);
    expect(f.unresolved).toEqual([]);
  });

  it('does not accept a parameter typed as plain string', () => {
    const found = scan(`
      const a = (kind: string) => ({date: 'd', openingTime: 1, closingTime: 2, type: kind});
      const b = (kind) => ({date: 'd', openingTime: 1, closingTime: 2, type: kind});
    `);
    expect(found[0].unresolved).toEqual(['kind: string']);
    expect(found[1].unresolved).toEqual(['kind (parameter with no type)']);
  });

  it('does not mistake another function\'s variable of the same name for this one', () => {
    const [f] = scan(`
      function other() { let type = 'ATTRACTION'; return type; }
      function build() {
        const type = 'INFO';
        return {date: 'd', openingTime: 1, closingTime: 2, type};
      }
    `);
    expect(f.values).toEqual(['INFO']);
  });

  it('reads x.type through the file\'s other entries', () => {
    const found = scan(`
      const kind = 'TICKETED_EVENT';
      const a = {type: kind, openingTime: 1, closingTime: 2};
      const b = {type: entry.type, openingTime: 1, closingTime: 2};
    `);
    expect(found[1].values).toEqual(['TICKETED_EVENT']);
  });

  it('refuses to guess at what it cannot read', () => {
    const found = scan(`
      const a = {type: lookup(day), openingTime: 1, closingTime: 2};
      const b = {type: param, openingTime: 1, closingTime: 2};
      const c = {type: entry.type, openingTime: 1, closingTime: 2};
    `);
    expect(found.map(f => f.unresolved.length > 0)).toEqual([true, true, true]);
  });

  it('ignores objects that are not schedule entries', () => {
    expect(scan(`
      const q = {type: 'STANDBY', waitTime: 5};
      const h = {openingTime: 1, closingTime: 2};
      const e = {type: 'BOGUS', openingTime: 1};
    `)).toEqual([]);
  });
});

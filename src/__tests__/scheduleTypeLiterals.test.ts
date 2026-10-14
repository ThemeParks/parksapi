import {describe, it, expect, beforeAll} from 'vitest';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, resolve, relative, sep} from 'node:path';
import type ts from 'typescript';
import {ScheduleTypeEnum} from '@themeparks/typelib';
import {
  buildFileNames,
  createProgram,
  scanPublishedSchedules,
  scanScheduleTypes,
  scanSourceFile,
  scanTypeAssignments,
  type ScheduleTypeFinding,
} from './helpers/scheduleTypeScan.js';

/**
 * What a park may put in a schedule entry's `type`, checked while it is still a
 * line in a diff.
 *
 * `getSchedules()` only warns about a type outside the schedule definition and
 * passes the entry on (see scheduleTypeGuard.test.ts), so the prevention is
 * here and in the compiler. One park built every open day as `PARK_OPEN` because
 * its entries sat in untyped arrays and were cast on the way out, so nothing
 * ever compared the string with the definition.
 *
 * Three scans, each described in helpers/scheduleTypeScan.ts:
 *
 *  - every schedule entry literal in src/parks has a `type` that reads as
 *    members of the definition;
 *  - every `{id, schedule}` a park builds has entries whose `type` the compiler
 *    types as a union of those members, not `string` and not `any`, which is
 *    what makes the compiler enforce the definition wherever the array is
 *    filled in;
 *  - nothing assigns a property called `type` after the fact with a value
 *    outside the definition.
 *
 * What they do NOT see: an entry built where none of the above applies, and a
 * value that is wider at run time than its declared type through a cast
 * (`x as ScheduleType`). The fix for a hole is a narrower type or no cast.
 *
 * It reads the park sources from disk, so `vitest --changed` never selects it;
 * it is listed with the other structural gates in .githooks/pre-commit.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PARKS = resolve(ROOT, 'src/parks') + sep;
const ALLOWED = new Set<string>(Object.values(ScheduleTypeEnum));
const FIVE = [...ALLOWED].sort();

/** Probe modules, compiled in the same program as the parks so the checker sees them alike. */
const PROBE_DIR = resolve(ROOT, 'src/parks/__scanprobe__');
const IMPORTS = `import type {EntitySchedule, ScheduleEntry} from '@themeparks/typelib';\nimport {ScheduleTypeEnum} from '@themeparks/typelib';\n`;
const probeSources: Record<string, string> = {
  typedOk: `${IMPORTS}
    export function f(): EntitySchedule[] {
      const entries: ScheduleEntry[] = [];
      entries.push({date: 'd', type: 'OPERATING', openingTime: 'a', closingTime: 'b'});
      return [{id: 'p', schedule: entries}];
    }`,
  emptyOk: `${IMPORTS}
    export const f = (): EntitySchedule[] => [{id: 'p', schedule: []}];`,
  anyArray: `${IMPORTS}
    export function f() {
      const entries: any[] = [];
      return [{id: 'p', schedule: entries}];
    }`,
  stringArray: `${IMPORTS}
    export function f() {
      const entries: Array<{date: string; type: string; openingTime: string; closingTime: string}> = [];
      return [{id: 'p', schedule: entries}];
    }`,
  castOver: `${IMPORTS}
    export function f() {
      const entries: Array<{date: string; type: string; openingTime: string; closingTime: string}> = [];
      return [{id: 'p', schedule: entries as EntitySchedule['schedule']} as EntitySchedule];
    }`,
  spreadOfAny: `${IMPORTS}
    export function f(rows: any[]) {
      return [{id: 'p', schedule: rows.map((e: any) => ({...e, type: 'PARK_OPEN'}))}];
    }`,
  spreadOfTyped: `${IMPORTS}
    export function f(rows: ScheduleEntry[]) {
      return [{id: 'p', schedule: rows.map(e => ({...e, type: 'PARK_OPEN'}))}];
    }`,
  rowTypeOk: `${IMPORTS}
    export const f = (row: ScheduleEntry) => ({date: 'd', type: row.type, openingTime: 'a', closingTime: 'b'});`,
  rowTypeString: `${IMPORTS}
    export const f = (row: {type: string}) => ({date: 'd', type: row.type, openingTime: 'a', closingTime: 'b'});`,
  destructured: `${IMPORTS}
    const type = 'OPERATING';
    export function f(row: {type: string}) {
      const {type} = row;
      return {date: 'd', type, openingTime: 'a', closingTime: 'b'};
    }`,
  assignedLate: `${IMPORTS}
    export function f(list: ScheduleEntry[]) {
      list.forEach((e: any) => { e.type = 'PARK_OPEN'; });
      list.forEach((e: any) => { e['type'] = 'PARK_OPEN'; });
      list.forEach((e: any) => { e.type = 'INFO'; });
      list.forEach((e: any) => { e.type = ScheduleTypeEnum.INFO; });
      list.forEach((e: any, kind?: string) => { e.type ||= kind; });
      // schedule-type-ok: a probe of the opt-out
      list.forEach((e: any) => { e.type = 'ATTRACTION'; });
    }`,
};

let program: ts.Program;
let checker: ts.TypeChecker;
let repoFiles: Set<string>;

beforeAll(() => {
  repoFiles = new Set(buildFileNames(ROOT));
  const virtualFiles: Record<string, string> = {};
  for (const [name, text] of Object.entries(probeSources)) virtualFiles[resolve(PROBE_DIR, `${name}.ts`)] = text;
  program = createProgram(ROOT, [...repoFiles], virtualFiles);
  checker = program.getTypeChecker();
}, 60_000);

const probe = (name: string) => program.getSourceFile(resolve(PROBE_DIR, `${name}.ts`))!;
const rel = (sf: ts.SourceFile) => relative(ROOT, sf.fileName);
const parkSources = () =>
  program.getSourceFiles().filter(sf => repoFiles.has(sf.fileName) && sf.fileName.startsWith(PARKS) && !sf.fileName.includes(`${sep}__tests__${sep}`));

const unreadable = (f: ScheduleTypeFinding) => f.unresolved.length > 0;
const outsideDefinition = (f: ScheduleTypeFinding) => f.values.filter(v => !ALLOWED.has(v));
const where = (f: ScheduleTypeFinding) => `${f.file}:${f.line}  ${f.text}`;

describe('schedule entry types across src/parks', () => {
  it('every entry literal builds a type from members of the schedule definition', () => {
    const found = parkSources().flatMap(sf => scanSourceFile(rel(sf), sf, checker));
    const bad = found.flatMap(f => outsideDefinition(f).map(v => `${where(f)}  -> ${JSON.stringify(v)}`));
    const unread = found.filter(f => unreadable(f) || !f.values.length).map(f => `${where(f)}  -> ${f.unresolved.join(', ') || 'no literal found'}`);

    expect(bad, `types the schedule definition lacks (${FIVE.join(', ')}):\n${bad.join('\n')}`).toEqual([]);
    expect(
      unread,
      `build the entry type from string literals, ScheduleTypeEnum members, or something typed as them:\n${unread.join('\n')}`,
    ).toEqual([]);
  });

  it('every {id, schedule} a park builds is typed as the definition, not string or any', () => {
    const found = parkSources().flatMap(sf => scanPublishedSchedules(rel(sf), sf, checker));
    const bad = found.filter(f => unreadable(f) || outsideDefinition(f).length)
      .map(f => `${where(f)}  -> ${[...f.unresolved, ...outsideDefinition(f)].join(', ')}`);

    expect(
      bad,
      'type the array that feeds `schedule` (EntitySchedule[\'schedule\'], or ScheduleEntry from @themeparks/typelib) so the compiler holds ' +
      `every entry's type to the definition:\n${bad.join('\n')}`,
    ).toEqual([]);
  });

  it('nothing assigns a type outside the definition to a `type` property after the fact', () => {
    const found = parkSources().flatMap(sf => scanTypeAssignments(rel(sf), sf, checker));
    const bad = found.filter(f => unreadable(f) || outsideDefinition(f).length)
      .map(f => `${where(f)}  -> ${[...f.unresolved, ...outsideDefinition(f)].join(', ')}`);

    expect(
      bad,
      `an assignment to .type must be a member of the definition, or carry a "schedule-type-ok: <reason>" comment when it is not a schedule entry:\n${bad.join('\n')}`,
    ).toEqual([]);
  });

  it('every park that builds schedules has entries the scan can see', () => {
    // A park assembling entries some other way (Object.assign, a class, a
    // spread of a shared base) would be invisible to the checks above.
    const definesBuild = /(?:protected|public)\s+(?:async\s+)?buildSchedules\s*\(/;
    const withSites = new Set(
      parkSources().filter(sf => scanSourceFile('', sf, checker).length || scanPublishedSchedules('', sf, checker).length).map(rel),
    );
    const blind = parkSources()
      .filter(sf => definesBuild.test(readFileSync(sf.fileName, 'utf8')) && !withSites.has(rel(sf)))
      .map(rel);

    expect(blind, `these implement buildSchedules() but no entry or {id, schedule} was found:\n${blind.join('\n')}`).toEqual([]);
  });

  it('the scan is looking at the real tree', () => {
    // Not a count to maintain: a floor that proves the walk found the parks and
    // the resolver reached the types, so the checks above are not vacuous.
    const files = parkSources();
    const literals = files.flatMap(sf => scanSourceFile(rel(sf), sf, checker));
    const published = files.flatMap(sf => scanPublishedSchedules(rel(sf), sf, checker));
    expect(files.length).toBeGreaterThan(40);
    expect(literals.length).toBeGreaterThan(40);
    expect(published.length).toBeGreaterThan(40);
    const seen = new Set(literals.flatMap(f => f.values));
    for (const t of ['OPERATING', 'INFO', 'EXTRA_HOURS', 'TICKETED_EVENT']) expect(seen).toContain(t);
  });
});

describe('the entry literal scan', () => {
  const scan = (body: string) => scanScheduleTypes('probe.ts', body);

  it('flags a literal the definition lacks', () => {
    const [f] = scan(`const e = {date: d, type: 'PARK_OPEN', openingTime: a, closingTime: b};`);
    expect(f.values).toEqual(['PARK_OPEN']);
    expect(outsideDefinition(f)).toEqual(['PARK_OPEN']);
  });

  it('reads through as, parentheses and satisfies', () => {
    const found = scan(`
      const a = {type: 'OPERATING' as const, openingTime: 1, closingTime: 2};
      const b = {type: ('INFO'), openingTime: 1, closingTime: 2};
      const c = {type: ('EXTRA_HOURS' satisfies string), openingTime: 1, closingTime: 2};
    `);
    expect(found.map(f => f.values)).toEqual([['OPERATING'], ['INFO'], ['EXTRA_HOURS']]);
  });

  it('accepts a ScheduleTypeEnum member, reading it as the member\'s value', () => {
    const found = scan(`
      const a = {type: ScheduleTypeEnum.OPERATING, openingTime: 1, closingTime: 2};
      const b = {type: ScheduleTypeEnum['TICKETED_EVENT'], openingTime: 1, closingTime: 2};
      const c = {type: x ? ScheduleTypeEnum.INFO : ScheduleTypeEnum.EXTRA_HOURS, openingTime: 1, closingTime: 2};
    `);
    expect(found.map(f => f.values)).toEqual([['OPERATING'], ['TICKETED_EVENT'], ['EXTRA_HOURS', 'INFO']]);
    expect(found.flatMap(f => f.unresolved)).toEqual([]);
  });

  it('flags a ScheduleTypeEnum member the enum does not have', () => {
    const [f] = scan(`const a = {type: ScheduleTypeEnum.PARK_OPEN, openingTime: 1, closingTime: 2};`);
    expect(outsideDefinition(f)).toEqual(['ScheduleTypeEnum.PARK_OPEN']);
  });

  it('finds an entry whose type key is computed from a string', () => {
    const [f] = scan(`const a = {['type']: 'PARK_OPEN', openingTime: 1, closingTime: 2};`);
    expect(outsideDefinition(f)).toEqual(['PARK_OPEN']);
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

  it('does not read a destructured name through an outer variable of the same name', () => {
    const found = scan(`
      const type = 'OPERATING';
      function build(row) {
        const {type} = row;
        return {date: 'd', openingTime: 1, closingTime: 2, type};
      }
    `);
    expect(found[0].values).toEqual([]);
    expect(found[0].unresolved.length).toBeGreaterThan(0);
  });

  it('does not read x.type through other entries in the file', () => {
    const found = scan(`
      const kind = 'TICKETED_EVENT';
      const a = {type: kind, openingTime: 1, closingTime: 2};
      const b = {type: entry.type, openingTime: 1, closingTime: 2};
    `);
    expect(found[0].values).toEqual(['TICKETED_EVENT']);
    expect(found[1].values).toEqual([]);
    expect(found[1].unresolved).toEqual(['entry.type']);
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

  describe('with the type checker', () => {
    const literalsIn = (name: string) => scanSourceFile(name, probe(name), checker);

    it('reads x.type from the type of x', () => {
      const [f] = literalsIn('rowTypeOk');
      expect(f.values).toEqual(FIVE);
      expect(f.unresolved).toEqual([]);
    });

    it('rejects x.type when x.type is a string', () => {
      const [f] = literalsIn('rowTypeString');
      expect(f.unresolved.join()).toContain('string');
    });

    it('rejects a destructured type typed as string, whatever an outer variable says', () => {
      const [f] = literalsIn('destructured');
      expect(f.values).toEqual([]);
      expect(f.unresolved.join()).toContain('string');
    });
  });
});

describe('the published schedule scan', () => {
  const published = (name: string) => scanPublishedSchedules(name, probe(name), checker);

  it('passes entries typed as the definition', () => {
    const [f] = published('typedOk');
    expect(f.values).toEqual(FIVE);
    expect(f.unresolved).toEqual([]);
  });

  it('passes an empty schedule', () => {
    const [f] = published('emptyOk');
    expect(f.unresolved).toEqual([]);
  });

  it('rejects entries in an any[]', () => {
    expect(published('anyArray')[0].unresolved).toEqual(['schedule entries are any']);
  });

  it('rejects entries whose type is string', () => {
    expect(published('stringArray')[0].unresolved).toEqual(['entry type is string']);
  });

  it('looks under a cast to the declared schedule type', () => {
    expect(published('castOver')[0].unresolved).toEqual(['entry type is string']);
  });

  it('rejects a map that overrides type with a spread, on any and on typed input', () => {
    expect(published('spreadOfAny')[0].unresolved.length).toBeGreaterThan(0);
    expect(published('spreadOfTyped')[0].unresolved).toEqual(['entry type is string']);
  });
});

describe('the type assignment scan', () => {
  const found = () => scanTypeAssignments('assignedLate', probe('assignedLate'), checker);

  it('flags a late assignment of a type outside the definition, by dot or by key', () => {
    expect(found().filter(f => outsideDefinition(f).length).map(f => f.text)).toEqual([
      "e.type = 'PARK_OPEN'",
      "e['type'] = 'PARK_OPEN'",
    ]);
  });

  it('accepts a member of the definition, as a literal or as the enum member', () => {
    const ok = found().filter(f => !outsideDefinition(f).length && !f.unresolved.length);
    expect(ok.map(f => f.text)).toEqual(["e.type = 'INFO'", 'e.type = ScheduleTypeEnum.INFO']);
  });

  it('flags a value it cannot read', () => {
    expect(found().filter(f => f.unresolved.length).map(f => f.text)).toEqual(['e.type ||= kind']);
  });

  it('honours a schedule-type-ok marker on the line above', () => {
    expect(found().map(f => f.text)).not.toContain("e.type = 'ATTRACTION'");
  });
});

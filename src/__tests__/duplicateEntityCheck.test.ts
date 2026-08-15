import {describe, it, expect} from 'vitest';
import {findDuplicateEntityIds, describeDuplicateEntityIds} from '../duplicateCheck.js';

/**
 * The invariant: an entity list claims each id exactly once.
 *
 * The case that motivated it is Walibi Holland, whose CMS gives one wait-time
 * id to two Walibi Express stations 150m apart. Both are emitted, one wins,
 * and the loser has never existed on the wiki. Nothing detected it because
 * nothing looked.
 */
describe('findDuplicateEntityIds', () => {
  it('returns nothing for a list where every id is distinct', () => {
    expect(findDuplicateEntityIds([
      {id: 'a', name: 'Alpha'},
      {id: 'b', name: 'Beta'},
      {id: 'c', name: 'Gamma'},
    ])).toEqual([]);
  });

  it('returns nothing for an empty list', () => {
    expect(findDuplicateEntityIds([])).toEqual([]);
  });

  it('reports the repeated id with every name competing for it', () => {
    const dups = findDuplicateEntityIds([
      {id: '460e803c', name: 'Walibi Express Station 1'},
      {id: 'other', name: 'Something Else'},
      {id: '460e803c', name: 'Walibi Express Station 2'},
    ]);

    expect(dups).toEqual([{
      id: '460e803c',
      names: ['Walibi Express Station 1', 'Walibi Express Station 2'],
      count: 2,
    }]);
  });

  it('keeps names in emission order, so the survivor is identifiable', () => {
    // Which one wins downstream depends on order, so the report has to
    // preserve it rather than sort or dedupe.
    const [dup] = findDuplicateEntityIds([
      {id: 'x', name: 'first'},
      {id: 'x', name: 'second'},
      {id: 'x', name: 'third'},
    ]);

    expect(dup.names).toEqual(['first', 'second', 'third']);
    expect(dup.count).toBe(3);
  });

  it('reports several distinct collisions independently', () => {
    const dups = findDuplicateEntityIds([
      {id: 'a', name: 'A1'}, {id: 'b', name: 'B1'},
      {id: 'a', name: 'A2'}, {id: 'b', name: 'B2'},
    ]);

    expect(dups.map((d) => d.id)).toEqual(['a', 'b']);
  });

  it('skips entities with no id rather than collapsing them together', () => {
    // A missing id is a different defect and the harness fails on it
    // separately; grouping them here would report a phantom collision.
    expect(findDuplicateEntityIds([
      {name: 'no id'},
      {id: '', name: 'empty id'},
      {name: 'also no id'},
    ])).toEqual([]);
  });

  it('reads a localised name without throwing', () => {
    const [dup] = findDuplicateEntityIds([
      {id: 'x', name: {en: 'Dragon Lair', fr: 'La Tanière du Dragon'}},
      {id: 'x', name: {fr: 'Autre'}},
    ]);

    expect(dup.names).toEqual(['Dragon Lair', 'Autre']);
  });

  it('falls back to a placeholder for an unusable name', () => {
    const [dup] = findDuplicateEntityIds([
      {id: 'x'},
      {id: 'x', name: 42 as unknown as string},
    ]);

    expect(dup.names).toEqual(['(unnamed)', '(unnamed)']);
  });

  it('does not mutate the input', () => {
    const entities = [{id: 'x', name: 'a'}, {id: 'x', name: 'b'}];
    const copy = structuredClone(entities);

    findDuplicateEntityIds(entities);

    expect(entities).toEqual(copy);
  });
});

describe('describeDuplicateEntityIds', () => {
  it('names the id and everything claiming it', () => {
    const message = describeDuplicateEntityIds(findDuplicateEntityIds([
      {id: '460e803c', name: 'Walibi Express Station 1'},
      {id: '460e803c', name: 'Walibi Express Station 2'},
    ]));

    expect(message).toBe(
      '"460e803c" claimed by 2: "Walibi Express Station 1", "Walibi Express Station 2"',
    );
  });

  it('separates several collisions', () => {
    const message = describeDuplicateEntityIds(findDuplicateEntityIds([
      {id: 'a', name: 'A1'}, {id: 'a', name: 'A2'},
      {id: 'b', name: 'B1'}, {id: 'b', name: 'B2'},
    ]));

    expect(message).toContain('; ');
    expect(message).toContain('"a" claimed by 2');
    expect(message).toContain('"b" claimed by 2');
  });
});

import {describe, it, expect} from 'vitest';
import {findOrphanIds} from '../orphanCheck.js';

/**
 * Live data and schedules are keyed by entity id. A row keyed to an id that
 * getEntities() never emits cannot be looked up by any consumer, so the
 * harness reports it. Disneyland Paris was publishing 36 such schedule ids,
 * covering most of its schedule days, because buildSchedules read a wider
 * upstream feed than buildEntityList did.
 */
describe('findOrphanIds', () => {
  // Built per test. Shared across tests it silently masked whether the
  // implementation mutates the caller's set: a mutating version "failed" only
  // because it poisoned later tests, which would evaporate on a reorder.
  const mkPublished = () => new Set(['P1', 'P2', 'P1RA00']);

  it('returns nothing when every row is published', () => {
    expect(findOrphanIds([{id: 'P1'}, {id: 'P1RA00'}], mkPublished())).toEqual([]);
  });

  it('finds a row keyed to an unpublished id', () => {
    expect(findOrphanIds([{id: 'P1'}, {id: 'H03R00'}], mkPublished())).toEqual(['H03R00']);
  });

  it('reports each orphan id once however many rows carry it', () => {
    const rows = [{id: 'H03R00'}, {id: 'H03R00'}, {id: 'H03R00'}, {id: 'D01R02'}];
    expect(findOrphanIds(rows, mkPublished()).sort()).toEqual(['D01R02', 'H03R00']);
  });

  it('stays quiet when the entity list is empty', () => {
    // getEntities() failed or was skipped. Reporting every row as an orphan
    // would bury the real failure under noise.
    expect(findOrphanIds([{id: 'H03R00'}, {id: 'D01R02'}], new Set())).toEqual([]);
  });

  it('ignores rows with no id', () => {
    expect(findOrphanIds([{}, {id: undefined}, {id: ''}], mkPublished())).toEqual([]);
  });

  it('survives null and undefined rows', () => {
    const rows = [null, undefined, {id: 'H03R00'}] as unknown as Array<{id?: string}>;
    expect(findOrphanIds(rows, mkPublished())).toEqual(['H03R00']);
  });

  it('treats a single published id as a real entity list', () => {
    // The empty-set guard means "the entity list is missing". One entity is a
    // list of one, and its feed still gets checked.
    expect(findOrphanIds([{id: 'ONLY'}, {id: 'GHOST'}], new Set(['ONLY']))).toEqual(['GHOST']);
  });

  it('does not modify the caller\'s published set', () => {
    const published = new Set(['P1']);
    findOrphanIds([{id: 'GHOST'}, {id: 'P1'}], published);
    expect([...published]).toEqual(['P1']);
  });

  it('is exact about ids rather than matching loosely', () => {
    // 'P1' is published; 'P10' and 'p1' are not.
    expect(findOrphanIds([{id: 'P10'}, {id: 'p1'}], mkPublished()).sort()).toEqual(['P10', 'p1']);
  });
});

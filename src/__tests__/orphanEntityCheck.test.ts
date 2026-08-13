import {describe, it, expect} from 'vitest';
import {findOrphanIds} from '../testRunner.js';

/**
 * Live data and schedules are keyed by entity id. A row keyed to an id that
 * getEntities() never emits cannot be looked up by any consumer, so the
 * harness reports it. Disneyland Paris was publishing 36 such schedule ids,
 * 42% of its schedule days, because buildSchedules read a wider upstream feed
 * than buildEntityList did.
 */
describe('findOrphanIds', () => {
  const published = new Set(['P1', 'P2', 'P1RA00']);

  it('returns nothing when every row is published', () => {
    expect(findOrphanIds([{id: 'P1'}, {id: 'P1RA00'}], published)).toEqual([]);
  });

  it('finds a row keyed to an unpublished id', () => {
    expect(findOrphanIds([{id: 'P1'}, {id: 'H03R00'}], published)).toEqual(['H03R00']);
  });

  it('reports each orphan id once however many rows carry it', () => {
    const rows = [{id: 'H03R00'}, {id: 'H03R00'}, {id: 'H03R00'}, {id: 'D01R02'}];
    expect(findOrphanIds(rows, published)).toEqual(['H03R00', 'D01R02']);
  });

  it('stays quiet when the entity list is empty', () => {
    // getEntities() failed or was skipped. Reporting every row as an orphan
    // would bury the real failure under noise.
    expect(findOrphanIds([{id: 'H03R00'}, {id: 'D01R02'}], new Set())).toEqual([]);
  });

  it('ignores rows with no id', () => {
    expect(findOrphanIds([{}, {id: undefined}, {id: ''}], published)).toEqual([]);
  });

  it('survives null and undefined rows', () => {
    const rows = [null, undefined, {id: 'H03R00'}] as unknown as Array<{id?: string}>;
    expect(findOrphanIds(rows, published)).toEqual(['H03R00']);
  });

  it('returns an empty list for an empty input', () => {
    expect(findOrphanIds([], published)).toEqual([]);
  });

  it('is exact about ids rather than matching loosely', () => {
    // 'P1' is published; 'P10' and 'p1' are not.
    expect(findOrphanIds([{id: 'P10'}, {id: 'p1'}], published)).toEqual(['P10', 'p1']);
  });
});

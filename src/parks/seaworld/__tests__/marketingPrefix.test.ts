import {describe, test, expect} from 'vitest';
import {cleanPoiName} from '../seaworld.js';

// Names as SeaWorld Orlando and San Diego published them on 2026-09-27.
describe('cleanPoiName', () => {
  test.each([
    ['ALL-NEW! Dead Air', 'Dead Air'],
    ['ALL-NEW! Byte Bar', 'Byte Bar'],
    ['ALL NEW! - Expedition Odyssey Fire & Ice', 'Expedition Odyssey Fire & Ice'],
    ['All-New! Coral Candy Club', 'Coral Candy Club'],
    ['ALL-NEW! Spookley Meet & Greet', 'Spookley Meet & Greet'],
  ])('%s -> %s', (input, expected) => {
    expect(cleanPoiName(input)).toBe(expected);
  });

  test('leaves names that merely contain "new" alone', () => {
    for (const name of ['New Orleans Café', 'Brand New Show', 'Allnew Coaster', 'Mako', 'Welcome to Our Street!']) {
      expect(cleanPoiName(name)).toBe(name);
    }
  });

  test('never empties a name', () => {
    expect(cleanPoiName('ALL-NEW!')).toBe('ALL-NEW!');
  });
});

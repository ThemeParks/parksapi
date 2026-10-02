import {describe, test, expect} from 'vitest';
import {stripMapNumberPrefix} from '../attractionsiov1.js';

// LEGOLAND Japan names as the feed published them from 2026-09-13, prefixed
// with the park-map legend number.
describe('stripMapNumberPrefix', () => {
  test.each([
    ['①LEGO ® Factory Tour', 'LEGO ® Factory Tour'],
    ['⑰Driving School', 'Driving School'],
    ['⑳Dragon\'s Apprentice', 'Dragon\'s Apprentice'],
    ['㉒Merlin\'s Challenge', 'Merlin\'s Challenge'],
    ['㉗Anchors Away!', 'Anchors Away!'],
    ['㊱ Something', 'Something'],
  ])('%s -> %s', (input, expected) => {
    expect(stripMapNumberPrefix(input)).toBe(expected);
  });

  test('leaves names without a leading map number unchanged', () => {
    for (const name of ['Driving School', 'Ninjago ⑤ Ride', 'Area 51', 'アイスカート']) {
      expect(stripMapNumberPrefix(name)).toBe(name);
    }
  });
});

import {describe, test, expect} from 'vitest';
import {parsePremierAccessPrices} from '../tokyodisneyresort.js';

/**
 * The API never carries a Premier Access price — every endpoint that holds one
 * sits behind a purchase flow needing registered park tickets. The rate itself
 * is published though, as a flat per-experience figure on the public guide
 * page, and this reads it.
 *
 * Markup below mirrors the live page: each experience is a
 * `div.listTextArea` holding a `p.heading3` name and a `strong` rate.
 */

const block = (name: string, yen: string) => `
  <div class="listBox"><a href="/en/attraction/detail/x/"><div class="listTextArea">
    <p class="heading3">${name}</p>
    <p class="text">Attraction</p>
    <strong>${yen} yen per access</strong>
  </div></a></div>`;

describe('parsePremierAccessPrices', () => {
  test('reads a name and its rate', () => {
    expect(parsePremierAccessPrices(block('Splash Mountain', '1,500')))
      .toEqual({'Splash Mountain': 1500});
  });

  /**
   * The real page is one long document with both parks in it, so a parser that
   * flattens the tags first reads the tail of the preceding element as part of
   * the name — "View moreHaunted Mansion". Pairing on the heading avoids that.
   */
  test('does not absorb text preceding the heading', () => {
    const html = `<button>View more</button>${block('Haunted Mansion', '1,000')}`;
    expect(parsePremierAccessPrices(html)).toEqual({'Haunted Mansion': 1000});
  });

  test('reads every experience on a page with many', () => {
    const html = [
      block('Enchanted Tale of Beauty and the Beast', '2,500'),
      block('The Happy Ride with Baymax', '1,500'),
      '<button>View more</button>',
      block('Soaring: Fantastic Flight', '2,500'),
      block('Toy Story Mania!', '2,000'),
    ].join('\n');
    expect(parsePremierAccessPrices(html)).toEqual({
      'Enchanted Tale of Beauty and the Beast': 2500,
      'The Happy Ride with Baymax': 1500,
      'Soaring: Fantastic Flight': 2500,
      'Toy Story Mania!': 2000,
    });
  });

  /**
   * Names have to come out exactly as the facility feed writes them or the
   * join finds nothing. The live page serves literal UTF-8 rather than
   * entities — verified against the page itself — so typographic punctuation
   * must survive untouched; numeric entities are decoded in case that changes.
   */
  test('passes literal UTF-8 punctuation through unchanged', () => {
    expect(parsePremierAccessPrices(block('The Villains’ Halloween “Into the Frenzy”', '3,500')))
      .toEqual({'The Villains’ Halloween “Into the Frenzy”': 3500});
  });

  test('decodes numeric entities in names', () => {
    expect(parsePremierAccessPrices(block('Peter Pan&#039;s Never Land Adventure', '2,000')))
      .toEqual({"Peter Pan's Never Land Adventure": 2000});
  });

  test('a heading with no rate is skipped', () => {
    const html = `
      <div class="listTextArea"><p class="heading3">Space Mountain</p></div>
      ${block('Big Thunder Mountain', '1,500')}`;
    expect(parsePremierAccessPrices(html)).toEqual({'Big Thunder Mountain': 1500});
  });

  test.each([
    ['no prices at all', '<div><p>Nothing here</p></div>'],
    ['empty input', ''],
    ['a rate of zero', block('Free Ride', '000')],
  ])('%s yields nothing rather than throwing', (_label, html) => {
    expect(parsePremierAccessPrices(html)).toEqual({});
  });
});

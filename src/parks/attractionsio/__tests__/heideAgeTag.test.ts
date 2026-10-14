/**
 * Heide Park publishes a Halloween event show as
 *
 *     Mission Meeresgrund “Halloween Edition ab 10 Jahren“
 *
 * The park's own quotes are unbalanced, as both are the same opening mark, and
 * the German age rating ("ab 10 Jahren": from 10 years) is typed into the
 * name. Neither is part of the title, and the age rating belongs to the event
 * rather than the show, so the name would change whenever the park retyped
 * either. The clean name is "Mission Meeresgrund Halloween Edition".
 *
 * The rule keys on the age rating at the end of a name. Quotes are touched only
 * when that rating sat inside a quote that was never closed, so a title that
 * carries quotes of its own is left alone. It is applied to Heide Park only.
 *
 * The Mission Meeresgrund names are the live ones. The other records are made
 * up for this test, apart from the restaurant and the Hansa-Park ride name,
 * which are live names kept as near-misses.
 */

import {describe, test, expect, beforeEach} from 'vitest';
import {HeidePark, LegolandDeutschland, AltonTowers, stripAgeRatingTag} from '../attractionsiov1.js';
import {CacheLib} from '../../../cache.js';

beforeEach(() => {
  // getCategoryIDs is @cache-decorated and keyed per destination.
  CacheLib.clearAll();
});

describe('stripAgeRatingTag', () => {
  test.each([
    ['the live name', 'Mission Meeresgrund “Halloween Edition ab 10 Jahren“', 'Mission Meeresgrund Halloween Edition'],
    ['a closing curly quote', 'Mission Meeresgrund “Halloween Edition ab 10 Jahren”', 'Mission Meeresgrund Halloween Edition'],
    ['German quotes', 'Mission Meeresgrund „Halloween Edition ab 10 Jahren“', 'Mission Meeresgrund Halloween Edition'],
    ['straight quotes', 'Mission Meeresgrund "Halloween Edition ab 10 Jahren"', 'Mission Meeresgrund Halloween Edition'],
    ['an opening quote that is never closed', 'Mission Meeresgrund “Halloween Edition ab 10 Jahren', 'Mission Meeresgrund Halloween Edition'],
    ['no quotes at all', 'Kinderdisco ab 6 Jahren', 'Kinderdisco'],
    ['"Jahre" without the n', 'Halloween Edition ab 12 Jahre', 'Halloween Edition'],
    ['any case', 'Kinderdisco AB 6 JAHREN', 'Kinderdisco'],
    ['extra spaces', 'Kinderdisco   ab   6   Jahren  ', 'Kinderdisco'],
    ['a balanced quoted title word before the rating', 'Hot Dog “Freestyle” ab 6 Jahren', 'Hot Dog “Freestyle”'],
    ['balanced quotes and the rating inside an unclosed one', 'Rock “n” Roll “Special ab 8 Jahren', 'Rock “n” Roll Special'],
    ['a stray closing quote after a balanced title', 'Hot Dog “Freestyle” ab 6 Jahren“', 'Hot Dog “Freestyle”'],
  ])('%s', (_label, input, expected) => {
    expect(stripAgeRatingTag(input)).toBe(expected);
  });

  test.each([
    ['a plain name', 'Mission Meeresgrund'],
    ['straight quotes that belong to the title (live name)', 'Hot Dog "Freestyle"'],
    ['balanced curly quotes that belong to the title (live name)', 'Viking Boat “Viking Odin”'],
    ['quotes that are unbalanced but carry no age rating', 'Mission “Meeresgrund'],
    ['the word "ab" in a name', 'Ab in den Dschungel'],
    ['"ab" as a preposition', 'Fahrt ab Hafen'],
    ['"ab" with a height, not an age', 'Wasserrutsche ab 1,20 m Körpergröße'],
    ['"ab" with a number but not years', 'Abenteuer ab 10'],
    ['an age rating that is not at the end', 'Zelt ab 10 Jahren geeignet'],
    ['an age rating that is the whole name', 'ab 10 Jahren'],
    ['"Jahren" without a rating', 'Spielplatz der Jahren'],
    ['an English age note', 'Halloween Edition from 10 years'],
  ])('leaves alone: %s', (_label, name) => {
    expect(stripAgeRatingTag(name)).toBe(name);
  });

  test('is idempotent', () => {
    const once = stripAgeRatingTag('Mission Meeresgrund “Halloween Edition ab 10 Jahren“');
    expect(stripAgeRatingTag(once)).toBe(once);
  });
});

// ---------------------------------------------------------------------------
// The real park classes
// ---------------------------------------------------------------------------

function stub(park: any, records: any): any {
  park.getPOIData = async () => records;
  park.fetchLiveData = async () => ({json: async () => ({entities: {Item: {records: []}}})});
  return park;
}

function records(): any {
  return {
    Resort: [{_id: 1, Name: {'de-DE': 'Heide Park Resort'}}],
    Category: [
      {_id: 10, Name: 'Shows'},
      {_id: 11, Name: 'Fast Food'},
      {_id: 12, Name: 'Attractions'},
    ],
    Item: [
      // The live pair: the plain show and the Halloween edition with the rating.
      {_id: 24498, Name: 'Mission Meeresgrund', Category: 10, entityIds: [], Classifications: []},
      {_id: 25841, Name: 'Mission Meeresgrund “Halloween Edition ab 10 Jahren“', Category: 10, entityIds: [], Classifications: []},
      // A restaurant with quotes of its own (live name), and a ride and a
      // restaurant with a rating (made up).
      {_id: 14803, Name: 'Hot Dog "Freestyle"', Category: 11, entityIds: [], Classifications: []},
      {_id: 9001, Name: 'Geisterbahn ab 8 Jahren', Category: 12, entityIds: [], Classifications: []},
      {_id: 9002, Name: 'Fahrt ab Hafen', Category: 12, entityIds: [], Classifications: []},
    ],
  };
}

describe('Heide Park names', () => {
  test('the Halloween edition loses the quotes and the age rating', async () => {
    const entities = await stub(new HeidePark(), records()).getEntities();
    expect(entities.find((e: any) => e.id === '25841')).toMatchObject({
      name: 'Mission Meeresgrund Halloween Edition',
      entityType: 'SHOW',
    });
  });

  test('the plain show, the quoted restaurant and "ab" in a name are untouched', async () => {
    const entities = await stub(new HeidePark(), records()).getEntities();
    expect(entities.find((e: any) => e.id === '24498')?.name).toBe('Mission Meeresgrund');
    expect(entities.find((e: any) => e.id === '14803')?.name).toBe('Hot Dog "Freestyle"');
    expect(entities.find((e: any) => e.id === '9002')?.name).toBe('Fahrt ab Hafen');
  });

  test('a ride with a rating loses it too, and no id changes', async () => {
    const entities = await stub(new HeidePark(), records()).getEntities();
    expect(entities.find((e: any) => e.id === '9001')?.name).toBe('Geisterbahn');
    expect(entities.map((e: any) => e.id).sort()).toEqual(
      ['14803', '24498', '25841', '9001', '9002', 'heidepark', 'heideparkresort'].sort(),
    );
  });
});

describe('the rule is scoped to Heide Park', () => {
  test.each([
    ['LEGOLAND Deutschland', () => new LegolandDeutschland()],
    ['Alton Towers', () => new AltonTowers()],
  ])('%s keeps a name that ends in an age rating', async (_label, make) => {
    const entities = await stub(make(), records()).getEntities();
    expect(entities.find((e: any) => e.id === '25841')?.name).toBe('Mission Meeresgrund “Halloween Edition ab 10 Jahren“');
    expect(entities.find((e: any) => e.id === '9001')?.name).toBe('Geisterbahn ab 8 Jahren');
  });
});

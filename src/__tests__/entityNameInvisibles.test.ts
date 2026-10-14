import {describe, test, expect} from 'vitest';
import {Destination} from '../destination.js';
import type {Entity} from '@themeparks/typelib';

/**
 * Some feeds put zero-width characters into entity names, almost always at the
 * end ("A Voyage with Duffy and Friends" + U+200B). They render as nothing and
 * survive trim(), so the entity shows up renamed and cannot be found by typing
 * its name. Every park's names pass through the shared sanitiser in
 * Destination.getEntities(), which is where they are removed.
 *
 * Three characters are removed: the zero width space (U+200B), the word joiner
 * (U+2060) and the byte order mark (U+FEFF). They have no part in spelling a
 * word. The zero width non-joiner (U+200C) and joiner (U+200D) do: they shape
 * emoji sequences and Persian, Arabic-script and Indic words, so they are left
 * alone.
 *
 * Only the name changes. The id is the identity of the entity, so a cleaned
 * name keeps the entity it belongs to.
 */

const ZWSP = '\u200B';
const ZWNJ = '\u200C';
const ZWJ = '\u200D';
const WORD_JOINER = '\u2060';
const BOM = '\uFEFF';

/** U+1F468 ZWJ U+1F469 ZWJ U+1F467, a family emoji: one glyph made of three. */
const FAMILY_EMOJI = [0x1F468, 0x200D, 0x1F469, 0x200D, 0x1F467].map(c => String.fromCodePoint(c)).join('');

/** "I want" in Persian: می, a zero width non-joiner, then خواهم. */
const PERSIAN_WORD = `می${ZWNJ}خواهم`;

class NameTestDest extends Destination {
  entities: Entity[] = [];

  async getDestinations(): Promise<Entity[]> {
    return [{id: 'dest', name: 'Test', entityType: 'DESTINATION', timezone: 'UTC'} as Entity];
  }

  protected async buildEntityList(): Promise<Entity[]> { return this.entities; }
  protected async buildLiveData(): Promise<any[]> { return []; }
  protected async buildSchedules(): Promise<any[]> { return []; }
}

const entity = (id: string, name: string | Record<string, string>, entityType = 'SHOW'): Entity => ({
  id,
  name,
  entityType,
  parentId: 'dest',
  destinationId: 'dest',
  timezone: 'UTC',
} as Entity);

async function namesFor(...names: Array<string | Record<string, string>>) {
  const dest = new NameTestDest();
  dest.entities = names.map((n, i) => entity(`e${i}`, n));
  const out = await dest.getEntities();
  return names.map((_, i) => out.find(e => e.id === `e${i}`)!.name);
}

describe('entity names: zero-width characters', () => {
  test.each([
    ['U+200B zero width space', ZWSP],
    ['U+2060 word joiner', WORD_JOINER],
    ['U+FEFF byte order mark', BOM],
  ])('%s is removed from the end of a name', async (_label, ch) => {
    expect(await namesFor(`A Voyage with Duffy and Friends${ch}`)).toEqual(['A Voyage with Duffy and Friends']);
  });

  test.each([
    ['U+200B', ZWSP],
    ['U+2060', WORD_JOINER],
    ['U+FEFF', BOM],
  ])('%s is removed from the start and the middle of a name', async (_label, ch) => {
    expect(await namesFor(`${ch}Villain Balcony Walk`)).toEqual(['Villain Balcony Walk']);
    expect(await namesFor(`Villain Balcony${ch} Walk`)).toEqual(['Villain Balcony Walk']);
    expect(await namesFor(`Villain${ch}Balcony Walk`)).toEqual(['VillainBalcony Walk']);
  });

  test('the four Shanghai Disneyland names that carry U+200B come out clean', async () => {
    expect(await namesFor(
      `Meet Evil Witch at Seven Dwarfs Mine Train${ZWSP}`,
      `Treasure Cove: Buccaneer Bash${ZWSP}`,
      `Villain Balcony Walk${ZWSP}`,
      `The Villains' Club${ZWSP}`,
    )).toEqual([
      'Meet Evil Witch at Seven Dwarfs Mine Train',
      'Treasure Cove: Buccaneer Bash',
      'Villain Balcony Walk',
      "The Villains' Club",
    ]);
  });

  test('several characters in one name, and mixed kinds, all go', async () => {
    expect(await namesFor(`${BOM}Happily Ever After${ZWSP}${ZWSP} – Halloween Edition${WORD_JOINER}`))
      .toEqual(['Happily Ever After – Halloween Edition']);
  });

  test('cleans every language of a multi-language name', async () => {
    expect(await namesFor({en: `Duffy${ZWSP}`, zh: `迪士尼${ZWSP}`}))
      .toEqual([{en: 'Duffy', zh: '迪士尼'}]);
  });

  test('an entity-encoded zero-width space is decoded and then removed', async () => {
    expect(await namesFor('Villain Balcony Walk&#8203;', 'Villain Balcony Walk&#x200B;'))
      .toEqual(['Villain Balcony Walk', 'Villain Balcony Walk']);
  });

  test('is removed before the status suffix is matched', async () => {
    expect(await namesFor(`Phoenix Rising - NOW OPEN!${ZWSP}`)).toEqual(['Phoenix Rising']);
    expect(await namesFor(`Phoenix Rising${ZWSP} - NOW OPEN!`)).toEqual(['Phoenix Rising']);
  });

  test('cleaning is idempotent', async () => {
    const [once] = await namesFor(`The Villains' Club${ZWSP}`);
    expect(await namesFor(once as string)).toEqual([once]);
  });

  test('only the name changes: id, type and parent are untouched', async () => {
    const dest = new NameTestDest();
    // The id does not match the name, as in the live feed; it must stay as it is.
    dest.entities = [entity('entATrialOfDarknessENT;entityType=Entertainment;destination=shdr', `Treasure Cove: Buccaneer Bash${ZWSP}`)];
    const out = await dest.getEntities();
    expect(out.find(e => e.id.startsWith('entATrial'))).toMatchObject({
      id: 'entATrialOfDarknessENT;entityType=Entertainment;destination=shdr',
      name: 'Treasure Cove: Buccaneer Bash',
      entityType: 'SHOW',
      parentId: 'dest',
    });
  });

  test('a name made only of these characters is kept, not turned into an empty name', async () => {
    expect(await namesFor(`${ZWSP}${ZWSP}`)).toEqual([`${ZWSP}${ZWSP}`]);
    expect(await namesFor(`${WORD_JOINER}${ZWSP}`)).toEqual([`${WORD_JOINER}${ZWSP}`]);
  });
});

describe('entity names: joiners are kept', () => {
  test('a Persian word keeps the zero width non-joiner that spells it', async () => {
    expect(await namesFor(PERSIAN_WORD)).toEqual([PERSIAN_WORD]);
    expect(await namesFor(`Ride ${PERSIAN_WORD}`)).toEqual([`Ride ${PERSIAN_WORD}`]);
  });

  test('a family emoji keeps the zero width joiners that make it one glyph', async () => {
    expect(await namesFor(`Family Fun ${FAMILY_EMOJI}`)).toEqual([`Family Fun ${FAMILY_EMOJI}`]);
    expect(await namesFor(FAMILY_EMOJI)).toEqual([FAMILY_EMOJI]);
  });

  test('a zero width space beside a joiner goes and the joiner stays', async () => {
    expect(await namesFor(`Family Fun ${FAMILY_EMOJI}${ZWSP}`)).toEqual([`Family Fun ${FAMILY_EMOJI}`]);
    expect(await namesFor(`${ZWSP}${PERSIAN_WORD}`)).toEqual([PERSIAN_WORD]);
  });

  test.each([
    ['U+200C', ZWNJ],
    ['U+200D', ZWJ],
  ])('%s is left alone wherever it is', async (_label, ch) => {
    const names = [`${ch}Villain Balcony Walk`, `Villain${ch}Balcony Walk`, `Villain Balcony Walk${ch}`];
    expect(await namesFor(...names)).toEqual(names);
  });
});

describe('entity names: ordinary text is untouched', () => {
  test('ordinary names, scripts and spaces are left exactly as they are', async () => {
    const names = [
      'Space Mountain',
      "It's a Small World",
      'Ratatouille : L’Aventure Totalement Toquée de Rémy',
      'Zürich Café',
      'Gruffalo Bites 🍩',
      '飞越狗熊岭[过山车]',
      '파라오의 분노',
      'アイスカート',
      'Jungle\u00A0Cruise',            // no-break space is visible spacing, not an artefact
      'Mickey\u3000Show',              // ideographic space
      'Infinity Falls®',
    ];
    expect(await namesFor(...names)).toEqual(names);
  });
});

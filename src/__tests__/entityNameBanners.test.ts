import {describe, test, expect} from 'vitest';
import {Destination} from '../destination.js';
import type {Entity} from '@themeparks/typelib';

/**
 * A feed that writes its status into the name: Sea World Gold Coast publishes
 * "ONE Dolphin Presentation – NOW SHOWING" for a show that is on. The banner
 * is not part of the name, and it comes and goes with the schedule, so the
 * entity would be renamed every time it did.
 *
 * It is handled by the shared name sanitiser in Destination.getEntities()
 * beside the other status suffixes ("- Now Open!", "- Temporarily Closed").
 * The suffix has to be the whole end of the name: the same words inside a
 * title, or a name that only has a dash in it, stay as they are.
 */

class BannerTestDest extends Destination {
  entities: Entity[] = [];

  async getDestinations(): Promise<Entity[]> {
    return [{id: 'dest', name: 'Test', entityType: 'DESTINATION', timezone: 'UTC'} as Entity];
  }

  protected async buildEntityList(): Promise<Entity[]> { return this.entities; }
  protected async buildLiveData(): Promise<any[]> { return []; }
  protected async buildSchedules(): Promise<any[]> { return []; }
}

async function namesFor(...names: string[]) {
  const dest = new BannerTestDest();
  dest.entities = names.map((name, i) => ({
    id: `e${i}`, name, entityType: 'SHOW', parentId: 'dest', destinationId: 'dest', timezone: 'UTC',
  } as Entity));
  const out = await dest.getEntities();
  return names.map((_, i) => out.find(e => e.id === `e${i}`)!.name);
}

describe('entity names: "Now Showing" banner', () => {
  test.each([
    ['en dash (the live name)', 'ONE Dolphin Presentation – NOW SHOWING'],
    ['hyphen', 'ONE Dolphin Presentation - NOW SHOWING'],
    ['em dash', 'ONE Dolphin Presentation — NOW SHOWING'],
    ['title case', 'ONE Dolphin Presentation – Now Showing'],
    ['lower case', 'ONE Dolphin Presentation – now showing'],
    ['no spaces around the dash', 'ONE Dolphin Presentation–NOW SHOWING'],
    ['no space before the dash', 'ONE Dolphin Presentation– NOW SHOWING'],
    ['no space after the dash', 'ONE Dolphin Presentation –NOW SHOWING'],
    ['extra and trailing spaces', '  ONE Dolphin Presentation   –   NOW   SHOWING   '],
    ['no-break spaces', 'ONE Dolphin Presentation\u00A0–\u00A0NOW\u00A0SHOWING'],
    ['a trailing exclamation mark', 'ONE Dolphin Presentation – NOW SHOWING!'],
    ['an HTML-encoded dash', 'ONE Dolphin Presentation &ndash; NOW SHOWING'],
  ])('is removed: %s', async (_label, name) => {
    expect(await namesFor(name)).toEqual(['ONE Dolphin Presentation']);
  });

  test('is removed when a zero-width space follows it', async () => {
    expect(await namesFor('ONE Dolphin Presentation – NOW SHOWING\u200B')).toEqual(['ONE Dolphin Presentation']);
  });

  test.each([
    ['the words at the start of a title', 'Now Showing: ONE Dolphin Presentation'],
    ['the words inside a title', 'The Now Showing Theatre'],
    ['the words after a dash, with more title after them', 'ONE Dolphin Presentation - Now Showing in Spring'],
    ['the banner followed by another part of the title', 'ONE Dolphin Presentation – NOW SHOWING – Late Session'],
    ['the words with no dash before them', 'ONE Dolphin Presentation Now Showing'],
    ['a name that is only the banner words', 'NOW SHOWING'],
    ['a dash joining a title and a subtitle', 'Expedition Everest - Legend of the Forbidden Mountain'],
    ['a name with a dash and nothing banner-like', 'Dolphin Beach Stadium – Presentation'],
    ['a name with no dash at all', 'Seal Guardians Presentation'],
  ])('is left alone: %s', async (_label, name) => {
    expect(await namesFor(name)).toEqual([name]);
  });

  test('a name that is only the banner is kept rather than emptied', async () => {
    expect(await namesFor('– NOW SHOWING')).toEqual(['– NOW SHOWING']);
  });

  test('the other status suffixes still work beside it', async () => {
    expect(await namesFor('Phoenix Rising - NOW OPEN!', 'Thunder Mountain - Temporarily Closed'))
      .toEqual(['Phoenix Rising', 'Thunder Mountain']);
  });
});

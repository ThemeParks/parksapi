/**
 * The Shanghai Disney facility list ends some entertainment names with a
 * U+200B zero-width space: "Villain Balcony Walk" + U+200B. It renders as
 * nothing, so the shows looked renamed and could not be found by name.
 *
 * The park publishes the names through the shared name sanitiser, which now
 * removes zero-width characters. The id is the identity of the entity and is
 * not derived from the name, so a cleaned name keeps its entity. Treasure Cove:
 * Buccaneer Bash is the live example: its id (entATrialOfDarknessENT) belongs
 * to an earlier name, and must stay as it is.
 *
 * The Duffy record and the Treasure Cove id are the live ones. The other three
 * ids are made up for this test.
 */
import {describe, it, expect, vi, beforeEach} from 'vitest';
import {ShanghaiDisneylandResort} from '../shanghaidisneyresort.js';
import {CacheLib} from '../../../cache.js';

const ZWSP = '\u200B';
const SUFFIX = ';entityType=Entertainment;destination=shdr';
const PARK_ID = 'shdr-park;entityType=theme-park;destination=shdr';

const PARK = {id: PARK_ID, name: 'Shanghai Disneyland', type: 'theme-park'};
const show = (id: string, name: string) => ({
  id: `${id}${SUFFIX}`,
  name,
  type: 'Entertainment',
  ancestors: [{id: PARK_ID, type: 'theme-park'}],
});

const FEED = [
  show('entMeetEvilWitchMineTrain', `Meet Evil Witch at Seven Dwarfs Mine Train${ZWSP}`),
  show('entATrialOfDarknessENT', `Treasure Cove: Buccaneer Bash${ZWSP}`),
  show('entVillainBalconyWalk', `Villain Balcony Walk${ZWSP}`),
  show('entVillainsClub', `The Villains' Club${ZWSP}`),
  show('entAVoyageWithDuffyAndFriends', `A Voyage with Duffy and Friends${ZWSP}`),
  show('entMeetDisneyVillains', 'Meet Disney Villains at Enchanted Storybook Castle'),
];

function park(facilities: unknown[]): ShanghaiDisneylandResort {
  const p = new ShanghaiDisneylandResort();
  vi.spyOn(p as any, 'getFacilities').mockResolvedValue(facilities);
  vi.spyOn(p as any, 'getWaitTimes').mockResolvedValue([]);
  return p;
}

describe('SHDR names with a zero-width space', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    CacheLib.clearByClassName('ShanghaiDisneylandResort', {includePersistent: true});
  });

  it('publishes the five names without it', async () => {
    const entities = await park([PARK, ...FEED]).getEntities();
    const shows = entities.filter((e: any) => e.entityType === 'SHOW');
    expect(shows.map((e: any) => e.name).sort()).toEqual([
      'A Voyage with Duffy and Friends',
      'Meet Disney Villains at Enchanted Storybook Castle',
      'Meet Evil Witch at Seven Dwarfs Mine Train',
      "The Villains' Club",
      'Treasure Cove: Buccaneer Bash',
      'Villain Balcony Walk',
    ]);
    expect(entities.some((e: any) => /[\u200B\u2060\uFEFF]/.test(e.name))).toBe(false);
  });

  it('keeps every id as the feed gave it, Treasure Cove included', async () => {
    const entities = await park([PARK, ...FEED]).getEntities();
    const idOfName = (name: string) => (entities.find((e: any) => e.name === name) as any).id;
    expect(idOfName('Treasure Cove: Buccaneer Bash')).toBe(`entATrialOfDarknessENT${SUFFIX}`);
    expect(idOfName('Villain Balcony Walk')).toBe(`entVillainBalconyWalk${SUFFIX}`);
    expect(idOfName('A Voyage with Duffy and Friends')).toBe(`entAVoyageWithDuffyAndFriends${SUFFIX}`);
    expect(entities.filter((e: any) => e.entityType === 'SHOW').map((e: any) => e.id).sort()).toEqual([
      'entATrialOfDarknessENT',
      'entAVoyageWithDuffyAndFriends',
      'entMeetDisneyVillains',
      'entMeetEvilWitchMineTrain',
      'entVillainBalconyWalk',
      'entVillainsClub',
    ].map(id => `${id}${SUFFIX}`));
  });

  it('does not touch a name that never had the character', async () => {
    const entities = await park([PARK, FEED[5]]).getEntities();
    expect(entities.find((e: any) => e.id === `entMeetDisneyVillains${SUFFIX}`)).toMatchObject({
      name: 'Meet Disney Villains at Enchanted Storybook Castle',
      entityType: 'SHOW',
    });
  });
});

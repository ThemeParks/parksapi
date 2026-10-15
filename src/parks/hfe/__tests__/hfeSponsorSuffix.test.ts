/**
 * A trailing sponsor credit is not part of a show's name.
 *
 * Silver Dollar City's feed titles a Christmas show "<name> Presented by
 * <sponsor>". Published as it stands, the credit becomes part of the entity's
 * name, and it moves with the sponsor deal: the next season's credit would
 * rename the entity. The credit is cut from the end of the title, for every
 * park on this feed, whether or not the park folds same-stage copies.
 *
 * Sponsor names below are placeholders. The shapes (a credit running to the
 * end of the title, after a space, dash, comma or colon) are the ones the
 * feeds use.
 */
import {describe, test, expect} from 'vitest';
import {
  SilverDollarCity,
  Dollywood,
  foldShowsByStage,
  stripSponsorSuffix,
  type HFEActivity,
} from '../hfe.js';

const SHOW_LIST = '9e8b88c7-6a31-46e2-b696-aad5a5ecfe3d';
const DOLLYWOOD_SHOW_LIST = 'b9acfd27-0545-4bb2-a6e8-072fda3b06dd';

const show = (id: string, title: string, over: Partial<HFEActivity> = {}): HFEActivity => ({
  id,
  title,
  activityListId: SHOW_LIST,
  activityCategories: ['Shows Entertainment'],
  ...over,
} as HFEActivity);

describe('stripSponsorSuffix', () => {
  test.each([
    ["Santa's Cottage Presented by Acme", "Santa's Cottage"],
    ['Harvest Festival Presented By Acme Health', 'Harvest Festival'],
    ['Winter Weekend Powered by Acme', 'Winter Weekend'],
    ['Drawn to Life - Presented by Acme', 'Drawn to Life'],
    ['Drawn to Life – Presented by Acme', 'Drawn to Life'],
    ['Drawn to Life — Presented by Acme', 'Drawn to Life'],
    ['Autopia, presented by Acme', 'Autopia'],
    ['Autopia: presented by Acme', 'Autopia'],
    ["Santa's Cottage PRESENTED BY ACME", "Santa's Cottage"],
    ["Santa's Cottage Presented by Acme ", "Santa's Cottage"],
    ['Cottage Presented by Acme & Sons Presented by Other', 'Cottage'],
  ])('%j becomes %j', (title, expected) => {
    expect(stripSponsorSuffix(title)).toBe(expected);
  });

  test.each([
    'Presented by Acme',
    'Powered by Acme',
    'Presented by Acme Christmas Show',
    'Mascots Represented by Acme',
    'Coat of Many Colors - Based on the book by Someone',
    'Written by Someone',
    'Santa Presented by',
    'Santa Presented by   ',
    'Plain Title',
    ' Padded Title ',
    '',
  ])('%j is returned exactly as it came in', title => {
    expect(stripSponsorSuffix(title)).toBe(title);
  });

  test('a value that is not a string passes through', () => {
    expect(stripSponsorSuffix(undefined as unknown as string)).toBeUndefined();
    expect(stripSponsorSuffix(null as unknown as string)).toBeNull();
  });
});

describe('foldShowsByStage and the sponsor credit', () => {
  const GAZEBO = 'fbc761ff-873e-4bc9-bf85-fe6018ab6865';
  const BOATWORKS = '68f726da-3b5e-43e9-a3ef-a5fa25b258bc';
  const venue = (id: string, title: string) =>
    show(id, title, {activityListId: 'venues', activityCategories: ['Venues']});

  test('the credit is not in the name of a single-stage act', () => {
    const shows = [show('a0000000-0000-4000-8000-000000000001', "Santa's Cottage Presented by Acme", {activityCategories: []})];
    const groups = foldShowsByStage(shows, shows);
    expect(groups.map(g => g.name)).toEqual(["Santa's Cottage"]);
  });

  test('a copy with the credit and a plain copy on the same stage are one entity', () => {
    const shows = [
      show('a0000000-0000-4000-8000-000000000001', 'Winter Show Presented by Acme', {showVenueLocation: GAZEBO}),
      show('a0000000-0000-4000-8000-000000000002', 'Winter Show', {showVenueLocation: GAZEBO}),
    ];
    const groups = foldShowsByStage(shows, [venue(GAZEBO, 'Gazebo Stage'), ...shows]);
    expect(groups).toHaveLength(1);
    expect(groups[0].members.map(m => m.id)).toEqual([
      'a0000000-0000-4000-8000-000000000001',
      'a0000000-0000-4000-8000-000000000002',
    ]);
    expect(groups[0].name).toBe('Winter Show');
  });

  test('the same act on two stages, one copy with the credit, gets stage names without it', () => {
    const shows = [
      show('a0000000-0000-4000-8000-000000000001', 'Winter Show Presented by Acme', {showVenueLocation: GAZEBO}),
      show('a0000000-0000-4000-8000-000000000002', 'Winter Show', {showVenueLocation: BOATWORKS}),
    ];
    const groups = foldShowsByStage(shows, [venue(GAZEBO, 'Gazebo Stage'), venue(BOATWORKS, 'Boatworks Theater'), ...shows]);
    expect(groups.map(g => g.name).sort()).toEqual(['Winter Show (Boatworks Theater)', 'Winter Show (Gazebo Stage)']);
  });

  test('two different acts stay two even when only one has a credit', () => {
    const shows = [
      show('a0000000-0000-4000-8000-000000000001', 'Winter Show Presented by Acme'),
      show('a0000000-0000-4000-8000-000000000002', 'Winter Revue'),
    ];
    expect(foldShowsByStage(shows, shows).map(g => g.name)).toEqual(['Winter Show', 'Winter Revue']);
  });
});

describe('through the park', () => {
  const SANTA = '0f01536f-f91b-4fd6-945c-3cfee9931c9c';
  const day = {
    date: '2026-12-05T00:00:00',
    parkHours: [],
    activities: [{cmsKey: SANTA, events: [{from: '2026-12-05T12:00:00', to: null}]}],
  };
  const showEntities = (entities: any[]) => entities.filter(e => e.entityType === 'SHOW');

  test('Silver Dollar City publishes the scheduled show without the credit, under its own id', async () => {
    const park: any = new SilverDollarCity();
    park.getActivities = async () => [show(SANTA, "Santa's Cottage Presented by Acme", {activityCategories: []})];
    park.getSchedule = async () => [day];
    const shows = showEntities(await park.getEntities());
    expect(shows.map((e: any) => [e.id, e.name])).toEqual([[SANTA, "Santa's Cottage"]]);
  });

  test('Dollywood, which does not fold, drops the credit too', async () => {
    const park: any = new Dollywood();
    park.getActivities = async () => [show(SANTA, 'Harvest Show Presented By Acme Health', {activityListId: DOLLYWOOD_SHOW_LIST})];
    park.getSchedule = async () => [];
    const shows = showEntities(await park.getEntities());
    expect(shows.map((e: any) => [e.id, e.name])).toEqual([[SANTA, 'Harvest Show']]);
  });
});

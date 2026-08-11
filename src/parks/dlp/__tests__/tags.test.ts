import {describe, it, expect, vi, beforeEach} from 'vitest';
import {DisneylandParis} from '../disneylandparis.js';

/**
 * Every field the tags are built from lives on the GraphQL `Attraction` type,
 * reached through an inline fragment. Anything else in the POI feed therefore
 * carries no tags at all.
 */
function stubbedPark(attraction: Record<string, unknown>): DisneylandParis {
  const park = new DisneylandParis();

  vi.spyOn(park as any, 'getPOIData').mockResolvedValue({
    ThemePark: [{id: 'P1', name: 'Disneyland Park', type: 'ThemePark'}],
    Attraction: [{
      id: 'P1RA00',
      name: 'Big Thunder Mountain',
      type: 'Attraction',
      location: {id: 'P1'},
      ...attraction,
    }],
    Entertainment: [{
      id: 'P1GS00',
      name: 'Disney Illuminations',
      type: 'Entertainment',
      subType: 'Fireworks',
      location: {id: 'P1'},
    }],
    Restaurant: [{
      id: 'P1AR06',
      name: 'Casa de Coco',
      type: 'Restaurant',
      location: {id: 'P1'},
    }],
  });

  return park;
}

async function tagsOf(attraction: Record<string, unknown>): Promise<string[]> {
  const entities = await stubbedPark(attraction).getEntities();
  const target = entities.find((e) => e.id === 'P1RA00');

  // Without this, every `toEqual([])` below would also pass on an attraction
  // that never made it into the output at all.
  expect(target).toBeDefined();

  return (target?.tags ?? []).map((t) => t.tag);
}

describe('DLP attraction tags', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('emits no tags for an attraction without any of the fields', async () => {
    expect(await tagsOf({})).toEqual([]);
  });

  it('emits no tags for shows or restaurants', async () => {
    const entities = await stubbedPark({}).getEntities();
    expect(entities.find((e) => e.id === 'P1GS00')?.tags).toEqual([]);
    expect(entities.find((e) => e.id === 'P1AR06')?.tags).toEqual([]);
  });

  // === Minimum height ===

  it.each([
    ['81cm', 81],
    ['1_02m', 102],
    ['1_07m', 107],
    ['1_20m', 120],
    ['1_40m', 140],
  ])('maps the %s facet to %i cm', async (facetId, expected) => {
    const entities = await stubbedPark({height: [{id: facetId}]}).getEntities();
    const tag = entities.find((e) => e.id === 'P1RA00')?.tags?.[0];

    expect(tag?.tag).toBe('MINIMUM_HEIGHT');
    expect(tag?.value).toEqual({height: expected, unit: 'cm'});
  });

  it('ignores the localised value string in favour of the facet id', async () => {
    // The same facet reads "1,20 m" under a French market.
    const entities = await stubbedPark({
      height: [{id: '1_20m', value: '1,20 m'}],
    }).getEntities();

    expect(entities.find((e) => e.id === 'P1RA00')?.tags?.[0].value).toEqual({height: 120, unit: 'cm'});
  });

  it('accepts a height right on the sanity bound', async () => {
    const entities = await stubbedPark({height: [{id: '300cm'}]}).getEntities();
    expect(entities.find((e) => e.id === 'P1RA00')?.tags?.[0].value).toEqual({height: 300, unit: 'cm'});
  });

  it.each([
    'anyHeight',
    '',
    '   ',
    '0cm',
    '0_00m',
    '-5cm',
    '301cm',
    '999999cm',
    '9_99m',
    '1e3cm',
    '81CM',
    ' 81cm ',
    'PhotoPass',
    '36in',
    '1_20',
    '1_2_3m',
    'm',
  ])('emits no height tag for the "%s" facet', async (facetId) => {
    expect(await tagsOf({height: [{id: facetId}]})).toEqual([]);
  });

  it('emits a single height tag, taking the first parseable facet', async () => {
    const entities = await stubbedPark({
      height: [{id: 'anyHeight'}, {id: '1_02m'}, {id: '1_40m'}],
    }).getEntities();
    const tags = entities.find((e) => e.id === 'P1RA00')?.tags ?? [];

    expect(tags).toHaveLength(1);
    expect(tags[0].value).toEqual({height: 102, unit: 'cm'});
  });

  // === Remaining tags ===

  it('maps expectantMothersMayNotRide to UNSUITABLE_PREGNANT', async () => {
    expect(await tagsOf({
      physicalConsiderations: [{id: 'mustBeInGoodHealth'}, {id: 'expectantMothersMayNotRide'}],
    })).toEqual(['UNSUITABLE_PREGNANT']);
  });

  it('ignores physical considerations that have no matching tag', async () => {
    expect(await tagsOf({
      physicalConsiderations: [{id: 'mustBeInGoodHealth'}, {id: 'typesOfLimbImpairement'}],
    })).toEqual([]);
  });

  it('maps the singleRider flag to SINGLE_RIDER', async () => {
    expect(await tagsOf({singleRider: true})).toEqual(['SINGLE_RIDER']);
    expect(await tagsOf({singleRider: false})).toEqual([]);
  });

  it('maps the Premier Access interest to PAID_RETURN_TIME', async () => {
    expect(await tagsOf({
      interests: [{id: 'orion'}, {id: 'disney-premier-access-one'}],
    })).toEqual(['PAID_RETURN_TIME']);
  });

  it('maps guestMayGetSplashed to MAY_GET_WET', async () => {
    expect(await tagsOf({interests: [{id: 'guestMayGetSplashed'}]})).toEqual(['MAY_GET_WET']);
  });

  it('maps PhotoPass to ONRIDE_PHOTO', async () => {
    expect(await tagsOf({interests: [{id: 'PhotoPass'}]})).toEqual(['ONRIDE_PHOTO']);
  });

  it('ignores interests that have no matching tag', async () => {
    expect(await tagsOf({
      interests: [{id: 'funForLittleOnes'}, {id: 'notToBeMissed'}, {id: 'bigThrills'}],
    })).toEqual([]);
  });

  it('emits every applicable tag at once', async () => {
    expect(await tagsOf({
      height: [{id: '1_02m'}],
      physicalConsiderations: [{id: 'expectantMothersMayNotRide'}],
      singleRider: true,
      interests: [{id: 'disney-premier-access-one'}, {id: 'guestMayGetSplashed'}, {id: 'PhotoPass'}],
    })).toEqual([
      'MINIMUM_HEIGHT',
      'UNSUITABLE_PREGNANT',
      'SINGLE_RIDER',
      'PAID_RETURN_TIME',
      'MAY_GET_WET',
      'ONRIDE_PHOTO',
    ]);
  });

  // === Malformed input ===

  it.each([
    ['null lists', {height: null, physicalConsiderations: null, interests: null}],
    ['empty lists', {height: [], physicalConsiderations: [], interests: []}],
    ['null list entries', {height: [null], physicalConsiderations: [null], interests: [null]}],
    ['entries without an id', {height: [{}], physicalConsiderations: [{}], interests: [{}]}],
    ['non-string ids', {height: [{id: 120}], physicalConsiderations: [{id: 1}], interests: [{id: 1}]}],
    ['strings where lists belong', {height: '1_20m', physicalConsiderations: 'x', interests: 'PhotoPass'}],
    ['objects where lists belong', {height: {id: '1_20m'}, physicalConsiderations: {}, interests: {id: 'PhotoPass'}}],
    ['numbers where lists belong', {height: 120, physicalConsiderations: 1, interests: 1}],
    ['a non-boolean singleRider', {singleRider: 'yes'}],
  ])('survives %s', async (_label, attraction) => {
    expect(await tagsOf(attraction)).toEqual([]);
  });

  it('emits one tag when the feed repeats a facet', async () => {
    expect(await tagsOf({
      height: [{id: '1_02m'}, {id: '1_02m'}],
      interests: [{id: 'PhotoPass'}, {id: 'PhotoPass'}],
    })).toEqual(['MINIMUM_HEIGHT', 'ONRIDE_PHOTO']);
  });
});

import {describe, test, expect, beforeEach, afterEach} from 'vitest';
import {WalibiBelgium} from '../walibi.js';
import {CacheLib} from '../../../cache.js';
import type {HTTPObj} from '../../../http.js';

/**
 * Restaurants have no stable id in the API, so their entity id is the last
 * segment of the CMS path. The CMS builds that segment from the display name
 * and does not sanitise it: "Pêche & Mignon" becomes `p-che-&-mignon`, and the
 * `&` fails the harness id charset (`/^[\w.-]+$/`). Because validation runs
 * over the whole list, that single restaurant made getEntities() throw — every
 * Walibi Belgium entity, rides included, was rejected with it.
 */
const restaurant = (title: string, slug: string) => ({
  title,
  path: `/content/dam/wbe/nl/restaurants/${slug}-files/${slug}`,
});

function stubbedPark(restaurants: any[]): WalibiBelgium {
  const park = new WalibiBelgium();
  park.fetchAttractions = (async () => ({json: async () => []} as any as HTTPObj)) as any;
  park.getRestaurants = async () => restaurants;
  park.getWaitTimes = async () => [];
  return park;
}

describe('WalibiBase.buildEntityList — restaurant ids from CMS paths', () => {
  beforeEach(() => CacheLib.clear());
  afterEach(() => CacheLib.clear());

  test('sanitises a CMS slug the id charset rejects, without dropping the entity', async () => {
    const entities = await stubbedPark([
      restaurant('Pêche & Mignon', 'p-che-&-mignon'),
      restaurant('Crêpes Corner', 'crepes-corner'),
    ]).getEntities();

    const names = entities.filter(e => e.entityType === 'RESTAURANT').map(e => e.name);
    expect(names).toEqual(['Pêche & Mignon', 'Crêpes Corner']);

    for (const entity of entities) {
      expect(entity.id).toMatch(/^[\w.-]+$/);
    }
  });

  test('leaves already-clean slugs untouched, so existing ids do not shift', async () => {
    const entities = await stubbedPark([restaurant('Crêpes Corner', 'crepes-corner')]).getEntities();

    expect(entities.find(e => e.entityType === 'RESTAURANT')?.id).toBe('dining_crepes-corner');
  });

  test('a slug made entirely of rejected characters yields no entity rather than a bare prefix', async () => {
    const entities = await stubbedPark([
      restaurant('???', '&&&'),
      restaurant('Crêpes Corner', 'crepes-corner'),
    ]).getEntities();

    const dining = entities.filter(e => e.entityType === 'RESTAURANT');
    expect(dining.map(e => e.id)).toEqual(['dining_crepes-corner']);
  });
});

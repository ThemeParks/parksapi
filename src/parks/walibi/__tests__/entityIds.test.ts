import {describe, test, expect, beforeEach, afterEach} from 'vitest';
import {WalibiBelgium} from '../walibi.js';
import {CacheLib} from '../../../cache.js';
import type {HTTPObj} from '../../../http.js';

/**
 * Restaurants have no stable id in the API, so their entity id is the last
 * segment of the CMS path. The CMS builds that segment from the display name
 * and does not sanitise it: "Pêche & Mignon" becomes `p-che-&-mignon`.
 *
 * That id publishes fine today — `Destination.getEntities()` does no id
 * validation, and `dining_p-che-&-mignon` is a live record. What it breaks is
 * `npm run dev -- walibibelgium`: the charset check at `src/testRunner.ts:151`
 * runs over the whole entity list, so one bad restaurant rejects every Walibi
 * Belgium entity, rides included. Sanitising it is therefore a *rename* of a
 * live record, not a rescue.
 *
 * The flip side is that ids the charset already accepts must not move —
 * including the trailing hyphens the CMS emits (`stardocks-caf-`,
 * `wild-rock-caf-`, both live on Walibi Rhône-Alpes). Renaming those would
 * mint new wiki records and orphan their history.
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

    const dining = entities.filter(e => e.entityType === 'RESTAURANT');
    expect(dining.map(e => e.name)).toEqual(['Pêche & Mignon', 'Crêpes Corner']);
    // Only the `&` is replaced, so the hyphens around it survive:
    // `dining_p-che-&-mignon` becomes `dining_p-che---mignon`. Ugly, but it is
    // the rename with the smallest blast radius, and it is the id the wiki
    // record has to be repointed to.
    expect(dining[0].id).toBe('dining_p-che---mignon');

    for (const entity of entities) {
      expect(entity.id).toMatch(/^[\w.-]+$/);
    }
  });

  test('leaves a trailing-hyphen slug untouched, so live ids do not shift', async () => {
    // `stardocks-caf-` and `wild-rock-caf-` are published today. A trailing
    // hyphen is legal under /^[\w.-]+$/, so trimming it would rename them.
    const entities = await stubbedPark([
      restaurant('Stardocks Café', 'stardocks-caf-'),
      restaurant('Wild Rock Café', 'wild-rock-caf-'),
      restaurant('Crêpes Corner', 'crepes-corner'),
    ]).getEntities();

    expect(entities.filter(e => e.entityType === 'RESTAURANT').map(e => e.id)).toEqual([
      'dining_stardocks-caf-',
      'dining_wild-rock-caf-',
      'dining_crepes-corner',
    ]);
  });

  test('keeps slugs distinct when they differ only in hyphens', async () => {
    // Collapsing or trimming hyphen runs would land these on one id and
    // silently merge two venues into a single entity.
    const entities = await stubbedPark([
      restaurant('Café Rouge', 'cafe--rouge'),
      restaurant('Cafe Rouge Express', 'cafe-rouge'),
    ]).getEntities();

    const ids = entities.filter(e => e.entityType === 'RESTAURANT').map(e => e.id);
    expect(ids).toEqual(['dining_cafe--rouge', 'dining_cafe-rouge']);
    expect(new Set(ids).size).toBe(2);
  });

  test('a slug made entirely of rejected characters still publishes, rather than leaving a stale row', async () => {
    const entities = await stubbedPark([
      restaurant('???', '&&&'),
      restaurant('Crêpes Corner', 'crepes-corner'),
    ]).getEntities();

    const dining = entities.filter(e => e.entityType === 'RESTAURANT');
    expect(dining.map(e => e.id)).toEqual(['dining_-', 'dining_crepes-corner']);
    for (const entity of entities) {
      expect(entity.id).toMatch(/^[\w.-]+$/);
    }
  });
});

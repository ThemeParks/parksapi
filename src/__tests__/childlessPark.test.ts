import {describe, it, expect} from 'vitest';
import {Destination} from '../destination.js';
import {Entity} from '@themeparks/typelib';

/**
 * The collapsed-list guard (entityListCollapse.test.ts) only fires when a whole
 * destination has nothing but structure. A destination that serves several
 * parks from one class can lose one park's roster while the others are fine:
 * the list still has rides in it, so it passes, and every ride in the failed
 * park reads downstream as removed.
 *
 * So every PARK must have at least one entity beneath it. A park that
 * legitimately publishes nothing (one that exists to carry opening hours) is
 * named in `allowEmptyParks` on its class, park by park, so the check keeps
 * covering every other park the class builds.
 */
const DESTINATION: Entity = {
  id: 'dest', name: 'Test Resort', entityType: 'DESTINATION', timezone: 'Europe/London',
} as Entity;
const park = (id: string): Entity => ({
  id, name: `Park ${id}`, entityType: 'PARK', parentId: 'dest', destinationId: 'dest',
  timezone: 'Europe/London',
} as Entity);
const ride = (id: string, parentId: string): Entity => ({
  id, name: `Ride ${id}`, entityType: 'ATTRACTION', parentId,
  destinationId: 'dest', timezone: 'Europe/London',
} as Entity);

class TestResort extends Destination {
  constructor(
    private readonly entities: Entity[],
    opts: {allowEmptyParks?: string[]; allowEmptyEntityList?: boolean} = {},
  ) {
    super();
    if (opts.allowEmptyParks) (this as any).allowEmptyParks = opts.allowEmptyParks;
    if (opts.allowEmptyEntityList) (this as any).allowEmptyEntityList = true;
  }
  async getDestinations(): Promise<Entity[]> { return [DESTINATION]; }
  protected async buildEntityList(): Promise<Entity[]> { return this.entities; }
  protected async buildLiveData(): Promise<any[]> { return []; }
  protected async buildSchedules(): Promise<any[]> { return []; }
}

describe('park with no children', () => {
  it('publishes when every park has something in it', async () => {
    const entities = await new TestResort([
      park('a'), ride('a1', 'a'), park('b'), ride('b1', 'b'),
    ]).getEntities();
    expect(entities).toHaveLength(5);
  });

  // The shape a single failed fetch leaves behind in a multi-park class: one
  // park's rides gone, the other park's still there.
  it('refuses a list where one park lost its roster', async () => {
    await expect(new TestResort([
      park('a'), ride('a1', 'a'), park('b'),
    ]).getEntities()).rejects.toThrow(/park b .*no attractions, restaurants or shows/i);
  });

  it('names every empty park and the class', async () => {
    const build = new TestResort([park('a'), ride('a1', 'a'), park('b'), park('c')]).getEntities();
    await expect(build).rejects.toThrow(/TestResort/);
    await expect(
      new TestResort([park('a'), ride('a1', 'a'), park('b'), park('c')]).getEntities(),
    ).rejects.toThrow(/b, c/);
  });

  // A ride in a land in a park belongs to the park: children are counted
  // through the resolved hierarchy, not by direct parentId.
  it('counts an entity nested under an intermediate parent', async () => {
    const land = {...ride('land', 'a'), entityType: 'ATTRACTION', name: 'Land'} as Entity;
    const nested = ride('deep', 'land');
    const entities = await new TestResort([park('a'), land, nested]).getEntities();
    expect(entities.find((e) => e.id === 'deep')?.parkId).toBe('a');
  });

  it('does not count an entity that hangs off the destination', async () => {
    await expect(new TestResort([
      park('a'), ride('hotel', 'dest'),
    ]).getEntities()).rejects.toThrow(/park a/i);
  });

  it('lets a class name the parks that may be empty', async () => {
    const entities = await new TestResort(
      [park('a'), ride('a1', 'a'), park('b')],
      {allowEmptyParks: ['b']},
    ).getEntities();
    expect(entities.map((e) => e.id).sort()).toEqual(['a', 'a1', 'b', 'dest']);
  });

  // Naming one park does not switch the check off for its siblings.
  it('still checks the parks a class did not name', async () => {
    await expect(new TestResort(
      [park('a'), ride('a1', 'a'), park('b'), park('c')],
      {allowEmptyParks: ['b']},
    ).getEntities()).rejects.toThrow(/park c/i);
  });

  it('is skipped for a destination that opted out of having content at all', async () => {
    const entities = await new TestResort([park('a')], {allowEmptyEntityList: true}).getEntities();
    expect(entities.map((e) => e.id).sort()).toEqual(['a', 'dest']);
  });

  it('throws rather than returning the partial list', async () => {
    let returned: Entity[] | undefined;
    try {
      returned = await new TestResort([park('a'), ride('a1', 'a'), park('b')]).getEntities();
    } catch {
      // expected
    }
    expect(returned).toBeUndefined();
  });
});

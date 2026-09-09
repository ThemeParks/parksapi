import {describe, it, expect} from 'vitest';
import {Destination} from '../destination.js';
import {Entity} from '@themeparks/typelib';

/**
 * A destination's DESTINATION and PARK rows are built from constants, so they
 * survive an upstream failure that took every real entity with it. What is left
 * parses cleanly, validates, and reports success.
 *
 * Two destinations reached that state on 2026-09-09 by different routes: one
 * whose POI endpoint answered 200 with an empty list, one whose rides pages
 * began redirecting into a scraper that treats a failed page as an empty one.
 * The second had been publishing 3 entities against 76 for long enough that
 * every missing ride had queued for deletion downstream — and the test harness
 * called it a pass every time.
 */
const DESTINATION: Entity = {
  id: 'dest', name: 'Test Resort', entityType: 'DESTINATION', timezone: 'Europe/London',
} as Entity;
const PARK: Entity = {
  id: 'park', name: 'Test Park', entityType: 'PARK', parentId: 'dest', destinationId: 'dest',
  timezone: 'Europe/London',
} as Entity;
const RIDE: Entity = {
  id: 'ride', name: 'Test Coaster', entityType: 'ATTRACTION', parentId: 'park',
  destinationId: 'dest', timezone: 'Europe/London',
} as Entity;

class TestPark extends Destination {
  constructor(private readonly entities: Entity[], allowEmpty = false) {
    super();
    (this as any).allowEmptyEntityList = allowEmpty;
  }
  async getDestinations(): Promise<Entity[]> { return [DESTINATION]; }
  protected async buildEntityList(): Promise<Entity[]> { return this.entities; }
  protected async buildLiveData(): Promise<any[]> { return []; }
  protected async buildSchedules(): Promise<any[]> { return []; }
}

describe('collapsed entity list', () => {
  it('publishes a list that has content', async () => {
    const entities = await new TestPark([PARK, RIDE]).getEntities();
    expect(entities.map((e) => e.id).sort()).toEqual(['dest', 'park', 'ride']);
  });

  // The exact shape Mid-America Parks published: DESTINATION + PARKs, nothing else.
  it('refuses a list of nothing but structure', async () => {
    await expect(new TestPark([PARK]).getEntities()).rejects.toThrow(
      /no attractions, restaurants or shows/,
    );
  });

  // An empty build is not an empty list: getDestinations() still contributes
  // the DESTINATION row, which is exactly why the collapse is invisible.
  it('refuses an empty build, which still carries the destination row', async () => {
    await expect(new TestPark([]).getEntities()).rejects.toThrow(
      /no attractions, restaurants or shows — only DESTINATION/,
    );
  });

  it('refuses a destination that produced literally nothing', async () => {
    class Silent extends TestPark {
      async getDestinations(): Promise<Entity[]> { return []; }
    }
    await expect(new Silent([]).getEntities()).rejects.toThrow(/nothing at all/);
  });

  it('names the destination and what it did produce', async () => {
    await expect(new TestPark([PARK]).getEntities()).rejects.toThrow(/TestPark/);
    await expect(new TestPark([PARK]).getEntities()).rejects.toThrow(/DESTINATION, PARK/);
  });

  it('lets a destination opt out when it genuinely has no content', async () => {
    const entities = await new TestPark([PARK], true).getEntities();
    expect(entities.map((e) => e.id).sort()).toEqual(['dest', 'park']);
  });

  // One real entity of any visitable type is enough — the guard is a floor
  // against total collapse, not a quality bar on how much a park publishes.
  it.each(['ATTRACTION', 'RESTAURANT', 'SHOW', 'HOTEL'])(
    'accepts a list whose only content is a %s',
    async (entityType) => {
      const one = {...RIDE, entityType} as Entity;
      const entities = await new TestPark([PARK, one]).getEntities();
      expect(entities).toHaveLength(3);
    },
  );

  // Throwing is the point: the collector is upsert-only, so a truncated list
  // does not under-report, it proposes deleting everything missing from it.
  // An error skips the poll and leaves the last good list standing.
  it('throws rather than returning the truncated list', async () => {
    let returned: Entity[] | undefined;
    try {
      returned = await new TestPark([PARK]).getEntities();
    } catch {
      // expected
    }
    expect(returned).toBeUndefined();
  });
});

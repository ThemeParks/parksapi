import {describe, test, expect} from 'vitest';
import {Destination} from '../destination.js';
import type {Entity, LiveData, EntitySchedule} from '@themeparks/typelib';

/**
 * A source that stops refreshing can keep answering with its last snapshot,
 * and nothing in the live data it yields shows it. Where a feed carries its
 * own generation time, a destination records it per park so a caller can
 * tell how old the upstream data already was when it was read.
 */
class StampedPark extends Destination {
  public stamps: Array<{park: string; observedAt: number | Date; readAt?: number | Date}> = [];
  protected async buildEntityList(): Promise<Entity[]> { return []; }
  protected async buildSchedules(): Promise<EntitySchedule[]> { return []; }
  async getDestinations(): Promise<Entity[]> { return []; }
  protected async buildLiveData(): Promise<LiveData[]> {
    for (const s of this.stamps) this.recordSourceObservedAt(s.park, s.observedAt, s.readAt);
    return [];
  }
}

class UnstampedPark extends Destination {
  protected async buildEntityList(): Promise<Entity[]> { return []; }
  protected async buildSchedules(): Promise<EntitySchedule[]> { return []; }
  async getDestinations(): Promise<Entity[]> { return []; }
  protected async buildLiveData(): Promise<LiveData[]> { return []; }
}

const OBSERVED = Date.parse('2026-09-21T17:03:00Z');
const READ = Date.parse('2026-09-26T16:00:00Z');

describe('getSourceObservations', () => {
  test('is empty for a destination whose source carries no stamp', async () => {
    const park = new UnstampedPark();
    await park.getLiveData();
    expect(park.getSourceObservations()).toEqual([]);
  });

  test('is empty before the first live build', () => {
    expect(new StampedPark().getSourceObservations()).toEqual([]);
  });

  test('reports what the last build recorded, as ISO instants', async () => {
    const park = new StampedPark();
    park.stamps = [{park: 'park_a', observedAt: OBSERVED, readAt: READ}];
    await park.getLiveData();

    expect(park.getSourceObservations()).toEqual([
      {parkId: 'park_a', observedAt: '2026-09-21T17:03:00.000Z', readAt: '2026-09-26T16:00:00.000Z'},
    ]);
  });

  test('accepts Date values', async () => {
    const park = new StampedPark();
    park.stamps = [{park: 'park_a', observedAt: new Date(OBSERVED), readAt: new Date(READ)}];
    await park.getLiveData();

    expect(park.getSourceObservations()[0].observedAt).toBe('2026-09-21T17:03:00.000Z');
  });

  test('readAt defaults to the time of recording', async () => {
    const park = new StampedPark();
    park.stamps = [{park: 'park_a', observedAt: OBSERVED}];
    const before = Date.now();
    await park.getLiveData();
    const readAt = Date.parse(park.getSourceObservations()[0].readAt);

    expect(readAt).toBeGreaterThanOrEqual(before);
    expect(readAt).toBeLessThanOrEqual(Date.now());
  });

  test('keeps one entry per park, the latest reading', async () => {
    const park = new StampedPark();
    park.stamps = [{park: 'park_a', observedAt: OBSERVED, readAt: READ}];
    await park.getLiveData();
    park.stamps = [{park: 'park_a', observedAt: OBSERVED + 60_000, readAt: READ + 60_000}];
    await park.getLiveData();

    expect(park.getSourceObservations()).toEqual([
      {parkId: 'park_a', observedAt: '2026-09-21T17:04:00.000Z', readAt: '2026-09-26T16:01:00.000Z'},
    ]);
  });

  test('keeps a park the latest build did not read, with its old readAt', async () => {
    // A caller judges staleness from readAt, so a park whose fetch failed
    // this build is reported as last read, never as freshly read.
    const park = new StampedPark();
    park.stamps = [
      {park: 'park_a', observedAt: OBSERVED, readAt: READ},
      {park: 'park_b', observedAt: OBSERVED, readAt: READ},
    ];
    await park.getLiveData();
    park.stamps = [{park: 'park_b', observedAt: OBSERVED + 60_000, readAt: READ + 60_000}];
    await park.getLiveData();

    const byPark = Object.fromEntries(park.getSourceObservations().map(o => [o.parkId, o.readAt]));
    expect(byPark).toEqual({park_a: '2026-09-26T16:00:00.000Z', park_b: '2026-09-26T16:01:00.000Z'});
  });

  test.each([
    ['NaN observedAt', NaN, READ],
    ['Infinity readAt', OBSERVED, Infinity],
    ['invalid Date', new Date('nope'), READ],
  ])('ignores a non-finite reading (%s)', async (_label, observedAt, readAt) => {
    const park = new StampedPark();
    park.stamps = [{park: 'park_a', observedAt, readAt}];
    await park.getLiveData();
    expect(park.getSourceObservations()).toEqual([]);
  });

  test('ignores an empty park id', async () => {
    const park = new StampedPark();
    park.stamps = [{park: '', observedAt: OBSERVED, readAt: READ}];
    await park.getLiveData();
    expect(park.getSourceObservations()).toEqual([]);
  });

  test('returns a copy the caller cannot use to change what is recorded', async () => {
    const park = new StampedPark();
    park.stamps = [{park: 'park_a', observedAt: OBSERVED, readAt: READ}];
    await park.getLiveData();
    const first = park.getSourceObservations();
    first[0].observedAt = 'tampered';
    first.push({parkId: 'x', observedAt: '', readAt: ''});

    expect(park.getSourceObservations()).toEqual([
      {parkId: 'park_a', observedAt: '2026-09-21T17:03:00.000Z', readAt: '2026-09-26T16:00:00.000Z'},
    ]);
  });

  test('instances do not share readings', async () => {
    const a = new StampedPark();
    a.stamps = [{park: 'park_a', observedAt: OBSERVED, readAt: READ}];
    await a.getLiveData();
    expect(new StampedPark().getSourceObservations()).toEqual([]);
  });
});

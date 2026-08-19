/**
 * Drop-vs-CLOSED retirement gate (parksapi #83 / #74).
 *
 * The collector is upsert-only with no delete path: dropping an entity from
 * buildLiveData() output changes nothing, so a show that leaves the upstream
 * feed permanently freezes at its last live value forever. Confirmed
 * independently on DLP and SHDR. This is the shared, opt-in fix — a
 * destination that sets `retireMissingLiveEntities = true` gets a synthetic
 * CLOSED row written once a previously-live entity has been missing from a
 * full buildLiveData() snapshot for longer than `liveEntityRetirementMs`.
 */

import {describe, test, expect, vi, beforeEach, afterEach} from 'vitest';
import {Destination} from '../destination.js';
import config from '../config.js';
import {CacheLib} from '../cache.js';
import {Entity, LiveData} from '@themeparks/typelib';

@config
class RetiringTestDestination extends Destination {
  public liveIds: string[] = ['show1', 'show2'];
  public streamScope: ReadonlySet<string> | undefined = undefined;

  constructor(opts?: {retire?: boolean; retirementMs?: number}) {
    super();
    if (opts?.retire !== undefined) this.retireMissingLiveEntities = opts.retire;
    if (opts?.retirementMs !== undefined) this.liveEntityRetirementMs = opts.retirementMs;
  }

  protected async buildEntityList(): Promise<Entity[]> {
    return [];
  }

  protected async buildLiveData(scope?: ReadonlySet<string>): Promise<LiveData[]> {
    void scope;
    return this.liveIds.map((id) => ({id, status: 'OPERATING'} as LiveData));
  }
}

describe('live entity retirement gate', () => {
  beforeEach(() => {
    CacheLib.clearByClassName('RetiringTestDestination');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('defaults to off: a missing entity is silently dropped, not force-closed', async () => {
    const park = new RetiringTestDestination();

    park.liveIds = ['show1', 'show2'];
    await park.getLiveData();

    park.liveIds = ['show1'];
    const live = await park.getLiveData();

    expect(live.map((d) => d.id)).toEqual(['show1']);
  });

  test('an entity missing for less than the retirement window stays silently dropped', async () => {
    vi.useFakeTimers();
    const park = new RetiringTestDestination({retire: true, retirementMs: 7 * 24 * 60 * 60 * 1000});

    park.liveIds = ['show1', 'show2'];
    await park.getLiveData();

    vi.setSystemTime(Date.now() + 3 * 24 * 60 * 60 * 1000); // 3 days
    park.liveIds = ['show1'];
    const live = await park.getLiveData();

    expect(live.map((d) => d.id)).toEqual(['show1']);
  });

  test('an entity missing past the retirement window is force-closed', async () => {
    vi.useFakeTimers();
    const park = new RetiringTestDestination({retire: true, retirementMs: 7 * 24 * 60 * 60 * 1000});

    park.liveIds = ['show1', 'show2'];
    await park.getLiveData();

    vi.setSystemTime(Date.now() + 8 * 24 * 60 * 60 * 1000); // 8 days
    park.liveIds = ['show1'];
    const live = await park.getLiveData();

    const retired = live.find((d) => d.id === 'show2');
    expect(retired).toEqual({id: 'show2', status: 'CLOSED'});
    // show1 is untouched
    expect(live.find((d) => d.id === 'show1')).toEqual({id: 'show1', status: 'OPERATING'});
  });

  test('an entity that reappears before retiring is emitted normally, no synthetic row', async () => {
    vi.useFakeTimers();
    const park = new RetiringTestDestination({retire: true, retirementMs: 7 * 24 * 60 * 60 * 1000});

    park.liveIds = ['show1', 'show2'];
    await park.getLiveData();

    vi.setSystemTime(Date.now() + 3 * 24 * 60 * 60 * 1000);
    park.liveIds = ['show1'];
    await park.getLiveData();

    vi.setSystemTime(Date.now() + 3 * 24 * 60 * 60 * 1000); // 6 days total, still under threshold
    park.liveIds = ['show1', 'show2'];
    const live = await park.getLiveData();

    expect(live).toEqual([
      {id: 'show1', status: 'OPERATING'},
      {id: 'show2', status: 'OPERATING'},
    ]);
  });

  test('retirement clock resets after a reappearance', async () => {
    vi.useFakeTimers();
    const park = new RetiringTestDestination({retire: true, retirementMs: 7 * 24 * 60 * 60 * 1000});

    park.liveIds = ['show1', 'show2'];
    await park.getLiveData();

    // show2 reappears at day 6, resetting its clock
    vi.setSystemTime(Date.now() + 6 * 24 * 60 * 60 * 1000);
    park.liveIds = ['show1', 'show2'];
    await park.getLiveData();

    // 5 more days missing (11 total from first sighting, but only 5 since reappearance)
    vi.setSystemTime(Date.now() + 5 * 24 * 60 * 60 * 1000);
    park.liveIds = ['show1'];
    const live = await park.getLiveData();

    expect(live.map((d) => d.id)).toEqual(['show1']);
  });

  test('a partial (scoped) build is never subject to retirement, even past the window', async () => {
    vi.useFakeTimers();
    const park = new RetiringTestDestination({retire: true, retirementMs: 7 * 24 * 60 * 60 * 1000});

    park.liveIds = ['show1', 'show2'];
    await park.getLiveData();

    vi.setSystemTime(Date.now() + 30 * 24 * 60 * 60 * 1000);
    park.liveIds = ['show1'];
    const live = await park.getLiveData(new Set(['show1']));

    expect(live.map((d) => d.id)).toEqual(['show1']);
  });
});

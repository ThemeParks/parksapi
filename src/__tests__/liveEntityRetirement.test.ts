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
    // Absence has to corroborate across consecutive polls, not just age.
    await park.getLiveData();
    await park.getLiveData();
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

  /**
   * The age clock is wall-clock and nothing advances it while the source is
   * down, so an outage longer than the window leaves every timestamp stale.
   * Without corroboration the first poll to succeed afterwards would retire
   * everything missing from that single sample.
   */
  describe('corroboration', () => {
    test('one poll after a long outage does not retire on its own', async () => {
      vi.useFakeTimers();
      const park = new RetiringTestDestination({retire: true, retirementMs: 7 * 24 * 60 * 60 * 1000});

      park.liveIds = ['show1', 'show2'];
      await park.getLiveData();

      // Collector down for a month, then one successful poll that happens to
      // be missing show2.
      vi.setSystemTime(Date.now() + 30 * 24 * 60 * 60 * 1000);
      park.liveIds = ['show1'];
      const live = await park.getLiveData();

      expect(live.map((d) => d.id)).toEqual(['show1']);
    });

    test('a reappearance resets the miss count, so the count must be consecutive', async () => {
      vi.useFakeTimers();
      const park = new RetiringTestDestination({retire: true, retirementMs: 7 * 24 * 60 * 60 * 1000});

      park.liveIds = ['show1', 'show2'];
      await park.getLiveData();
      vi.setSystemTime(Date.now() + 8 * 24 * 60 * 60 * 1000);

      park.liveIds = ['show1'];
      await park.getLiveData();
      await park.getLiveData();

      // Blips back into the feed, then goes again: the two misses above are
      // spent, so this poll is only the first of a fresh run.
      park.liveIds = ['show1', 'show2'];
      await park.getLiveData();
      park.liveIds = ['show1'];
      const live = await park.getLiveData();

      expect(live.map((d) => d.id)).toEqual(['show1']);
    });
  });

  /**
   * A well-formed but gutted payload parses cleanly and never throws, so the
   * gate has to recognise a collapse for what it is rather than publishing a
   * confident CLOSED for every entity at an open park.
   */
  describe('degraded-feed guard', () => {
    test('withholds every retirement when most of the tracked set vanishes at once', async () => {
      vi.useFakeTimers();
      const park = new RetiringTestDestination({retire: true, retirementMs: 7 * 24 * 60 * 60 * 1000});
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      park.liveIds = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
      await park.getLiveData();

      vi.setSystemTime(Date.now() + 8 * 24 * 60 * 60 * 1000);
      park.liveIds = ['a'];
      await park.getLiveData();
      await park.getLiveData();
      const live = await park.getLiveData();

      expect(live.map((d) => d.id)).toEqual(['a']);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('withholding 9 live-entity retirements'));
      warn.mockRestore();
    });

    test('a minority retiring is still closed normally', async () => {
      vi.useFakeTimers();
      const park = new RetiringTestDestination({retire: true, retirementMs: 7 * 24 * 60 * 60 * 1000});

      park.liveIds = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
      await park.getLiveData();

      vi.setSystemTime(Date.now() + 8 * 24 * 60 * 60 * 1000);
      park.liveIds = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
      await park.getLiveData();
      await park.getLiveData();
      const live = await park.getLiveData();

      expect(live.filter((d) => d.status === 'CLOSED').map((d) => d.id).sort()).toEqual(['h', 'i', 'j']);
    });

    test('a small destination can still retire most of its entities', async () => {
      vi.useFakeTimers();
      const park = new RetiringTestDestination({retire: true, retirementMs: 7 * 24 * 60 * 60 * 1000});

      park.liveIds = ['show1', 'show2', 'show3'];
      await park.getLiveData();

      vi.setSystemTime(Date.now() + 8 * 24 * 60 * 60 * 1000);
      park.liveIds = ['show1'];
      await park.getLiveData();
      await park.getLiveData();
      const live = await park.getLiveData();

      expect(live.filter((d) => d.status === 'CLOSED').map((d) => d.id).sort()).toEqual(['show2', 'show3']);
    });
  });

  /**
   * Nothing here can see whether a build was delivered, and the send path
   * diffs the current build rather than holding a retry queue, so a close
   * emitted once and dropped would be lost for good.
   */
  test('a retired entity keeps being closed while it stays absent', async () => {
    vi.useFakeTimers();
    const park = new RetiringTestDestination({retire: true, retirementMs: 7 * 24 * 60 * 60 * 1000});

    park.liveIds = ['show1', 'show2'];
    await park.getLiveData();

    vi.setSystemTime(Date.now() + 8 * 24 * 60 * 60 * 1000);
    park.liveIds = ['show1'];
    await park.getLiveData();
    await park.getLiveData();
    const closing = await park.getLiveData();
    expect(closing.find((d) => d.id === 'show2')).toEqual({id: 'show2', status: 'CLOSED'});

    // A push that never landed must not have destroyed the only close.
    const after = await park.getLiveData();
    expect(after.find((d) => d.id === 'show2')).toEqual({id: 'show2', status: 'CLOSED'});
  });

  /**
   * The withhold path still increments misses for everything it declined to
   * close. Left banked, a partial recovery that drops the eligible set under
   * the threshold fires them all at once on corroboration gathered entirely
   * while the gate was saying the feed could not be trusted.
   */
  /**
   * Zeroing the counts on the withheld build is not enough on its own. The
   * reset only happens on builds where eligibility is reached, so whether a
   * partial recovery publishes a wrong CLOSED came down to which beat of the
   * cycle it landed on — one timing in three still fired, on misses accrued
   * entirely inside the window the gate had declared untrustworthy. The
   * cooldown is what makes it hold for every timing.
   */
  test.each([5, 6, 7, 8, 9, 10, 11, 12])(
    'a partial recovery after %i collapsed builds never fires on evidence from the untrusted window',
    async (collapseBuilds) => {
      vi.useFakeTimers();
      const park = new RetiringTestDestination({retire: true, retirementMs: 7 * 24 * 60 * 60 * 1000});
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      park.liveIds = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
      await park.getLiveData();

      vi.setSystemTime(Date.now() + 8 * 24 * 60 * 60 * 1000);
      park.liveIds = ['a'];
      for (let i = 0; i < collapseBuilds; i++) await park.getLiveData();

      // Partial recovery, which is how these incidents usually end: enough
      // returns that the eligible set drops back under the threshold.
      park.liveIds = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
      const live = await park.getLiveData();

      expect(live.filter((d) => d.status === 'CLOSED')).toEqual([]);
      warn.mockRestore();
    },
  );

  /**
   * A guard reading the set it is about to close cannot see a collapse until
   * the collapse has outlived the retirement window, because eligibility
   * needs that window to elapse first. A feed that recovers within one poll
   * of that moment therefore never gets looked at, and whatever is still
   * missing gets closed on misses accrued entirely inside the outage. At
   * Universal's overnight cadence that vulnerable band is one 45-minute poll
   * wide, so it is reachable roughly one collapse in five.
   *
   * Judging on raw absence instead arms the cooldown from the first build of
   * the collapse, hours before the age window opens.
   */
  test.each(Array.from({length: 14}, (_, i) => i + 1))(
    'a collapse lasting %i polls never force-closes the stragglers on recovery',
    async (polls) => {
      vi.useFakeTimers();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const POLL = 45 * 60 * 1000;
      const all = Array.from({length: 65}, (_, i) => `ride${i}`);
      const park = new RetiringTestDestination({retire: true, retirementMs: 4 * 60 * 60 * 1000});

      park.liveIds = all;
      await park.getLiveData();

      // Feed guts itself to a single row and stays there.
      park.liveIds = ['ride0'];
      for (let i = 0; i < polls; i++) {
        vi.setSystemTime(Date.now() + POLL);
        await park.getLiveData();
      }

      // Recovers all but three.
      park.liveIds = all.slice(0, 62);
      vi.setSystemTime(Date.now() + POLL);
      const live = await park.getLiveData();

      expect(live.filter((d) => d.status === 'CLOSED')).toEqual([]);
      vi.restoreAllMocks();
      void warn;
    },
  );

  /**
   * Arming off a single sample would make the gate hostage to any source that
   * legitimately sheds most of its rows on the odd build — it would mute
   * itself for a full window each time, and a real retirement arriving in
   * that window would be withheld. The collapse has to hold before the
   * cooldown arms.
   */
  test('a one-build blip does not mute the gate against a genuine retirement', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const all = Array.from({length: 10}, (_, i) => `ride${i}`);
    const park = new RetiringTestDestination({retire: true, retirementMs: 4 * 60 * 60 * 1000});

    park.liveIds = all;
    await park.getLiveData();

    // ride9 leaves and builds up its misses, but is not eligible yet.
    vi.setSystemTime(Date.now() + 3.5 * 60 * 60 * 1000);
    park.liveIds = all.slice(0, 9);
    await park.getLiveData();
    await park.getLiveData();

    // A single degraded sample lands here, then the feed recovers. Arming off
    // one sample would start a cooldown that is still running when ride9
    // becomes eligible shortly afterwards.
    park.liveIds = ['ride0'];
    await park.getLiveData();
    park.liveIds = all.slice(0, 9);
    await park.getLiveData();

    // ride9 crosses the window half an hour later, inside that cooldown.
    vi.setSystemTime(Date.now() + 0.6 * 60 * 60 * 1000);
    const live = await park.getLiveData();

    expect(live.find((d) => d.id === 'ride9')).toEqual({id: 'ride9', status: 'CLOSED'});
    vi.restoreAllMocks();
    void warn;
  });

  /**
   * A permanently dead id must stop counting as evidence. Otherwise ids
   * accumulated across seasons eventually exceed the degraded-feed threshold
   * on every build, the guard trips for good, and the gate silently stops
   * working — the original freeze, returned, with only a warn to show for it.
   */
  test('seasonal ids retiring year after year do not accumulate into a permanent withhold', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const park = new RetiringTestDestination({retire: true, retirementMs: 4 * 60 * 60 * 1000});
    const yearRound = Array.from({length: 20}, (_, i) => `ride${i}`);

    for (let season = 0; season < 4; season++) {
      const houses = Array.from({length: 15}, (_, i) => `s${season}_house${i}`);

      // Event runs: houses live alongside the year-round rides.
      park.liveIds = [...yearRound, ...houses];
      await park.getLiveData();

      // Season ends: houses gone for good.
      vi.setSystemTime(Date.now() + 5 * 60 * 60 * 1000);
      park.liveIds = yearRound;
      await park.getLiveData();
      await park.getLiveData();
      const live = await park.getLiveData();

      const closed = live.filter((d) => d.status === 'CLOSED').map((d) => d.id);
      expect(closed.sort()).toEqual(houses.sort());

      // A year passes before the next season.
      vi.setSystemTime(Date.now() + 365 * 24 * 60 * 60 * 1000);
      park.liveIds = yearRound;
      await park.getLiveData();
    }

    expect(warn).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  test('a retired entity stops being repeated once the repeat window elapses', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const park = new RetiringTestDestination({retire: true, retirementMs: 7 * 24 * 60 * 60 * 1000});

    park.liveIds = ['show1', 'show2'];
    await park.getLiveData();

    vi.setSystemTime(Date.now() + 8 * 24 * 60 * 60 * 1000);
    park.liveIds = ['show1'];
    await park.getLiveData();
    await park.getLiveData();
    const closing = await park.getLiveData();
    expect(closing.find((d) => d.id === 'show2')).toEqual({id: 'show2', status: 'CLOSED'});

    // Still repeated a day later, so a dropped push recovers.
    vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1000);
    const soon = await park.getLiveData();
    expect(soon.find((d) => d.id === 'show2')).toEqual({id: 'show2', status: 'CLOSED'});

    // Past the repeat window it is forgotten rather than repeated forever.
    vi.setSystemTime(Date.now() + 4 * 24 * 60 * 60 * 1000);
    const later = await park.getLiveData();
    expect(later.map((d) => d.id)).toEqual(['show1']);
    vi.restoreAllMocks();
  });

  test('reads the flat id-to-timestamp map written before miss counting existed', async () => {
    vi.useFakeTimers();
    const park = new RetiringTestDestination({retire: true, retirementMs: 7 * 24 * 60 * 60 * 1000});

    // Shape a deployed 400-day cache still holds.
    CacheLib.set('RetiringTestDestination:liveEntityRetirement', {show2: Date.now()}, 400 * 24 * 60 * 60);

    vi.setSystemTime(Date.now() + 8 * 24 * 60 * 60 * 1000);
    park.liveIds = ['show1'];
    await park.getLiveData();
    await park.getLiveData();
    const live = await park.getLiveData();

    expect(live.find((d) => d.id === 'show2')).toEqual({id: 'show2', status: 'CLOSED'});
  });
});

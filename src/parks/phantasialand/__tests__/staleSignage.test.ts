import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {Phantasialand} from '../phantasialand.js';

/**
 * The signage feed rewrites its whole snapshot every couple of minutes under
 * one shared timestamp, and never prunes rows for venues it has stopped
 * reporting on. Those rows keep their last observed state indefinitely.
 *
 * Live, that meant Mystic Winter Castle published OPERATING with nine
 * showtimes dated February, all summer, and Tiempo de Fuego published
 * showtimes dated 2021. A stale row is emitted as a bare CLOSED, which
 * clears the frozen content once and then stops changing.
 *
 * `buildLiveData` reads only `getSignage()`, so these stub nothing else —
 * an earlier draft stubbed `getPOI` too and every one of those fixtures was
 * dead code.
 */
const NOW = new Date('2026-08-14T10:00:00Z');

/** Time `hoursAgo` before the pinned now, ISO. */
const at = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * 3600_000).toISOString();

/** A signage row whose three timestamps all sit at the same age. */
function row(poiId: number, hoursAgo: number, state: Record<string, unknown> = {}) {
  const stamp = at(hoursAgo);
  return {
    poiId: String(poiId),
    updatedAt: stamp,
    createdAt: stamp,
    updatedRow: stamp,
    waitTime: null,
    open: null,
    showTimes: null,
    ...state,
  };
}

/**
 * The canary: a genuinely fresh row that must survive intact in every test.
 * Aged two minutes to match the real feed's cadence, so a regression that
 * tightened the threshold cannot leave it standing.
 */
const CANARY_AGE_H = 2 / 60;
const canary = () => row(60, CANARY_AGE_H, {waitTime: 25, open: true});

function stubbedPark(signage: any[]): Phantasialand {
  const park = new Phantasialand();
  vi.spyOn(park as any, 'getSignage').mockResolvedValue([canary(), ...signage]);
  return park;
}

async function live(park: Phantasialand) {
  const rows = await park.getLiveData();
  expect(rows.find((l) => l.id === '60')).toMatchObject({
    status: 'OPERATING',
    queue: {STANDBY: {waitTime: 25}},
  });
  return rows;
}

/** A stale row must publish CLOSED and nothing else. */
function expectRetired(rows: any[], id: string) {
  const found = rows.find((l) => l.id === id);
  expect(found).toBeDefined();
  expect(found.status).toBe('CLOSED');
  expect(found.showtimes).toBeUndefined();
  expect(found.queue).toBeUndefined();
}

describe('Phantasialand stale signage rows', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('retiring a stale row', () => {
    it('clears showtimes a stale row was still advertising', async () => {
      // Mystic Winter Castle: OPERATING with nine February showtimes, in August.
      const rows = await live(stubbedPark([
        row(223, 4055, {showTimes: ['2026-02-26 20:00:00', '2026-02-26 21:00:00']}),
      ]));
      expectRetired(rows, '223');
    });

    it('clears a stale wait time rather than restating it as current', async () => {
      const rows = await live(stubbedPark([row(225, 10077, {waitTime: 40, open: true})]));
      expectRetired(rows, '225');
    });

    it('retires a stale row that already read closed', async () => {
      // Staleness is about the observation, not which way it happens to read.
      const rows = await live(stubbedPark([row(78, 12501, {open: false})]));
      expectRetired(rows, '78');
    });

    it('emits exactly one row per stale entry', async () => {
      const rows = await live(stubbedPark([row(223, 4055, {showTimes: ['2026-02-26 20:00:00']})]));
      expect(rows.filter((l) => l.id === '223')).toHaveLength(1);
    });
  });

  describe('keeping a fresh row', () => {
    it('keeps a row from earlier the same day', async () => {
      const rows = await live(stubbedPark([row(52, 6, {waitTime: 5, open: true})]));
      expect(rows.find((l) => l.id === '52')).toMatchObject({
        status: 'OPERATING',
        queue: {STANDBY: {waitTime: 5}},
      });
    });

    it('publishes showtimes from a fresh show row', async () => {
      const rows = await live(stubbedPark([
        row(194, 0.5, {showTimes: ['2026-08-14 19:30:00']}),
      ]));
      expect(rows.find((l) => l.id === '194')).toMatchObject({status: 'OPERATING'});
      expect(rows.find((l) => l.id === '194')?.showtimes).toHaveLength(1);
    });

    it('keeps a row sitting exactly on the threshold', async () => {
      const rows = await live(stubbedPark([row(52, 168, {waitTime: 5, open: true})]));
      expect(rows.find((l) => l.id === '52')?.queue).toBeDefined();
    });

    it('retires a row a millisecond past the threshold', async () => {
      const stamp = new Date(NOW.getTime() - (168 * 3600_000 + 1)).toISOString();
      const rows = await live(stubbedPark([
        {poiId: '52', updatedAt: stamp, createdAt: stamp, updatedRow: stamp, waitTime: 5, open: true},
      ]));
      expectRetired(rows, '52');
    });
  });

  describe('reading the timestamps', () => {
    it('uses createdAt when it is the newest, as the real feed has it', async () => {
      // Real ordering is updatedAt < createdAt = updatedRow.
      const rows = await live(stubbedPark([{
        poiId: '52',
        updatedAt: at(4055),
        createdAt: at(0.5),
        updatedRow: at(4055),
        waitTime: 5,
        open: true,
      }]));
      expect(rows.find((l) => l.id === '52')?.queue).toBeDefined();
    });

    it('uses updatedRow when it is the newest', async () => {
      const rows = await live(stubbedPark([{
        poiId: '52',
        updatedAt: at(4055),
        createdAt: at(4055),
        updatedRow: at(0.5),
        waitTime: 5,
        open: true,
      }]));
      expect(rows.find((l) => l.id === '52')?.queue).toBeDefined();
    });

    it('retires a row whose only readable timestamp is ancient', async () => {
      // Junk beside a real stamp must not read as "cannot tell".
      const rows = await live(stubbedPark([
        {poiId: '52', updatedAt: at(4055), createdAt: 'not a date', updatedRow: null, waitTime: 5, open: true},
      ]));
      expectRetired(rows, '52');
    });

    it('keeps a row carrying no readable timestamp at all', async () => {
      // Cannot tell, so do not retire: guessing here would close the whole
      // park if the feed's shape ever changed.
      const rows = await live(stubbedPark([{poiId: '52', waitTime: 5, open: true}]));
      expect(rows.find((l) => l.id === '52')?.queue).toBeDefined();
    });

    it('ignores a numeric timestamp rather than reading it as ancient', async () => {
      const rows = await live(stubbedPark([
        {poiId: '52', updatedAt: NOW.getTime(), createdAt: null, updatedRow: null, waitTime: 5, open: true},
      ]));
      expect(rows.find((l) => l.id === '52')?.queue).toBeDefined();
    });

    it('keeps a row stamped slightly in the future', async () => {
      // Collector clock skew, not a retirement.
      const rows = await live(stubbedPark([row(52, -0.05, {waitTime: 5, open: true})]));
      expect(rows.find((l) => l.id === '52')?.queue).toBeDefined();
    });

    it('keeps a row stamped far in the future rather than reading the gap as age', async () => {
      // A month ahead is nonsense, but it is not evidence of retirement, and
      // measuring the distance either way would make it look ancient.
      const rows = await live(stubbedPark([row(52, -720, {waitTime: 5, open: true})]));
      expect(rows.find((l) => l.id === '52')?.queue).toBeDefined();
    });

    it('ignores a Date object rather than coercing it to a timestamp', async () => {
      // Only strings are read. A Date stringifies into something Date.parse
      // accepts, so a loosened guard would start trusting a shape the feed
      // does not send — and this one would retire a live venue on the
      // strength of it.
      const rows = await live(stubbedPark([
        {
          poiId: '52',
          updatedAt: new Date('2020-01-01T00:00:00Z'),
          createdAt: null,
          updatedRow: null,
          waitTime: 5,
          open: true,
        },
      ]));
      expect(rows.find((l) => l.id === '52')?.queue).toBeDefined();
    });
  });

  describe('when the whole feed goes stale', () => {
    it('reports every venue closed rather than emitting nothing', async () => {
      const park = new Phantasialand();
      vi.spyOn(park as any, 'getSignage').mockResolvedValue([
        row(52, 4055, {waitTime: 5, open: true}),
        row(223, 4055, {showTimes: ['2026-02-26 20:00:00']}),
      ]);
      const rows = await park.getLiveData();
      expect(rows).toHaveLength(2);
      expectRetired(rows, '52');
      expectRetired(rows, '223');
    });

    it('says so loudly', async () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const park = new Phantasialand();
      vi.spyOn(park as any, 'getSignage').mockResolvedValue([row(52, 4055, {open: true})]);
      await park.getLiveData();
      expect(err).toHaveBeenCalledWith(expect.stringContaining('feed has probably stopped updating'));
    });

    it('stays quiet while any row is fresh', async () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      await live(stubbedPark([row(52, 4055, {open: true})]));
      expect(err).not.toHaveBeenCalled();
    });
  });

  it('leaves a feed of entirely fresh rows untouched', async () => {
    const rows = await live(stubbedPark([
      row(52, 0.02, {waitTime: 5, open: true}),
      row(224, 0.02, {open: false}),
    ]));
    expect(rows).toHaveLength(3);
    expect(rows.find((l) => l.id === '224')).toMatchObject({status: 'CLOSED'});
  });

  it('skips an entry with no poiId, stale or not', async () => {
    const rows = await live(stubbedPark([
      {poiId: null, updatedAt: at(4055), createdAt: at(4055), updatedRow: at(4055), open: true},
    ]));
    expect(rows).toHaveLength(1);
  });
});

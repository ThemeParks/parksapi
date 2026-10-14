import {describe, test, expect, beforeEach, afterEach, vi} from 'vitest';
import {ScheduleTypeEnum} from '@themeparks/typelib';
import type {Entity, LiveData, EntitySchedule} from '@themeparks/typelib';
import {Destination} from '../destination.js';

/**
 * Schedule entries leave the library with a `type`. The schedule definition
 * has five (OPERATING, TICKETED_EVENT, PRIVATE_EVENT, EXTRA_HOURS, INFO), and
 * whatever reads the entries downstream decides open or closed from that
 * string. A type outside the definition has no defined meaning there.
 * `getSchedules()` therefore refuses to pass one on, and says so, the way
 * `getLiveData()` already scrubs a bad waitTime at the same boundary.
 */

type Raw = Record<string, unknown>;

const entry = (type: unknown, date = '2026-10-06'): Raw => ({
  date,
  type,
  openingTime: `${date}T10:00:00+08:00`,
  closingTime: `${date}T20:00:00+08:00`,
});

class SchedulePark extends Destination {
  constructor(private readonly built: Array<{id: string; schedule: Raw[]}>) {
    super();
  }
  protected async buildEntityList(): Promise<Entity[]> { return []; }
  protected async buildLiveData(): Promise<LiveData[]> { return []; }
  async getDestinations(): Promise<Entity[]> { return []; }
  protected async buildSchedules(): Promise<EntitySchedule[]> {
    return this.built as unknown as EntitySchedule[];
  }
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getSchedules(): the schedule type guard', () => {
  test.each(Object.values(ScheduleTypeEnum))('passes %s through untouched', async (type) => {
    const park = new SchedulePark([{id: 'p', schedule: [entry(type)]}]);

    const out = await park.getSchedules();

    expect(out).toEqual([{id: 'p', schedule: [entry(type)]}]);
    expect(warn).not.toHaveBeenCalled();
  });

  test('drops an entry whose type is not in the definition and keeps its neighbours in order', async () => {
    const park = new SchedulePark([{
      id: 'p',
      schedule: [
        entry('OPERATING', '2026-10-06'),
        entry('PARK_OPEN', '2026-10-07'),
        entry('INFO', '2026-10-08'),
      ],
    }]);

    const out = await park.getSchedules();

    expect(out[0].schedule.map(e => [e.date, e.type])).toEqual([
      ['2026-10-06', 'OPERATING'],
      ['2026-10-08', 'INFO'],
    ]);
  });

  test('says what it dropped: the park, the type, how many, and where it starts', async () => {
    const park = new SchedulePark([{
      id: 'p',
      schedule: [entry('PARK_OPEN', '2026-10-07'), entry('PARK_OPEN', '2026-10-08'), entry('OPERATING')],
    }]);

    await park.getSchedules();

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0][0]);
    expect(message).toContain('[SchedulePark]');
    expect(message).toContain('"PARK_OPEN" x2 (first 2026-10-07)');
  });

  test('one warning per call, however many types and parks are involved', async () => {
    const park = new SchedulePark([
      {id: 'a', schedule: [entry('PARK_OPEN'), entry('SHOW_TIME'), entry('OPERATING')]},
      {id: 'b', schedule: [entry('PARK_OPEN')]},
    ]);

    await park.getSchedules();

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0][0]);
    expect(message).toContain('"PARK_OPEN" x2');
    expect(message).toContain('"SHOW_TIME" x1');
  });

  test.each([
    ['a lower-case spelling', 'operating'],
    ['a missing type', undefined],
    ['a null type', null],
    ['a number', 1],
    ['an empty string', ''],
  ])('drops %s', async (_label, type) => {
    const park = new SchedulePark([{id: 'p', schedule: [entry(type), entry('OPERATING')]}]);

    const out = await park.getSchedules();

    expect(out[0].schedule.map(e => e.type)).toEqual(['OPERATING']);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test('a type that is not text is named by kind, never printed', async () => {
    const park = new SchedulePark([{id: 'p', schedule: [entry({secret: 'x'}), entry(undefined)]}]);

    await park.getSchedules();

    const message = String(warn.mock.calls[0][0]);
    expect(message).toContain('(object) x1');
    expect(message).toContain('(missing) x1');
    expect(message).not.toContain('secret');
  });

  test('a park left with no valid entries still reports its (empty) schedule', async () => {
    const park = new SchedulePark([{id: 'p', schedule: [entry('PARK_OPEN')]}]);

    expect(await park.getSchedules()).toEqual([{id: 'p', schedule: []}]);
  });

  test('does not reach into anything but the type', async () => {
    const park = new SchedulePark([{
      id: 'p',
      schedule: [{...entry('INFO'), description: 'Magical Halloween', extra: {nested: [1, 2]}}],
    }]);

    const out = await park.getSchedules();

    expect(out[0].schedule[0]).toEqual({...entry('INFO'), description: 'Magical Halloween', extra: {nested: [1, 2]}});
  });

  test('the allowed set follows the schedule definition: a type added there is accepted', async () => {
    const enumObject = ScheduleTypeEnum as unknown as Record<string, string>;
    enumObject.GUARD_PROBE_TYPE = 'GUARD_PROBE_TYPE';
    try {
      vi.resetModules();
      const fresh = await import('../destination.js');
      class FreshPark extends fresh.Destination {
        protected async buildEntityList(): Promise<Entity[]> { return []; }
        protected async buildLiveData(): Promise<LiveData[]> { return []; }
        async getDestinations(): Promise<Entity[]> { return []; }
        protected async buildSchedules(): Promise<EntitySchedule[]> {
          return [{id: 'p', schedule: [entry('GUARD_PROBE_TYPE')]}] as unknown as EntitySchedule[];
        }
      }

      const out = await new FreshPark().getSchedules();

      expect(out[0].schedule.map(e => e.type)).toEqual(['GUARD_PROBE_TYPE']);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      delete enumObject.GUARD_PROBE_TYPE;
    }
  });
});

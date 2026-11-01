import {describe, test, expect} from 'vitest';
import type {Entity, LiveData, EntitySchedule} from '@themeparks/typelib';
import {Destination} from '../destination.js';
import {rollPastMidnightClose} from '../datetime.js';

/**
 * Some sources stamp a past-midnight close with the opening date, so the day
 * reads closingTime <= openingTime: Gardaland on 31 Oct 2026 (open 10:00,
 * close "2026-10-31T00:00:00+01:00"), Busch Gardens Tampa and SeaWorld San
 * Diego event nights (19:00 to "00:00"/"01:00" the same date). Read literally
 * the day is an empty window and the park looks closed all day.
 * getSchedules() moves such a close to the next day for every park.
 */

describe('rollPastMidnightClose', () => {
  test('Gardaland 31 Oct 2026: a "00:00" close on the opening date becomes midnight that night', () => {
    expect(rollPastMidnightClose('2026-10-31T10:00:00+01:00', '2026-10-31T00:00:00+01:00', 'Europe/Rome'))
      .toBe('2026-11-01T00:00:00+01:00');
  });

  test('a 01:00 event-night close moves to 01:00 the next morning', () => {
    expect(rollPastMidnightClose('2026-10-24T19:00:00-04:00', '2026-10-24T01:00:00-04:00', 'America/New_York'))
      .toBe('2026-10-25T01:00:00-04:00');
  });

  test('the offset is recomputed when the clocks change that night', () => {
    // Europe falls back at 03:00 local on 25 Oct 2026. A close at 04:00 the
    // next morning is in CET (+01:00), not the opening day's CEST (+02:00).
    expect(rollPastMidnightClose('2026-10-24T19:00:00+02:00', '2026-10-24T04:00:00+02:00', 'Europe/Paris'))
      .toBe('2026-10-25T04:00:00+01:00');
  });

  test('with no real zone the string offset is kept', () => {
    expect(rollPastMidnightClose('2026-10-31T19:00:00-07:00', '2026-10-31T00:00:00-07:00', 'UTC'))
      .toBe('2026-11-01T00:00:00-07:00');
    expect(rollPastMidnightClose('2026-10-31T19:00:00-07:00', '2026-10-31T00:00-07:00'))
      .toBe('2026-11-01T00:00:00-07:00');
  });

  test('leaves normal days, unparseable times, and a close a day or more early alone', () => {
    expect(rollPastMidnightClose('2026-10-29T10:00:00+01:00', '2026-10-29T17:00:00+01:00', 'Europe/Rome')).toBeNull();
    expect(rollPastMidnightClose('2026-10-29T10:00:00+01:00', 'soon', 'Europe/Rome')).toBeNull();
    expect(rollPastMidnightClose('2026-10-30T10:00:00+01:00', '2026-10-29T10:00:00+01:00', 'Europe/Rome')).toBeNull();
  });

  test('a close equal to the opening is read as a 24 h day', () => {
    expect(rollPastMidnightClose('2026-10-29T10:00:00Z', '2026-10-29T10:00:00Z', 'UTC')).toBe('2026-10-30T10:00:00+00:00');
  });
});

type Raw = Record<string, unknown>;

class SchedulePark extends Destination {
  constructor(private readonly built: Array<{id: string; schedule: Raw[]}>, tz: string) {
    super();
    this.timezone = tz;
  }
  protected async buildEntityList(): Promise<Entity[]> { return []; }
  protected async buildLiveData(): Promise<LiveData[]> { return []; }
  async getDestinations(): Promise<Entity[]> { return []; }
  protected async buildSchedules(): Promise<EntitySchedule[]> {
    return this.built as unknown as EntitySchedule[];
  }
}

describe('getSchedules', () => {
  test('rolls a past-midnight close forward and leaves every other entry as built', async () => {
    const park = new SchedulePark([{
      id: 'park',
      schedule: [
        {date: '2026-10-30', type: 'OPERATING', openingTime: '2026-10-30T17:00:00+01:00', closingTime: '2026-10-30T22:00:00+01:00'},
        {date: '2026-10-31', type: 'OPERATING', openingTime: '2026-10-31T10:00:00+01:00', closingTime: '2026-10-31T00:00:00+01:00'},
        {date: '2026-10-31', type: 'INFO', description: 'no times'},
      ],
    }], 'Europe/Rome');
    const [s] = await park.getSchedules();
    expect(s.schedule.map((e: Raw) => e.closingTime)).toEqual([
      '2026-10-30T22:00:00+01:00',
      '2026-11-01T00:00:00+01:00',
      undefined,
    ]);
    expect(s.schedule[1].date).toBe('2026-10-31');
  });
});

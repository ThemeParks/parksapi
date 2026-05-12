import {describe, test, expect} from 'vitest';
import {parseTribeEvents, type TribeEventsResponse} from '../enchantedparks.js';

describe('parseTribeEvents', () => {
  const fixture: TribeEventsResponse = {
    events: [
      {
        start_date: '2026-05-10 11:00:00',
        end_date:   '2026-05-10 17:00:00',
        all_day: false,
        categories: [{name: 'Park Hours'}],
      },
      {
        start_date: '2026-05-15 09:30:00',
        end_date:   '2026-05-15 17:00:00',
        all_day: false,
        categories: [{name: 'Park Hours'}, {name: 'Special Events'}],
      },
      {
        start_date: '2026-05-20 12:00:00',
        end_date:   '2026-05-20 19:00:00',
        all_day: false,
        categories: [{name: 'Waterpark Hours'}],
      },
      {
        start_date: '2026-05-10 00:00:00',
        end_date:   '2026-05-10 23:59:59',
        all_day: true,
        categories: [{name: 'Group Event'}],
      },
    ],
  };

  test('keeps only events whose categories include the requested name', () => {
    const out = parseTribeEvents(fixture, 'Park Hours', 'America/Chicago');
    expect(out).toHaveLength(2);
    expect(out.map(s => s.date)).toEqual(['2026-05-10', '2026-05-15']);
  });

  test('routes Waterpark Hours separately', () => {
    const out = parseTribeEvents(fixture, 'Waterpark Hours', 'America/Chicago');
    expect(out).toHaveLength(1);
    expect(out[0].date).toBe('2026-05-20');
  });

  test('drops all-day events even if the category matches', () => {
    const allDayParkHours: TribeEventsResponse = {
      events: [{
        start_date: '2026-05-10 00:00:00',
        end_date:   '2026-05-10 23:59:59',
        all_day: true,
        categories: [{name: 'Park Hours'}],
      }],
    };
    expect(parseTribeEvents(allDayParkHours, 'Park Hours', 'America/Chicago')).toEqual([]);
  });

  test('produces ISO datetimes with the timezone offset', () => {
    const out = parseTribeEvents(fixture, 'Park Hours', 'America/Chicago');
    expect(out[0].openingTime).toMatch(/^2026-05-10T11:00:00-0[56]:00$/);
    expect(out[0].closingTime).toMatch(/^2026-05-10T17:00:00-0[56]:00$/);
    expect(out[0].type).toBe('OPERATING');
  });

  test('returns empty when no events match the category', () => {
    expect(parseTribeEvents(fixture, 'Nonexistent Category', 'America/Chicago')).toEqual([]);
  });

  test('tolerates events with missing categories field', () => {
    const noCategories: TribeEventsResponse = {events: [{
      start_date: '2026-05-10 11:00:00',
      end_date:   '2026-05-10 17:00:00',
      all_day: false,
    }]};
    expect(parseTribeEvents(noCategories, 'Park Hours', 'America/Chicago')).toEqual([]);
  });

  test('skips events with malformed start_date or end_date', () => {
    const malformed: TribeEventsResponse = {
      events: [
        {
          start_date: '2026-05-10 11:00:00',
          end_date: '',
          all_day: false,
          categories: [{name: 'Park Hours'}],
        },
        {
          start_date: '2026-05-10',
          end_date: '2026-05-10 17:00:00',
          all_day: false,
          categories: [{name: 'Park Hours'}],
        },
        {
          start_date: '2026-05-11 11:00:00',
          end_date: '2026-05-11 17:00:00',
          all_day: false,
          categories: [{name: 'Park Hours'}],
        },
      ],
    };
    const out = parseTribeEvents(malformed, 'Park Hours', 'America/Chicago');
    // Only the well-formed event survives.
    expect(out).toHaveLength(1);
    expect(out[0].date).toBe('2026-05-11');
  });
});

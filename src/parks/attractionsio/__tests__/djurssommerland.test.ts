/**
 * Djurs Sommerland schedules.
 *
 * The opening-hours page carries its calendar in the `data-model` attribute of
 * `<body>`: a list of `parkEvents`, each with a `type`, a start and end, and the
 * days it covers. The page labels the types as "Park opening hours" (1), "Water
 * park opening hours" (2) and "Magical Halloween opening hours" (4), and its
 * "Open today" banner reads the Halloween window on those days. A Halloween day
 * has no type-1 entry at all, so the type-4 window is the only statement of
 * when the park is open that day.
 *
 * Day indices are `monthIndex * 31 + (dayOfMonth - 1)` with a 0-based month.
 */

import {describe, test, expect, beforeEach, afterEach, vi} from 'vitest';
import {ScheduleTypeEnum} from '@themeparks/typelib';
import {DjursSommerland} from '../attractionsiov1.js';

// 13:00 in Copenhagen (+02:00 until the clocks change on 25 Oct 2026).
const NOW = new Date('2026-10-14T11:00:00Z');

/** monthIndex is 0-based: January = 0, October = 9. */
const day = (monthIndex: number, dayOfMonth: number) => monthIndex * 31 + (dayOfMonth - 1);
const OCT = 9;
const SEP = 8;

type ParkEvent = {
  type: number;
  start: string;
  end: string;
  days: {ranges: number[]};
  HoursRange?: string;
  description?: string;
};

const ev = (type: number, start: string, end: string, ranges: number[], extra: Partial<ParkEvent> = {}): ParkEvent => ({
  type,
  start,
  end,
  days: {ranges},
  ...extra,
});

/** The page, in the shape the site serves: a JSON model, entity-escaped, in a body attribute. */
function page(parkEvents: ParkEvent[], todayParkEvents: unknown[] = []): string {
  const model = JSON.stringify({parkEvents, todayParkEvents});
  const escaped = model.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return `<!doctype html><html><head><title>Opening hours</title></head>` +
    `<body class="front-end standardPage standard"\n data-model="${escaped}">` +
    `<main>Open today</main></body></html>`;
}

/**
 * Autumn 2026 as the site publishes it. Regular days on 5, 6 and 12 Sept; the
 * water park runs inside two of them; there is no regular entry for October at
 * all, only the Halloween window on 10 to 17 Oct (to 21:00) and 18 Oct (to
 * 18:00). The water park also lists 20 Oct, a day the park itself has no hours
 * for, and one row whose "times" are words, which the site really does serve.
 */
const REAL_SHAPE: ParkEvent[] = [
  ev(1, '10:00', '18:00', [day(SEP, 5), day(SEP, 6), day(SEP, 12)], {HoursRange: '10 - 18'}),
  ev(2, '12:00', '16:00', [day(SEP, 5), day(SEP, 6)], {HoursRange: '12 - 16'}),
  ev(2, 'Blå Mandag', '10.00 - 20.00', [day(SEP, 7)], {HoursRange: 'Blå Mandag - 10'}),
  ev(4, '10:00', '18:00', [day(OCT, 18)], {HoursRange: '10 - 18'}),
  ev(4, '10:00', '21:00', Array.from({length: 8}, (_, i) => day(OCT, 10 + i)), {HoursRange: '10 - 21'}),
  ev(2, '12:00', '18:00', [day(OCT, 20)], {HoursRange: '12 - 18'}),
];

function park(html: string): DjursSommerland {
  const djurs = new DjursSommerland();
  vi.spyOn(djurs as any, 'fetchCalendarHTML').mockResolvedValue({text: async () => html});
  return djurs;
}

async function schedule(html: string): Promise<any[]> {
  const out = await (park(html) as any).buildSchedules();
  expect(out).toHaveLength(1);
  expect(out[0].id).toBe('djurs-sommerland');
  return out[0].schedule;
}

const on = (entries: any[], date: string) => entries.filter(e => e.date === date);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Djurs Sommerland schedules: Halloween open days', () => {
  test('a Halloween day publishes the park hours as OPERATING', async () => {
    const entries = await schedule(page(REAL_SHAPE));

    const operating = on(entries, '2026-10-10').filter(e => e.type === 'OPERATING');
    expect(operating).toEqual([
      {
        date: '2026-10-10',
        type: 'OPERATING',
        openingTime: '2026-10-10T10:00:00+02:00',
        closingTime: '2026-10-10T21:00:00+02:00',
      },
    ]);
  });

  test('the event stays a separate INFO entry beside the OPERATING one', async () => {
    const entries = await schedule(page(REAL_SHAPE));

    expect(on(entries, '2026-10-10')).toEqual([
      {
        date: '2026-10-10',
        type: 'OPERATING',
        openingTime: '2026-10-10T10:00:00+02:00',
        closingTime: '2026-10-10T21:00:00+02:00',
      },
      {
        date: '2026-10-10',
        type: 'INFO',
        description: 'Magical Halloween',
        openingTime: '2026-10-10T10:00:00+02:00',
        closingTime: '2026-10-10T21:00:00+02:00',
      },
    ]);
  });

  test('every Halloween day is covered, each with the hours of its own window', async () => {
    const entries = await schedule(page(REAL_SHAPE));
    const operating = entries.filter(e => e.type === 'OPERATING' && e.date >= '2026-10-01');

    expect(operating.map(e => e.date)).toEqual([
      '2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13',
      '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17',
      '2026-10-18',
    ]);
    // The closing-day window is shorter than the rest.
    expect(operating.find(e => e.date === '2026-10-17')!.closingTime).toBe('2026-10-17T21:00:00+02:00');
    expect(operating.find(e => e.date === '2026-10-18')!.closingTime).toBe('2026-10-18T18:00:00+02:00');
  });

  test('an event description from the feed is kept on the INFO entry only', async () => {
    const entries = await schedule(page([
      ev(4, '10:00', '21:00', [day(OCT, 10)], {description: 'Halloween Nights'}),
    ]));

    expect(on(entries, '2026-10-10').map(e => [e.type, e.description])).toEqual([
      ['OPERATING', undefined],
      ['INFO', 'Halloween Nights'],
    ]);
  });
});

describe('Djurs Sommerland schedules: days the park is not open', () => {
  test('water park hours on a day with no park hours do not make the park OPERATING', async () => {
    const entries = await schedule(page(REAL_SHAPE));

    expect(on(entries, '2026-10-20')).toEqual([
      {
        date: '2026-10-20',
        type: 'INFO',
        description: 'Water Park',
        openingTime: '2026-10-20T12:00:00+02:00',
        closingTime: '2026-10-20T18:00:00+02:00',
      },
    ]);
  });

  test('a row whose hours are words yields nothing and does not break the rest', async () => {
    const entries = await schedule(page(REAL_SHAPE));

    expect(on(entries, '2026-09-07')).toEqual([]);
    expect(on(entries, '2026-09-05').map(e => e.type)).toEqual(['OPERATING', 'INFO']);
  });

  test('an event row without readable hours does not create an OPERATING entry', async () => {
    const entries = await schedule(page([
      ev(4, 'Closed', 'Closed', [day(OCT, 11)]),
      ev(4, '', '', [day(OCT, 12)]),
    ]));

    expect(entries).toEqual([]);
  });
});

describe('Djurs Sommerland schedules: regular days are unchanged', () => {
  test('a regular day is OPERATING with no description; the water park is INFO beside it', async () => {
    const entries = await schedule(page(REAL_SHAPE));

    expect(on(entries, '2026-09-05')).toEqual([
      {
        date: '2026-09-05',
        type: 'OPERATING',
        openingTime: '2026-09-05T10:00:00+02:00',
        closingTime: '2026-09-05T18:00:00+02:00',
      },
      {
        date: '2026-09-05',
        type: 'INFO',
        description: 'Water Park',
        openingTime: '2026-09-05T12:00:00+02:00',
        closingTime: '2026-09-05T16:00:00+02:00',
      },
    ]);
    expect(on(entries, '2026-09-12').map(e => e.type)).toEqual(['OPERATING']);
  });

  // Not seen upstream: no published day carries both a regular and a Halloween
  // entry. Pinned so that the day cannot end up with two OPERATING windows if
  // one ever does: the regular hours stand and the event stays visible as INFO.
  test('a day with regular hours and a Halloween window keeps ONE OPERATING entry', async () => {
    const entries = await schedule(page([
      ev(1, '10:00', '18:00', [day(OCT, 5)]),
      ev(4, '10:00', '21:00', [day(OCT, 5)]),
    ]));

    expect(on(entries, '2026-10-05').map(e => [e.type, e.closingTime])).toEqual([
      ['OPERATING', '2026-10-05T18:00:00+02:00'],
      ['INFO', '2026-10-05T21:00:00+02:00'],
    ]);
  });
});

describe('Djurs Sommerland schedules: output contract', () => {
  test('no date carries more than one OPERATING entry', async () => {
    const entries = await schedule(page(REAL_SHAPE));
    const perDate = new Map<string, number>();
    for (const e of entries.filter(e => e.type === 'OPERATING')) {
      perDate.set(e.date, (perDate.get(e.date) ?? 0) + 1);
    }

    expect(perDate.size).toBeGreaterThan(0);
    expect([...perDate.values()].every(n => n === 1)).toBe(true);
  });

  test('every type is one the schedule definition has', async () => {
    const entries = await schedule(page(REAL_SHAPE));
    const allowed = Object.values(ScheduleTypeEnum) as string[];

    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) expect(allowed).toContain(e.type);
  });

  test('entries are in date order, the park hours before the event on the same day', async () => {
    const entries = await schedule(page(REAL_SHAPE));
    const keys = entries.map(e => `${e.date} ${e.openingTime} ${e.type === 'OPERATING' ? 0 : 1}`);

    expect(keys).toEqual([...keys].sort());
  });

  test('a page without the calendar model publishes an empty schedule', async () => {
    expect(await schedule('<html><body class="x">no model</body></html>')).toEqual([]);
  });
});

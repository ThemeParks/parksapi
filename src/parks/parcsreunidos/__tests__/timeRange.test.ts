import {describe, test, expect, beforeEach} from 'vitest';
import {MovieParkGermany, ParqueWarnerMadrid} from '../parcsreunidos.js';
import {CacheLib} from '../../../cache.js';

/**
 * Calendar label parsing, asserted against the real `parseTimeRange`, and the
 * schedule entries it produces, asserted end to end through `parseCalendar`.
 *
 * Replaces a block in the deleted src/__tests__/parkEdgeCases.test.ts that
 * rewrote these regexes inside the test and matched against its own copies,
 * so it passed whatever the parser did.
 *
 * `parseTimeRange` returns wall-clock times with no concept of a day, and the
 * caller used to stamp both ends onto the same date. Every window running past
 * midnight therefore came out inverted, a close before its own open. That was
 * live: 98 published entries across this module, 93 typed OPERATING, from six
 * distinct label shapes, all of which appear below.
 */
describe('ParcsReunidos parseTimeRange', () => {
  const parse = (label: string) =>
    (new MovieParkGermany() as any).parseTimeRange(label);

  describe('windows that end on the same day', () => {
    test.each([
      ['10am - 5pm', '10:00', '17:00'],
      ['10:30am - 5:30pm', '10:30', '17:30'],
      ['11 a.m. – 7 p.m.', '11:00', '19:00'],
      ['10:30 - 17:00', '10:30', '17:00'],
      ['10 tot 17u', '10:00', '17:00'],
      ['11 t/m 19u', '11:00', '19:00'],
      ['12pm - 11pm', '12:00', '23:00'],
      ['12am - 6am', '00:00', '06:00'],
    ])('%s -> %s..%s, same day', (label, open, close) => {
      expect(parse(label)).toEqual({open, close, closesNextDay: false});
    });
  });

  describe('windows running past midnight close on the NEXT day', () => {
    // Every one of these is a real label, with the number of live occurrences
    // it had when the fix was written.
    test.each([
      ['12:00 - 00:00', '12:00', '00:00', 80],
      ['12:00 - 00:00h / Atracciones mecánicas disponibles hasta las 22:00h', '12:00', '00:00', 11],
      ['Halloween Scary Nights - 22:00 - 03:00', '22:00', '03:00', 4],
      ['10:30 - 01:00', '10:30', '01:00', 1],
      ['Halloween 10:30 - 00:00', '10:30', '00:00', 1],
      ['Halloween Scary Nights - 24:00 - 05:00', '24:00', '05:00', 1],
    ])('%s (%d live occurrences)', (label, open, close) => {
      expect(parse(label)).toEqual({open, close, closesNextDay: true});
    });

    test('the rule is one rule, so a bare descending 24h pair rolls too', () => {
      expect(parse('10 - 5')).toEqual({open: '10:00', close: '05:00', closesNextDay: true});
    });

    test('and a Dutch evening session rolls, without inventing a meridiem', () => {
      // The close stays 03:00. An earlier attempt at this rolled the CLOCK
      // instead of the day and turned it into 15:00, which is both still
      // inverted and no longer recoverable.
      expect(parse('22 tot 3u')).toEqual({open: '22:00', close: '03:00', closesNextDay: true});
    });
  });

  test('EQUAL times are left alone rather than rolled to a 24-hour day', () => {
    // No live label produces this. A zero-length window is a visible oddity;
    // a fabricated 24-hour one would not be.
    expect(parse('12:00 - 12:00')).toEqual({open: '12:00', close: '12:00', closesNextDay: false});
  });

  describe('labels with no parseable range', () => {
    test('return null rather than guessing', () => {
      expect(parse('Gesloten')).toBeNull();
      expect(parse('')).toBeNull();
      expect(parse('Halloween')).toBeNull();
    });

    test('KNOWN GAP: the Spanish "a" range is not a supported format', () => {
      // An asymmetry rather than an observed failure. extractLabelDescription
      // carries an explicit branch for this shape, commented `ES "12:00 a
      // 20:00"`, so someone saw such labels; parseTimeRange has no matching
      // branch. Checked against the live calendars for both Madrid parks and
      // found no label of this shape, so nothing is being dropped today.
      expect(parse('12:00 a 20:00')).toBeNull();
    });
  });

  test('a word merely containing "tot" does not trigger the Dutch branch', () => {
    expect(parse('Horario total 10 12')).toBeNull();
    expect(parse('10 totale 5')).toBeNull();
  });
});

describe('ParcsReunidos parseCalendar: the entry a consumer actually reads', () => {
  // The contract that was broken. parseTimeRange returning a flag is an
  // implementation detail; what matters is that the published entry runs
  // forwards, which only the caller can get right.
  beforeEach(async () => {
    await CacheLib.clearByClassName('ParqueWarnerMadrid');
  });

  function park(labels: Record<string, string>, dayLabelKey: string) {
    const p: any = new ParqueWarnerMadrid();
    const labelsJson = JSON.stringify([labels]).replace(/"/g, '&#34;');
    // month index 9 = October; day 31.
    const months = JSON.stringify(
      Array.from({length: 12}, (_, i) => (i === 9 ? {'31': dayLabelKey} : {})),
    ).replace(/"/g, '&#34;');
    p.fetchCalendarHTML = async () => ({
      text: async () => `
        <input id="data-hour-labels" value="${labelsJson}">
        <input id="data-hour-2026" value="${months}">
      `,
    });
    return p;
  }

  test('a midnight close lands on the following day, not backwards', async () => {
    const entries = await park({a: '12:00 - 00:00'}, 'a').parseCalendar();
    expect(entries).toHaveLength(1);
    const [e] = entries;
    expect(e.date).toBe('2026-10-31');
    expect(e.openingTime).toBe('2026-10-31T12:00:00+01:00');
    expect(e.closingTime).toBe('2026-11-01T00:00:00+01:00');
    expect(Date.parse(e.closingTime)).toBeGreaterThan(Date.parse(e.openingTime));
  });

  test('a 24:00 open and its small-hours close both land on the next day', async () => {
    // constructDateTime already rolled a 24:00 OPEN. Before the fix the close
    // stayed behind, putting the open 19 hours AFTER the close.
    const entries = await park({a: 'Halloween Scary Nights - 24:00 - 05:00'}, 'a').parseCalendar();
    const [e] = entries;
    expect(e.openingTime).toBe('2026-11-01T00:00:00+01:00');
    expect(e.closingTime).toBe('2026-11-01T05:00:00+01:00');
  });

  test('an ordinary same-day window is untouched', async () => {
    const entries = await park({a: '10:00 - 18:00'}, 'a').parseCalendar();
    const [e] = entries;
    expect(e.openingTime).toBe('2026-10-31T10:00:00+01:00');
    expect(e.closingTime).toBe('2026-10-31T18:00:00+01:00');
  });

  test('a second session on the same day rolls independently of the first', async () => {
    // Warner's real shape on 31 October: a day window plus an after-hours
    // event. The first is OPERATING, the rest INFO.
    const entries = await park(
      {a: '12:00 - 00:00', b: 'Halloween Scary Nights - 24:00 - 05:00'},
      'a,b',
    ).parseCalendar();
    expect(entries).toHaveLength(2);
    expect(entries[0].type).toBe('OPERATING');
    expect(entries[1].type).toBe('INFO');
    for (const e of entries) {
      expect(
        Date.parse(e.closingTime) > Date.parse(e.openingTime),
        `${e.type} ${e.openingTime} -> ${e.closingTime}`,
      ).toBe(true);
    }
  });
});

import {describe, test, expect} from 'vitest';
import {MovieParkGermany} from '../parcsreunidos.js';

/**
 * Calendar label parsing, asserted against the real `parseTimeRange`.
 *
 * Replaces a block in the deleted src/__tests__/parkEdgeCases.test.ts that
 * rewrote these regexes inside the test and matched against its own copies,
 * so it passed whatever the parser did.
 *
 * This file is deliberately a CHARACTERISATION test: it pins what the parser
 * does today, including where that is wrong. `parseTimeRange` returns only a
 * pair of wall-clock times and the caller stamps both onto the same date, so
 * any window that runs past midnight comes out inverted — a close before its
 * own open. That is live, not theoretical: 98 published schedule entries
 * across this module are inverted right now, 93 of them typed OPERATING.
 *
 * Those cases are pinned below as KNOWN BROKEN. When the date-roll fix lands
 * they must be updated, and having to update them is the point: it is the
 * proof the fix changed something.
 */
describe('ParcsReunidos parseTimeRange', () => {
  const parse = (label: string) =>
    (new MovieParkGermany() as any).parseTimeRange(label);

  describe('formats that parse correctly', () => {
    test('AM/PM: "10am - 5pm"', () => {
      expect(parse('10am - 5pm')).toEqual({open: '10:00', close: '17:00'});
    });

    test('AM/PM with minutes: "10:30am - 5:30pm"', () => {
      expect(parse('10:30am - 5:30pm')).toEqual({open: '10:30', close: '17:30'});
    });

    test('dotted AM/PM with an en-dash: "11 a.m. – 7 p.m."', () => {
      expect(parse('11 a.m. – 7 p.m.')).toEqual({open: '11:00', close: '19:00'});
    });

    test('24h: "10:30 - 17:00"', () => {
      expect(parse('10:30 - 17:00')).toEqual({open: '10:30', close: '17:00'});
    });

    test('Dutch, 24h clock: "10 tot 17u"', () => {
      // Every time-bearing label Bobbejaanland actually publishes is of this
      // shape. There is no live attestation of a 12-hour Dutch label.
      expect(parse('10 tot 17u')).toEqual({open: '10:00', close: '17:00'});
    });

    test('the t/m separator is accepted too', () => {
      expect(parse('11 t/m 19u')).toEqual({open: '11:00', close: '19:00'});
    });

    test('midday and midnight are not confused by the AM/PM branch', () => {
      expect(parse('12pm - 11pm')).toEqual({open: '12:00', close: '23:00'});
      expect(parse('12am - 6am')).toEqual({open: '00:00', close: '06:00'});
    });
  });

  describe('KNOWN BROKEN: a window running past midnight inverts', () => {
    // parseTimeRange returns wall-clock times only, and the caller stamps both
    // onto the same date, so nothing can express "closes tomorrow". Each of
    // these is a real published label shape.
    test('24h across midnight: "12:00 - 00:00" (78 live rows at one park)', () => {
      expect(parse('12:00 - 00:00')).toEqual({open: '12:00', close: '00:00'});
    });

    test('24h into the small hours: "10:30 - 01:00"', () => {
      expect(parse('10:30 - 01:00')).toEqual({open: '10:30', close: '01:00'});
    });

    test('a 24:00 open: "24:00 - 05:00"', () => {
      // constructDateTime accepts hour 24 and rolls it, so the caller lands
      // the OPEN on the next day and leaves the close behind, putting the
      // open 19 hours after the close.
      expect(parse('24:00 - 05:00')).toEqual({open: '24:00', close: '05:00'});
    });

    test('Dutch evening session: "22 tot 3u"', () => {
      expect(parse('22 tot 3u')).toEqual({open: '22:00', close: '03:00'});
    });

    test('the bare 24h branch inverts on any descending pair', () => {
      expect(parse('10 - 5')).toEqual({open: '10:00', close: '05:00'});
    });
  });

  describe('labels with no parseable range', () => {
    test('returns null rather than guessing', () => {
      expect(parse('Gesloten')).toBeNull();
      expect(parse('')).toBeNull();
      expect(parse('Halloween')).toBeNull();
    });

    test('KNOWN GAP: the Spanish "a" range is not a supported format', () => {
      // An asymmetry rather than an observed failure. extractLabelDescription
      // carries an explicit branch for this shape, commented `ES "12:00 a
      // 20:00"`, so someone saw such labels; parseTimeRange has no matching
      // branch, so any label of that shape yields no window at all. Checked
      // 2026-09-19 against the live calendars for both Madrid parks and found
      // no label of this shape, so nothing is being dropped today.
      expect(parse('12:00 a 20:00')).toBeNull();
    });
  });

  test('a word merely containing "tot" does not trigger the Dutch branch', () => {
    // The regex needs digits immediately either side, which is what stops
    // Spanish "total" and Italian "totale" matching in this shared module.
    expect(parse('Horario total 10 12')).toBeNull();
    expect(parse('10 totale 5')).toBeNull();
  });
});

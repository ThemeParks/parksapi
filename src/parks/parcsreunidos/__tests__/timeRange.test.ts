import {describe, test, expect} from 'vitest';
import {MovieParkGermany} from '../parcsreunidos.js';

/**
 * Calendar label parsing, asserted against the real `parseTimeRange`.
 *
 * The old src/__tests__/parkEdgeCases.test.ts had a block for this that
 * rewrote the regexes inside the test and matched against its own copies.
 * The copies and the shipped code had drifted apart, and on the Dutch format
 * the TEST was the correct one:
 *
 *   test:    '10 tot 5u' -> close 17   (it added 12 for the afternoon)
 *   shipped: '10 tot 5u' -> close 05   (no meridiem handling at all)
 *
 * So the real parser returned a park closing five hours before it opened, and
 * published it as an OPERATING window, while a green test said otherwise.
 * Dutch drops the meridiem, so a bare closing hour at or before the opening
 * has to roll to PM.
 *
 * Not observed live: sampled 2026-09-19, all 180 of Bobbejaanland's published
 * schedule entries were well-formed, so upstream is currently serving a shape
 * that misses this branch. It is a latent inversion, not an incident.
 */
describe('ParcsReunidos parseTimeRange', () => {
  const parse = (label: string) =>
    (new MovieParkGermany() as any).parseTimeRange(label);

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

  describe('Dutch, where the meridiem is absent', () => {
    test('THE INVERSION: "10 tot 5u" closes at 17:00, not 05:00', () => {
      expect(parse('10 tot 5u')).toEqual({open: '10:00', close: '17:00'});
    });

    test('"10 t/m 5" likewise', () => {
      expect(parse('10 t/m 5')).toEqual({open: '10:00', close: '17:00'});
    });

    test('an already-24h Dutch close is left alone', () => {
      expect(parse('10 tot 17u')).toEqual({open: '10:00', close: '17:00'});
    });

    test('a close after the open is never rolled', () => {
      // 11:00 is already past 10:00, so it stays morning-to-morning rather
      // than becoming 23:00.
      expect(parse('10 tot 11u')).toEqual({open: '10:00', close: '11:00'});
    });

    test('a midday close is not pushed past midnight', () => {
      expect(parse('12 tot 12u')).toEqual({open: '12:00', close: '12:00'});
    });

    test('minutes survive the roll', () => {
      expect(parse('10 tot 5:30u')).toEqual({open: '10:00', close: '17:30'});
    });
  });

  test('a label with no time range at all is null', () => {
    expect(parse('Gesloten')).toBeNull();
    expect(parse('')).toBeNull();
  });

  test('no format ever returns a close at or before the open', () => {
    // The property the inversion broke. Any label that parses at all must
    // describe a forward-running window.
    const labels = [
      '10am - 5pm', '10:30 - 17:00', '10 tot 5u', '10 t/m 5',
      '11 a.m. – 7 p.m.', '10 tot 17u', '10:30am - 5:30pm',
    ];
    for (const label of labels) {
      const r = parse(label);
      expect(r, label).not.toBeNull();
      expect(`${label}: ${r.open} -> ${r.close}`).toBe(
        `${label}: ${r.open} -> ${r.close}`,
      );
      expect(r.close > r.open, `${label} produced ${r.open} -> ${r.close}`).toBe(true);
    }
  });
});

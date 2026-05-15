import {describe, test, expect} from 'vitest';
import {parseTribeEvents, type TribeEventsResponse} from '../enchantedparks.js';
import {parseICalFeed} from '../enchantedparks.js';
import {parseAttractionsPage} from '../enchantedparks.js';

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

describe('parseICalFeed', () => {
  const fixture = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Valleyfair//EN
BEGIN:VEVENT
UID:1@vf
DTSTART;TZID=America/Chicago:20260510T110000
DTEND;TZID=America/Chicago:20260510T170000
SUMMARY:Park Hours
CATEGORIES:Park Hours
END:VEVENT
BEGIN:VEVENT
UID:2@vf
DTSTART;TZID=America/Chicago:20260520T120000
DTEND;TZID=America/Chicago:20260520T190000
SUMMARY:Waterpark Hours
CATEGORIES:Waterpark Hours
END:VEVENT
BEGIN:VEVENT
UID:3@vf
DTSTART;VALUE=DATE:20260510
DTEND;VALUE=DATE:20260511
SUMMARY:Group Event
CATEGORIES:Group Event
END:VEVENT
END:VCALENDAR`;

  test('returns only events whose CATEGORIES line includes the requested name', () => {
    const out = parseICalFeed(fixture, 'Park Hours', 'America/Chicago');
    expect(out).toHaveLength(1);
    expect(out[0].date).toBe('2026-05-10');
  });

  test('Waterpark Hours routes separately', () => {
    const out = parseICalFeed(fixture, 'Waterpark Hours', 'America/Chicago');
    expect(out).toHaveLength(1);
    expect(out[0].date).toBe('2026-05-20');
  });

  test('skips all-day VEVENTs (DTSTART;VALUE=DATE:…)', () => {
    const out = parseICalFeed(fixture, 'Group Event', 'America/Chicago');
    expect(out).toEqual([]);
  });

  test('produces correctly-offset ISO times', () => {
    const out = parseICalFeed(fixture, 'Park Hours', 'America/Chicago');
    expect(out[0].openingTime).toMatch(/^2026-05-10T11:00:00-0[56]:00$/);
    expect(out[0].closingTime).toMatch(/^2026-05-10T17:00:00-0[56]:00$/);
  });

  test('returns empty for an empty calendar', () => {
    expect(parseICalFeed('BEGIN:VCALENDAR\nEND:VCALENDAR', 'Park Hours', 'America/Chicago')).toEqual([]);
  });

  test('handles multiple CATEGORIES on one line', () => {
    const multi = `BEGIN:VCALENDAR
BEGIN:VEVENT
DTSTART;TZID=America/Chicago:20260512T093000
DTEND;TZID=America/Chicago:20260512T170000
CATEGORIES:Park Hours,Special Events
END:VEVENT
END:VCALENDAR`;
    expect(parseICalFeed(multi, 'Park Hours', 'America/Chicago')).toHaveLength(1);
  });
});

describe('parseAttractionsPage', () => {
  const fixture = `<!doctype html><html><body>
<div class="ride-card">
  <a href="https://valleyfair.enchantedparks.com/rides-and-experiences/attractions/wild-thing/">
    <h3>Wild Thing</h3>
  </a>
</div>
<div class="ride-card">
  <a href="https://valleyfair.enchantedparks.com/rides-and-experiences/attractions/bumper-cars/">
    <img />
  </a>
  <h3>Bumper Cars</h3>
</div>
<div class="ride-card">
  <a href="/rides-and-experiences/attractions/charlie-brown-s-wind-up/">
    <h3>Charlie Brown&#8217;s Wind-Up</h3>
  </a>
</div>
<a href="/rides-and-experiences/dining/snack-shack/">Snack Shack</a>
</body></html>`;

  test('returns one entry per unique attraction slug', () => {
    const out = parseAttractionsPage(fixture);
    expect(out.map(a => a.slug)).toEqual(['wild-thing', 'bumper-cars', 'charlie-brown-s-wind-up']);
  });

  test('skips non-attractions/ links (e.g. dining)', () => {
    const out = parseAttractionsPage(fixture);
    expect(out.map(a => a.slug)).not.toContain('snack-shack');
  });

  test('decodes HTML entities in the name', () => {
    const out = parseAttractionsPage(fixture);
    const cb = out.find(a => a.slug === 'charlie-brown-s-wind-up');
    expect(cb?.name).toBe('Charlie Brown’s Wind-Up');
  });

  test('deduplicates if the same slug appears multiple times', () => {
    const dup = fixture + fixture;
    const out = parseAttractionsPage(dup);
    expect(new Set(out.map(a => a.slug)).size).toBe(out.length);
  });

  test('returns empty for HTML with no ride links', () => {
    expect(parseAttractionsPage('<html><body>nothing here</body></html>')).toEqual([]);
  });

  test('handles h3 that precedes its link (before-path)', () => {
    const beforeHtml = `<div class="ride-card">
  <h3>Renegade</h3>
  <a href="/rides-and-experiences/attractions/renegade/">More info</a>
</div>`;
    const out = parseAttractionsPage(beforeHtml);
    expect(out).toEqual([{slug: 'renegade', name: 'Renegade'}]);
  });
});

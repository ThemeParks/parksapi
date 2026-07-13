import {describe, test, expect} from 'vitest';
import {parseTribeEvents, type TribeEventsResponse, EnchantedParks} from '../enchantedparks.js';
import {parseICalFeed} from '../enchantedparks.js';
import {parseAttractionsPage} from '../enchantedparks.js';
import {parseShowsPage} from '../enchantedparks.js';

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

  test('cross-midnight event keeps closing time after opening (uses end_date\'s own day)', () => {
    const fixture: TribeEventsResponse = {
      events: [
        {
          start_date: '2026-10-31 19:00:00',
          end_date:   '2026-11-01 01:00:00',
          all_day: false,
          categories: [{name: 'Halloween Hours'}],
        },
      ],
    };
    const out = parseTribeEvents(fixture, 'Halloween Hours', 'America/Chicago');
    expect(out).toHaveLength(1);
    expect(out[0].date).toBe('2026-10-31');
    expect(out[0].openingTime).toBe('2026-10-31T19:00:00-05:00');
    expect(out[0].closingTime).toBe('2026-11-01T01:00:00-05:00');
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

  test('cross-midnight event keeps closing time after opening (uses DTEND\'s own day)', () => {
    const crossMidnight = `BEGIN:VCALENDAR
BEGIN:VEVENT
DTSTART;TZID=America/Chicago:20261031T190000
DTEND;TZID=America/Chicago:20261101T010000
CATEGORIES:Halloween Hours
END:VEVENT
END:VCALENDAR`;
    const out = parseICalFeed(crossMidnight, 'Halloween Hours', 'America/Chicago');
    expect(out).toHaveLength(1);
    expect(out[0].date).toBe('2026-10-31');
    expect(out[0].openingTime).toBe('2026-10-31T19:00:00-05:00');
    expect(out[0].closingTime).toBe('2026-11-01T01:00:00-05:00');
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

  test('with linkPathSegment="dining", matches dining cards and skips attraction cards', () => {
    const diningFixture = `<article>
      <a href="https://valleyfair.enchantedparks.com/rides-and-experiences/dining/gateway-grounds/"><img /></a>
      <div class="container"><h3>Gateway Grounds</h3></div>
    </article>
    <article>
      <a href="https://valleyfair.enchantedparks.com/rides-and-experiences/attractions/wild-thing/"><img /></a>
      <div class="container"><h3>Wild Thing</h3></div>
    </article>`;
    const out = parseAttractionsPage(diningFixture, 'dining');
    expect(out).toEqual([{slug: 'gateway-grounds', name: 'Gateway Grounds'}]);
  });
});

describe('parseShowsPage', () => {
  const fixture = `<!doctype html><html><body>
<article id="post-10106" class="item card passes col span4 post-10106 post type-post category-live-entertainment no-thumb">
  <figure><img src="happiness.webp" alt="Happiness Is… background image" /></figure>
  <div class="container">
    <h4>Happiness Is…</h4>
    <p>May 23-Aug 30</p>
  </div>
</article>
<article id="post-10113" class="item card passes col span4 post-10113 post type-post category-live-entertainment no-thumb">
  <figure><img src="peanuts.webp" /></figure>
  <div class="container">
    <h4>PEANUTS&#8482; Meet &#038; Greet</h4>
  </div>
</article>
<article id="post-8016" class="item card post-8016 page type-page category-cta-box-footer no-thumb">
  <figure><img src="cabana.jpg" /></figure>
  <div class="container"><h4>Cabana Rentals</h4></div>
</article>
</body></html>`;

  test('extracts show name per category-live-entertainment card', () => {
    const out = parseShowsPage(fixture, 'live-entertainment');
    expect(out.map(s => s.name)).toEqual(['Happiness Is…', 'PEANUTS™ Meet & Greet']);
  });

  test('ignores cards from other categories (e.g. footer CTAs)', () => {
    const out = parseShowsPage(fixture, 'live-entertainment');
    expect(out.map(s => s.name)).not.toContain('Cabana Rentals');
  });

  test('slugifies names with trademark glyphs and ampersands for the id', () => {
    const out = parseShowsPage(fixture, 'live-entertainment');
    const peanuts = out.find(s => s.name === 'PEANUTS™ Meet & Greet');
    expect(peanuts?.slug).toBe('peanuts-meet-and-greet');
  });

  test('slugifies an ellipsis/trailing punctuation cleanly', () => {
    const out = parseShowsPage(fixture, 'live-entertainment');
    const happiness = out.find(s => s.name === 'Happiness Is…');
    expect(happiness?.slug).toBe('happiness-is');
  });

  test('returns empty when no card matches the requested category', () => {
    expect(parseShowsPage(fixture, 'special-events')).toEqual([]);
  });

  test('returns empty for HTML with no article cards', () => {
    expect(parseShowsPage('<html><body>nothing here</body></html>', 'live-entertainment')).toEqual([]);
  });

  test('deduplicates cards that slugify to the same name', () => {
    const dup = fixture + fixture;
    const out = parseShowsPage(dup, 'live-entertainment');
    expect(out).toHaveLength(2);
  });
});

describe('attraction location lookup', () => {
  // Expose protected `lookupAttractionLocation` for direct testing without
  // requiring a full destination lifecycle.
  class Probe extends EnchantedParks {
    public withLocations(
      m: Record<string, {latitude: number; longitude: number}>,
    ): this {
      this.attractionLocations = m;
      return this;
    }
    public lookup(name: string) {
      return this.lookupAttractionLocation(name);
    }
  }

  const sample = {
    "Snoopy's Junction":   {latitude: 39.172367, longitude: -94.488782},
    'Timber Wolf':         {latitude: 39.173334, longitude: -94.488856},
    'TIMBERTOWN RAILWAY':  {latitude: 43.342000, longitude: -86.275000},
  };

  test('matches when WP source uses curly apostrophe and snapshot uses straight', () => {
    const p = new Probe({}).withLocations(sample);
    // Wiki snapshot has "Snoopy's Junction" (straight ').
    // WP source emits "Snoopy’s Junction" (curly ’).
    expect(p.lookup('Snoopy’s Junction')).toEqual({
      latitude: 39.172367, longitude: -94.488782,
    });
  });

  test('matches case-insensitively', () => {
    const p = new Probe({}).withLocations(sample);
    expect(p.lookup('timber wolf')).toEqual({
      latitude: 39.173334, longitude: -94.488856,
    });
    // Lookup name uppercase, snapshot key uppercase — still matches.
    expect(p.lookup('Timbertown Railway')).toEqual({
      latitude: 43.342000, longitude: -86.275000,
    });
  });

  test('returns undefined when the name is not in the snapshot', () => {
    const p = new Probe({}).withLocations(sample);
    expect(p.lookup('Definitely Not A Real Ride')).toBeUndefined();
  });

  test('returns undefined when no snapshot is configured', () => {
    const p = new Probe({});
    expect(p.lookup('Timber Wolf')).toBeUndefined();
  });
});

describe('attractionLocations wiring on every EnchantedParks subclass', () => {
  // Each subclass MUST wire up a locations/<slug>.json snapshot in its
  // constructor. Without it, updateSource() on the wiki does a full replace
  // (not a merge) on every collector sync, silently wiping out any
  // real lat/lng the entity previously had — this happened for real to
  // Valleyfair (79 attractions/dining/shows lost their coordinates) because
  // it was the one subclass missing the wiring the other 5 already had.
  test('every subclass has a non-empty attractionLocations snapshot', async () => {
    const modules = await Promise.all([
      import('../valleyfair.js'),
      import('../worldsoffun.js'),
      import('../michigansadventure.js'),
      import('../midamericaparks.js'),
      import('../greatescapeparks.js'),
      import('../galvestonislandwaterpark.js'),
    ]);

    for (const mod of modules) {
      const ParkClass = Object.values(mod)[0] as new () => EnchantedParks;
      const instance = new ParkClass();
      const snapshot = (instance as any).attractionLocations;
      expect(snapshot, `${ParkClass.name} has no attractionLocations snapshot wired up`).toBeDefined();
      expect(Object.keys(snapshot).length, `${ParkClass.name}'s attractionLocations snapshot is empty`).toBeGreaterThan(0);
    }
  });
});

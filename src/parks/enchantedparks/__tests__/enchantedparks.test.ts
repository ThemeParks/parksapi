import {describe, test, expect, vi} from 'vitest';
import {EnchantedParks, parseTribeEvents, scrapeTtl, type TribeEventsResponse} from '../enchantedparks.js';
import {parseICalFeed} from '../enchantedparks.js';
import {parseAttractionsPage} from '../enchantedparks.js';
import {parseShowsPage} from '../enchantedparks.js';
import {
  mapFeatureStatus,
  normalizeRideName,
  normalizeFeatureName,
  matchFeaturesToLiveData,
  type LiveFeature,
  type WpPage,
  parseCategoryRideSlugs,
} from '../enchantedparks.js';

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

describe('mapFeatureStatus', () => {
  // The operator's live feed uses free-text status strings with inconsistent
  // casing (Open / OPEN, Temporarily Closed / TEMPORARILY_CLOSED). Map them to
  // the framework's canonical statuses.
  test('open variants → OPERATING', () => {
    expect(mapFeatureStatus('Open')).toBe('OPERATING');
    expect(mapFeatureStatus('OPEN')).toBe('OPERATING');
    expect(mapFeatureStatus('opened')).toBe('OPERATING');
  });

  test('temporary-closure variants → DOWN (the state the app hides)', () => {
    expect(mapFeatureStatus('Temporarily Closed')).toBe('DOWN');
    expect(mapFeatureStatus('TEMPORARILY_CLOSED')).toBe('DOWN');
    expect(mapFeatureStatus('temp closed')).toBe('DOWN');
  });

  test('all-day closure → CLOSED', () => {
    expect(mapFeatureStatus('Closed')).toBe('CLOSED');
    expect(mapFeatureStatus('CLOSED')).toBe('CLOSED');
  });

  test('unknown / empty → CLOSED (safe default)', () => {
    expect(mapFeatureStatus('')).toBe('CLOSED');
    expect(mapFeatureStatus('something new')).toBe('CLOSED');
  });
});

describe('feature-name normalization', () => {
  // Feature names carry a park-code prefix ("WOF - ", "OOF - ") that the
  // scraped ride names don't. Stripping it lets the two sources join by name.
  test('strips the park-code prefix from feature names', () => {
    expect(normalizeFeatureName('WOF - RipCord')).toBe(normalizeRideName('RipCord'));
    expect(normalizeFeatureName('OOF - Typhoon')).toBe(normalizeRideName('Typhoon'));
    expect(normalizeFeatureName('SSA - Oasis Bar')).toBe(normalizeRideName('Oasis Bar'));
  });

  test('does NOT strip a dash from an unprefixed scraped ride name', () => {
    // A scraped name is passed through normalizeRideName, which must not eat
    // leading words — only the uppercase-code prefix on the feature side goes.
    expect(normalizeRideName('Timber Wolf')).toBe('timber wolf');
    expect(normalizeRideName('Wild Thing')).toBe('wild thing');
  });

  test('folds curly apostrophes so both sources agree', () => {
    expect(normalizeFeatureName('MA - Thunderhawk’s')).toBe(normalizeRideName("Thunderhawk's"));
  });
});

describe('matchFeaturesToLiveData', () => {
  const rides = [
    {id: 'enchantedparks_attraction_WOF_ripcord', name: 'RipCord'},
    {id: 'enchantedparks_attraction_WOF_zambezi-zinger', name: 'Zambezi Zinger'},
    {id: 'enchantedparks_attraction_WOF_mamba', name: 'Mamba'},
    {id: 'enchantedparks_attraction_OOF_typhoon', name: 'Typhoon'},
  ];

  const WOF = 'site-uuid-wof';
  const VF = 'site-uuid-vf';

  const features: LiveFeature[] = [
    {name: 'WOF - RipCord', siteId: WOF, operationalStatus: 'Temporarily Closed'},
    {name: 'WOF - Zambezi Zinger', siteId: WOF, operationalStatus: 'Open'},
    {name: 'WOF - Mamba', siteId: WOF, operationalStatus: 'Closed'},
    {name: 'OOF - Typhoon', siteId: WOF, operationalStatus: 'OPEN'},
    // Non-ride POS feature — no matching ride entity, must be dropped.
    {name: 'WOF - Ticket Sales', siteId: WOF, operationalStatus: 'Open'},
    // Feature from a different site — must be ignored even if name collides.
    {name: 'VF - RipCord', siteId: VF, operationalStatus: 'Closed'},
  ];

  test('maps each matched ride to its live status by id', () => {
    const out = matchFeaturesToLiveData(features, [WOF], rides);
    const byId = Object.fromEntries(out.map((l) => [l.id, l.status]));
    expect(byId['enchantedparks_attraction_WOF_ripcord']).toBe('DOWN');
    expect(byId['enchantedparks_attraction_WOF_zambezi-zinger']).toBe('OPERATING');
    expect(byId['enchantedparks_attraction_WOF_mamba']).toBe('CLOSED');
    expect(byId['enchantedparks_attraction_OOF_typhoon']).toBe('OPERATING');
  });

  test('drops features with no matching ride entity (POS, retail, gates)', () => {
    const out = matchFeaturesToLiveData(features, [WOF], rides);
    // 4 rides matched, Ticket Sales dropped.
    expect(out).toHaveLength(4);
    expect(out.every((l) => l.id.startsWith('enchantedparks_attraction_'))).toBe(true);
  });

  test('only uses features from the requested site id(s)', () => {
    // The Valleyfair "VF - RipCord" (Closed) must not overwrite the Worlds of
    // Fun RipCord (Temporarily Closed → DOWN).
    const out = matchFeaturesToLiveData(features, [WOF], rides);
    const ripcord = out.find((l) => l.id === 'enchantedparks_attraction_WOF_ripcord');
    expect(ripcord?.status).toBe('DOWN');
  });

  test('returns empty when no site ids are supplied', () => {
    expect(matchFeaturesToLiveData(features, [], rides)).toEqual([]);
  });
});

describe('buildLiveData wiring (stubbed network)', () => {
  // Integration of the pieces without hitting the real feed: stub the two
  // network-backed getters and assert buildLiveData joins them to the right
  // entity ids and honours the empty-config guards. Full live integration is
  // exercised via `npm run dev -- <park>` / `npm run health`.
  async function makeWorldsOfFun(): Promise<EnchantedParks> {
    const mod = await import('../worldsoffun.js');
    const ParkClass = Object.values(mod)[0] as new () => EnchantedParks;
    return new ParkClass();
  }

  test('joins feed features to scraped attractions by name', async () => {
    const park = await makeWorldsOfFun();
    (park as any).liveStatusEndpoint = 'https://example.invalid/graphql';
    (park as any).liveStatusApiKey = 'test-key';
    (park as any).liveStatusSiteIds = ['test-site'];
    (park as any).getFeatures = async (): Promise<LiveFeature[]> => [
      {name: 'WOF - Mamba', siteId: 'test-site', operationalStatus: 'Open'},
      {name: 'WOF - Prowler', siteId: 'test-site', operationalStatus: 'Temporarily Closed'},
      {name: 'OOF - Typhoon', siteId: 'test-site', operationalStatus: 'Closed'},
      {name: 'WOF - Ticket Sales', siteId: 'test-site', operationalStatus: 'Open'},
    ];
    (park as any).scrapeAttractions = async (path: string) =>
      path === 'oceans-of-fun'
        ? [{slug: 'typhoon', name: 'Typhoon'}]
        : [{slug: 'mamba', name: 'Mamba'}, {slug: 'prowler', name: 'Prowler'}];

    const live = await (park as any).buildLiveData();
    const byId = Object.fromEntries(live.map((l: any) => [l.id, l.status]));

    expect(byId['enchantedparks_attraction_WOF_mamba']).toBe('OPERATING');
    expect(byId['enchantedparks_attraction_WOF_prowler']).toBe('DOWN');
    expect(byId['enchantedparks_attraction_OOF_typhoon']).toBe('CLOSED');
    // Ticket Sales has no scraped ride entity → dropped.
    expect(live).toHaveLength(3);
  });

  test('returns no live data when the endpoint/key are unset', async () => {
    const park = await makeWorldsOfFun();
    (park as any).liveStatusEndpoint = '';
    (park as any).liveStatusApiKey = '';
    (park as any).getFeatures = async () => [
      {name: 'WOF - Mamba', siteId: 'test-site', operationalStatus: 'Open'},
    ];
    expect(await (park as any).buildLiveData()).toEqual([]);
  });
});

describe('scrapeTtl', () => {
  const DAY = 60 * 60 * 24;
  const HALF_DAY = 60 * 60 * 12;

  /**
   * The schedule scrape swallows a failure and returns `[]`, and the listing
   * scrapes used to as well. Remembering an empty answer for a full TTL is
   * what turned a single failed fetch into Mid-America Parks publishing 3
   * entities against 76, and why correcting the host did not take effect
   * until the cache expired. (Listing scrapes now throw instead; see the
   * water-park tests below.) Observed the same day on the schedule scrape:
   * the destination served 0 operating days until an empty entry was dropped,
   * then 60.
   */
  it('holds an empty result for minutes, not the full TTL', () => {
    expect(scrapeTtl(DAY)([])).toBe(60 * 15);
    expect(scrapeTtl(HALF_DAY)([])).toBe(60 * 15);
  });

  it('keeps a real listing for the caller\'s own TTL', () => {
    const rows = [{slug: 'american-thunder', name: 'American Thunder'}];
    expect(scrapeTtl(DAY)(rows)).toBe(DAY);
    expect(scrapeTtl(HALF_DAY)(rows)).toBe(HALF_DAY);
  });

  it('treats a single row as a real answer — one ride is an answer', () => {
    expect(scrapeTtl(DAY)([{slug: 'a', name: 'A'}])).toBe(DAY);
  });

  /**
   * Empty is not always broken: a park out of season publishes no calendar,
   * and a waterpark has no shows. Verified 2026-09-09 — michigansadventure and
   * galvestonislandwaterpark both return 0 schedule days from a clean fetch. So an
   * empty answer is still cached, just briefly.
   */
  it('still caches an empty result, rather than refetching every call', () => {
    expect(scrapeTtl(DAY)([])).toBeGreaterThan(0);
  });
});

describe('water-park listing failure (buildEntityList)', () => {
  // Card markup as served on the parks' `/rides-and-experiences/<path>/`
  // listings (sanitised, trimmed to a handful of cards). The master
  // `attractions` page lists every ride, water-park ones included; the
  // water-park page lists only its own. Water-park membership is decided by
  // the second page, so if it fails the first must not be read alone.
  const card = (slug: string, name: string) => `
<article id="post-1" class="item item-1 parallax-banner">
      <a href="https://example.test/rides-and-experiences/attractions/${slug}/"><img decoding="async" class="parallax" src="x.webp" alt="${name}" /></a>
    <div class="overlay"></div>
  <div class="container">
    <h3>${name}</h3>
        <p>Blurb.</p>
      </div>
  <div class="more">
    <a class="cta outline contact" href="https://example.test/rides-and-experiences/attractions/${slug}/">Details</a>
  </div>
</article>`;
  const page = (...cards: string[]) =>
    `<!doctype html><html><body><div class="col span6">${cards.join('</div><div class="col span6">')}</div></body></html>`;
  const MASTER = page(
    card('american-thunder', 'American Thunder'),
    card('big-kahuna', 'Big Kahuna'),
    card('hurricane-bay', 'Hurricane Bay'),
    card('screamin-eagle', 'Screamin&#8217; Eagle'),
  );
  const WATER = page(card('big-kahuna', 'Big Kahuna'), card('hurricane-bay', 'Hurricane Bay'));
  const EMPTY = page();

  // WP REST shapes, sanitised from the live API:
  //   categories?slug=hurricane-harbor&_fields=id,slug → [{"id":388,"slug":"hurricane-harbor"}]
  //   pages?categories=388&_fields=slug,link → [{"slug":…,"link":"…/rides-and-experiences/attractions/<slug>/"}]
  type WpStub = {category?: unknown[] | Error; pages?: Array<WpPage[] | Error>; totalPages?: number};
  const wpDown = () => new Error('GET https://example.test/wp-json/wp/v2/categories: HTTP request not OK: 503 ');
  const CATEGORY = [{id: 388, slug: 'hurricane-harbor'}];
  const wpPage = (slug: string, segment = 'attractions'): WpPage =>
    ({slug, link: `https://example.test/rides-and-experiences/${segment}/${slug}/`});
  const CATEGORY_PAGES = [wpPage('big-kahuna'), wpPage('hurricane-bay')];

  let run = 0;
  /**
   * A Mid-America Parks instance whose listing fetches are served from
   * `pages` (path → html, or an Error to throw). Each instance gets its own
   * cache prefix so one test's cached scrape cannot answer another's.
   */
  async function makePark(
    pages: Record<string, string | Error>,
    wp: WpStub = {category: wpDown()},
  ): Promise<{park: EnchantedParks; fetched: string[]; wpFetched: string[]}> {
    const mod = await import('../midamericaparks.js');
    const ParkClass = Object.values(mod)[0] as new () => EnchantedParks;
    const park = new ParkClass();
    const prefix = `test-waterpark-${Date.now()}-${run++}`;
    (park as any).getCacheKeyPrefix = () => prefix;
    const fetched: string[] = [];
    (park as any).fetchAttractionsPage = async (path: string) => {
      fetched.push(path);
      const body = pages[path];
      if (body instanceof Error) throw body;
      if (body === undefined) throw new Error(`HTTP request not OK: 404 Not Found\n  URL: GET /${path}/`);
      return {text: async () => body};
    };
    // WP REST category fallback. `wp` is read at call time so a test can
    // change what upstream serves between builds.
    const wpFetched: string[] = [];
    (park as any).fetchWpCategory = async (slug: string) => {
      wpFetched.push(`category:${slug}`);
      if (wp.category instanceof Error) throw wp.category;
      const body = wp.category;
      return {json: async () => body};
    };
    (park as any).fetchWpCategoryPages = async (id: number, n: number) => {
      wpFetched.push(`pages:${id}:${n}`);
      const body = wp.pages?.[n - 1];
      if (body instanceof Error) throw body;
      if (body === undefined) throw new Error('HTTP request not OK: 400 (rest_post_invalid_page_number)');
      const headers = new Headers(wp.totalPages !== undefined ? {'x-wp-totalpages': String(wp.totalPages)} : {});
      return {json: async () => body, response: {headers}};
    };
    return {park, fetched, wpFetched};
  }
  // Shape of the error the HTTP layer rejects with: the URL leads the first line.
  const notFound = () => new Error('GET https://example.test/rides-and-experiences/x/: HTTP request not OK: 404 \n  URL: GET https://example.test/rides-and-experiences/x/');
  const base = {'attractions': MASTER, 'dining': EMPTY, 'live-entertainment': EMPTY};

  test('a failed water-park page with a failed category fallback rejects instead of re-homing its rides', async () => {
    const {park} = await makePark({...base, 'hurricane-harbor-water-park': notFound()});
    await expect((park as any).buildEntityList()).rejects.toThrow(/hurricane-harbor-water-park/);
  });

  test('the rejection names the path but not the host', async () => {
    const {park} = await makePark({...base, 'hurricane-harbor-water-park': notFound()});
    const err = await (park as any).buildEntityList().catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('404');
    expect(err.message).not.toContain('example.test');
  });

  test('a water-park page that parses to no rides, with the category fallback also failing, rejects', async () => {
    // A 200 with no cards (page emptied or restyled) would re-home the same
    // rides as a 404 does.
    const {park} = await makePark({...base, 'hurricane-harbor-water-park': EMPTY});
    await expect((park as any).buildEntityList()).rejects.toThrow(/0 rides/);
  });

  test('a working water-park page claims its slugs, and the theme park keeps only the rest', async () => {
    const {park} = await makePark({...base, 'hurricane-harbor-water-park': WATER});
    const entities: any[] = await (park as any).buildEntityList();
    const ids = entities.map(e => e.id).sort();
    expect(ids).toEqual([
      'enchantedparks_attraction_HH_big-kahuna',
      'enchantedparks_attraction_HH_hurricane-bay',
      'enchantedparks_attraction_MAP_american-thunder',
      'enchantedparks_attraction_MAP_screamin-eagle',
      'enchantedparks_park_HH',
      'enchantedparks_park_MAP',
    ]);
    const hh = entities.filter(e => e.parentId === 'enchantedparks_park_HH');
    expect(hh.map(e => e.name).sort()).toEqual(['Big Kahuna', 'Hurricane Bay']);
  });

  test('a failure is not cached: the next build fetches again and succeeds', async () => {
    const pages: Record<string, string | Error> = {...base, 'hurricane-harbor-water-park': notFound()};
    const {park, fetched} = await makePark(pages);
    await expect((park as any).buildEntityList()).rejects.toThrow();

    pages['hurricane-harbor-water-park'] = WATER;
    const entities: any[] = await (park as any).buildEntityList();
    expect(fetched.filter(p => p === 'hurricane-harbor-water-park')).toHaveLength(2);
    expect(entities.filter(e => e.parentId === 'enchantedparks_park_HH')).toHaveLength(2);
  });

  test('a successful scrape is cached: the next build does not refetch', async () => {
    // The counterpart to the test above, so it cannot pass just because
    // nothing is ever cached.
    const {park, fetched} = await makePark({...base, 'hurricane-harbor-water-park': WATER});
    await (park as any).buildEntityList();
    await (park as any).buildEntityList();
    expect(fetched.filter(p => p === 'hurricane-harbor-water-park')).toHaveLength(1);
  });

  test('a failed master attractions page rejects the build', async () => {
    const {park} = await makePark({...base, 'attractions': notFound(), 'hurricane-harbor-water-park': WATER});
    await expect((park as any).buildEntityList()).rejects.toThrow(/"attractions"/);
  });

  test('a failed dining page rejects the build instead of dropping every restaurant', async () => {
    const {park} = await makePark({...base, 'dining': notFound(), 'hurricane-harbor-water-park': WATER});
    await expect((park as any).buildEntityList()).rejects.toThrow(/"dining"/);
  });

  test('a failed shows page rejects the build instead of dropping every show', async () => {
    const {park} = await makePark({...base, 'live-entertainment': notFound(), 'hurricane-harbor-water-park': WATER});
    await expect((park as any).buildEntityList()).rejects.toThrow(/"live-entertainment"/);
  });

  test('live data stays isolated: listing and category both failing yields no live data, not a throw', async () => {
    const {park} = await makePark({...base, 'hurricane-harbor-water-park': notFound()});
    (park as any).liveStatusEndpoint = 'https://example.invalid/graphql';
    (park as any).liveStatusApiKey = 'test-key';
    (park as any).liveStatusSiteIds = ['test-site'];
    (park as any).getFeatures = async (): Promise<LiveFeature[]> => [
      {name: 'SFSTL - Big Kahuna', siteId: 'test-site', operationalStatus: 'Open'},
      {name: 'SFSTL - American Thunder', siteId: 'test-site', operationalStatus: 'Open'},
    ];
    const warn = console.warn;
    console.warn = () => {};
    try {
      // Never Big Kahuna under the theme-park id.
      expect(await (park as any).buildLiveData()).toEqual([]);
    } finally {
      console.warn = warn;
    }
  });

  test('live data with a working water-park page attaches rides to the right park', async () => {
    const {park} = await makePark({...base, 'hurricane-harbor-water-park': WATER});
    (park as any).liveStatusEndpoint = 'https://example.invalid/graphql';
    (park as any).liveStatusApiKey = 'test-key';
    (park as any).liveStatusSiteIds = ['test-site'];
    (park as any).getFeatures = async (): Promise<LiveFeature[]> => [
      {name: 'SFSTL - Big Kahuna', siteId: 'test-site', operationalStatus: 'Open'},
      {name: 'SFSTL - American Thunder', siteId: 'test-site', operationalStatus: 'Open'},
    ];
    const live: any[] = await (park as any).buildLiveData();
    expect(live.map(l => l.id).sort()).toEqual([
      'enchantedparks_attraction_HH_big-kahuna',
      'enchantedparks_attraction_MAP_american-thunder',
    ]);
  });

  // ----- WP REST category fallback -----

  /** Run `fn` with console.warn captured; returns what was warned. */
  async function captureWarn<T>(fn: () => Promise<T>): Promise<{result: T; warnings: string[]}> {
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
    try {
      return {result: await fn(), warnings};
    } finally {
      console.warn = warn;
    }
  }
  const HH_IDS = ['enchantedparks_attraction_HH_big-kahuna', 'enchantedparks_attraction_HH_hurricane-bay'];
  const MAP_IDS = ['enchantedparks_attraction_MAP_american-thunder', 'enchantedparks_attraction_MAP_screamin-eagle'];
  const ridesOf = (entities: any[], parkId: string) =>
    entities.filter(e => e.entityType === 'ATTRACTION' && e.parentId === parkId).map(e => e.id).sort();

  test('listing 404 + category OK: the water park gets exactly the category rides, the theme park none of them', async () => {
    const {park} = await makePark(
      {...base, 'hurricane-harbor-water-park': notFound()},
      {category: CATEGORY, pages: [CATEGORY_PAGES], totalPages: 1},
    );
    const {result: entities} = await captureWarn(() => (park as any).buildEntityList());
    expect(ridesOf(entities as any[], 'enchantedparks_park_HH')).toEqual(HH_IDS);
    expect(ridesOf(entities as any[], 'enchantedparks_park_MAP')).toEqual(MAP_IDS);
    // Names come from the master listing, not the WP page record.
    const kahuna = (entities as any[]).find(e => e.id === 'enchantedparks_attraction_HH_big-kahuna');
    expect(kahuna.name).toBe('Big Kahuna');
  });

  test('the fallback warns once per build with the path and source, but not the host', async () => {
    const {park} = await makePark(
      {...base, 'hurricane-harbor-water-park': notFound()},
      {category: CATEGORY, pages: [CATEGORY_PAGES], totalPages: 1},
    );
    const {warnings} = await captureWarn(() => (park as any).buildEntityList());
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('hurricane-harbor-water-park');
    expect(warnings[0]).toContain('category "hurricane-harbor"');
    expect(warnings[0]).not.toContain('example.test');
  });

  test('a dead listing is not re-requested for an hour once the category stands in, and warns once', async () => {
    // Mid-America's listing is unpublished: without this, every entity build and
    // every live tick would re-request it and log the failure.
    vi.useFakeTimers({toFake: ['Date']});
    vi.setSystemTime(new Date('2026-09-26T16:00:00Z'));
    try {
      const {park, fetched} = await makePark(
        {...base, 'hurricane-harbor-water-park': notFound()},
        {category: CATEGORY, pages: [CATEGORY_PAGES], totalPages: 1},
      );
      const first = await captureWarn(() => (park as any).buildEntityList());
      const second = await captureWarn(() => (park as any).buildEntityList());
      expect(fetched.filter(p => p === 'hurricane-harbor-water-park')).toHaveLength(1);
      expect(first.warnings).toHaveLength(1);
      expect(second.warnings).toHaveLength(0);
      expect(ridesOf(second.result as any[], 'enchantedparks_park_HH')).toEqual(HH_IDS);

      // After the hour the listing is tried again.
      vi.setSystemTime(new Date('2026-09-26T17:00:01Z'));
      await captureWarn(() => (park as any).buildEntityList());
      expect(fetched.filter(p => p === 'hurricane-harbor-water-park')).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a recovered listing is used again as soon as it is retried', async () => {
    vi.useFakeTimers({toFake: ['Date']});
    vi.setSystemTime(new Date('2026-09-26T16:00:00Z'));
    try {
      const pages: Record<string, string | Error> = {...base, 'hurricane-harbor-water-park': notFound()};
      const {park} = await makePark(pages, {category: CATEGORY, pages: [CATEGORY_PAGES], totalPages: 1});
      await captureWarn(() => (park as any).buildEntityList());
      pages['hurricane-harbor-water-park'] = WATER;
      vi.setSystemTime(new Date('2026-09-26T17:00:01Z'));
      const {result} = await captureWarn(() => (park as any).resolveParkRides());
      expect((result as any).waterSource).toBe('listing');
    } finally {
      vi.useRealTimers();
    }
  });

  test('a listing is not skipped when the category also failed', async () => {
    // Nothing stood in, so the next build must try the listing again.
    const {park, fetched} = await makePark({...base, 'hurricane-harbor-water-park': notFound()});
    await expect((park as any).buildEntityList()).rejects.toThrow();
    await expect((park as any).buildEntityList()).rejects.toThrow();
    expect(fetched.filter(p => p === 'hurricane-harbor-water-park')).toHaveLength(2);
  });

  test('listing empty + category OK: same result as a 404', async () => {
    const {park} = await makePark(
      {...base, 'hurricane-harbor-water-park': EMPTY},
      {category: CATEGORY, pages: [CATEGORY_PAGES], totalPages: 1},
    );
    const {result: entities} = await captureWarn(() => (park as any).buildEntityList());
    expect(ridesOf(entities as any[], 'enchantedparks_park_HH')).toEqual(HH_IDS);
    expect(ridesOf(entities as any[], 'enchantedparks_park_MAP')).toEqual(MAP_IDS);
  });

  test('a working listing never consults the category', async () => {
    const {park, wpFetched} = await makePark(
      {...base, 'hurricane-harbor-water-park': WATER},
      {category: CATEGORY, pages: [CATEGORY_PAGES], totalPages: 1},
    );
    await (park as any).buildEntityList();
    expect(wpFetched).toEqual([]);
  });

  test('listing and category both failing rejects, naming both', async () => {
    const {park} = await makePark({...base, 'hurricane-harbor-water-park': notFound()}, {category: wpDown()});
    const err = await (park as any).buildEntityList().catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('hurricane-harbor-water-park');
    expect(err.message).toMatch(/fallback category "hurricane-harbor" could not be resolved/);
    expect(err.message).not.toContain('example.test');
  });

  test('an unknown category (empty lookup) counts as a failure', async () => {
    const {park} = await makePark({...base, 'hurricane-harbor-water-park': notFound()}, {category: []});
    await expect((park as any).buildEntityList()).rejects.toThrow(/category not found/);
  });

  test('a category with zero pages counts as a failure', async () => {
    const {park} = await makePark(
      {...base, 'hurricane-harbor-water-park': notFound()},
      {category: CATEGORY, pages: [[]], totalPages: 0},
    );
    await expect((park as any).buildEntityList()).rejects.toThrow(/no ride pages tagged/);
  });

  test('a category whose rides are not on the master list counts as a failure', async () => {
    const {park} = await makePark(
      {...base, 'hurricane-harbor-water-park': notFound()},
      {category: CATEGORY, pages: [[wpPage('not-a-listed-ride')]], totalPages: 1},
    );
    await expect(captureWarn(() => (park as any).buildEntityList())).rejects.toThrow(/matched no rides/);
  });

  test('category pagination follows X-WP-TotalPages', async () => {
    const {park, wpFetched} = await makePark(
      {...base, 'hurricane-harbor-water-park': notFound()},
      {category: CATEGORY, pages: [[wpPage('big-kahuna')], [wpPage('hurricane-bay')]], totalPages: 2},
    );
    const {result: entities} = await captureWarn(() => (park as any).buildEntityList());
    expect(wpFetched).toEqual(['category:hurricane-harbor', 'pages:388:1', 'pages:388:2']);
    expect(ridesOf(entities as any[], 'enchantedparks_park_HH')).toEqual(HH_IDS);
  });

  test('without the header, pagination stops on a short page', async () => {
    const full = Array.from({length: 100}, (_, i) => wpPage(`filler-${i}`));
    const {park, wpFetched} = await makePark(
      {...base, 'hurricane-harbor-water-park': notFound()},
      {category: CATEGORY, pages: [[...full.slice(0, 98), wpPage('big-kahuna'), wpPage('hurricane-bay')], [wpPage('tube-slides')]]},
    );
    const {result: entities} = await captureWarn(() => (park as any).buildEntityList());
    expect(wpFetched).toEqual(['category:hurricane-harbor', 'pages:388:1', 'pages:388:2']);
    expect(ridesOf(entities as any[], 'enchantedparks_park_HH')).toEqual(HH_IDS);
  });

  test('a category failure is not cached: the next build retries it and succeeds', async () => {
    const wp: WpStub = {category: wpDown()};
    const {park, wpFetched} = await makePark({...base, 'hurricane-harbor-water-park': notFound()}, wp);
    await expect((park as any).buildEntityList()).rejects.toThrow();

    wp.category = CATEGORY;
    wp.pages = [CATEGORY_PAGES];
    wp.totalPages = 1;
    const {result: entities} = await captureWarn(() => (park as any).buildEntityList());
    expect(wpFetched.filter(f => f.startsWith('category:'))).toHaveLength(2);
    expect(ridesOf(entities as any[], 'enchantedparks_park_HH')).toEqual(HH_IDS);
  });

  test('a resolved category is cached: the next build does not refetch it', async () => {
    const {park, wpFetched} = await makePark(
      {...base, 'hurricane-harbor-water-park': notFound()},
      {category: CATEGORY, pages: [CATEGORY_PAGES], totalPages: 1},
    );
    await captureWarn(async () => {
      await (park as any).buildEntityList();
      await (park as any).buildEntityList();
    });
    expect(wpFetched.filter(f => f.startsWith('category:'))).toHaveLength(1);
  });

  test('live data uses the fallback instead of blacking out the destination', async () => {
    const {park} = await makePark(
      {...base, 'hurricane-harbor-water-park': notFound()},
      {category: CATEGORY, pages: [CATEGORY_PAGES], totalPages: 1},
    );
    (park as any).liveStatusEndpoint = 'https://example.invalid/graphql';
    (park as any).liveStatusApiKey = 'test-key';
    (park as any).liveStatusSiteIds = ['test-site'];
    (park as any).getFeatures = async (): Promise<LiveFeature[]> => [
      {name: 'SFSTL - Big Kahuna', siteId: 'test-site', operationalStatus: 'Open'},
      {name: 'SFSTL - American Thunder', siteId: 'test-site', operationalStatus: 'Open'},
    ];
    const {result: live} = await captureWarn(() => (park as any).buildLiveData());
    expect((live as any[]).map(l => l.id).sort()).toEqual([
      'enchantedparks_attraction_HH_big-kahuna',
      'enchantedparks_attraction_MAP_american-thunder',
    ]);
  });
});

describe('water-park listing paths', () => {
  // Michigan's Adventure's old water-park path now 301s to a calendar event
  // page; the @http layer treats a 3xx as a failure, so the old value would
  // reject every entity build.
  test("Michigan's Adventure points at the current water-park listing", async () => {
    const mod = await import('../michigansadventure.js');
    const ParkClass = Object.values(mod)[0] as new () => EnchantedParks;
    const park = new ParkClass();
    expect(park.waterPark?.ridesPath).toBe('wildwater-adventure-waterpark');
  });
});

describe('parseCategoryRideSlugs', () => {
  test('takes the slug from the attraction link, skipping non-attraction pages', () => {
    expect(parseCategoryRideSlugs([
      {slug: 'tube-slides', link: 'https://example.test/rides-and-experiences/attractions/tube-slides/'},
      {slug: 'beach-bites', link: 'https://example.test/rides-and-experiences/dining/beach-bites/'},
      {slug: 'hurricane-harbor', link: 'https://example.test/hurricane-harbor/'},
      {slug: 'tube-slides', link: 'https://example.test/rides-and-experiences/attractions/tube-slides/'},
    ])).toEqual(['tube-slides']);
  });

  test('tolerates malformed records', () => {
    expect(parseCategoryRideSlugs([{slug: 'x'} as any, null as any])).toEqual([]);
  });
});

describe('water-park category config', () => {
  // Category slugs verified against the live WP REST API on 2026-09-26: each
  // one's attraction pages match the water park's listing slugs. Valleyfair's
  // category exists but tags nothing, so it is deliberately unset.
  const load: Record<string, () => Promise<Record<string, unknown>>> = {
    midamericaparks: () => import('../midamericaparks.js'),
    michigansadventure: () => import('../michigansadventure.js'),
    greatescapeparks: () => import('../greatescapeparks.js'),
    worldsoffun: () => import('../worldsoffun.js'),
    valleyfair: () => import('../valleyfair.js'),
  };
  test.each([
    ['midamericaparks', 'hurricane-harbor'],
    ['michigansadventure', 'wildwater'],
    ['greatescapeparks', undefined],  // category and listing disagree on one ride
    ['worldsoffun', 'oceans-of-fun'],
    ['valleyfair', undefined],
  ])('%s water park ridesCategory is %s', async (file, expected) => {
    const mod = await load[file]();
    const ParkClass = Object.values(mod)[0] as new () => EnchantedParks;
    expect(new ParkClass().waterPark?.ridesCategory).toBe(expected);
  });
});

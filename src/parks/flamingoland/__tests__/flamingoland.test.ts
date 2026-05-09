/**
 * Unit tests for Flamingo Land pure helpers.
 *
 * The class itself is integration-tested via `npm run dev -- flamingoland`.
 * The substantive logic lives in module-scope pure functions so it can be
 * exercised here without Firebase, the HTTP queue, or live network access.
 */
import {describe, test, expect} from 'vitest';
import {
  fsInt,
  isoDateInTimezone,
  parseTodayCloseBanner,
  parseSeasonWindow,
  parseMapMarkers,
  findMarkerForRide,
  decideRideStatus,
  iterateScheduleDays,
  type Marker,
  type SeasonWindow,
} from '../flamingoland.js';

describe('fsInt', () => {
  test('parses integerValue strings', () => {
    expect(fsInt({integerValue: '42'})).toBe(42);
    expect(fsInt({integerValue: '-7'})).toBe(-7);
  });

  test('uses doubleValue when integerValue is absent', () => {
    expect(fsInt({doubleValue: 91.44})).toBe(91.44);
  });

  test('returns undefined for missing fields', () => {
    expect(fsInt(undefined)).toBeUndefined();
    expect(fsInt({})).toBeUndefined();
  });

  test('returns undefined for non-finite values (Copilot review fix)', () => {
    // The defensive guard exists so callers that check `!== undefined` don't
    // accidentally treat NaN as a valid value.
    expect(fsInt({integerValue: 'not-a-number'})).toBeUndefined();
    expect(fsInt({integerValue: ''})).toBeUndefined();
    expect(fsInt({doubleValue: NaN})).toBeUndefined();
    expect(fsInt({doubleValue: Infinity})).toBeUndefined();
  });
});

describe('isoDateInTimezone', () => {
  test('formats UTC instant in Europe/London during BST', () => {
    // 2026-07-15 10:00 UTC — London is BST (UTC+1) → still 2026-07-15
    const d = new Date('2026-07-15T10:00:00Z');
    expect(isoDateInTimezone(d, 'Europe/London')).toBe('2026-07-15');
  });

  test('formats UTC instant in Europe/London during GMT', () => {
    const d = new Date('2026-12-25T10:00:00Z');
    expect(isoDateInTimezone(d, 'Europe/London')).toBe('2026-12-25');
  });

  test('respects timezone difference at day boundaries', () => {
    // 2026-05-09 23:30 UTC = 2026-05-10 09:30 in Tokyo
    const d = new Date('2026-05-09T23:30:00Z');
    expect(isoDateInTimezone(d, 'Asia/Tokyo')).toBe('2026-05-10');
  });
});

describe('parseTodayCloseBanner', () => {
  test('parses "5PM" → "17:00"', () => {
    const html = '<div class="swiper-slide">Today the Theme Park will close at 5PM </div>';
    expect(parseTodayCloseBanner(html)).toBe('17:00');
  });

  test('parses "5:30PM" with minutes', () => {
    const html = 'Today the Theme Park will close at 5:30PM';
    expect(parseTodayCloseBanner(html)).toBe('17:30');
  });

  test('parses "10AM" → "10:00"', () => {
    expect(parseTodayCloseBanner('Today the Theme Park will close at 10AM')).toBe('10:00');
  });

  test('parses "12AM" → "00:00" and "12PM" → "12:00"', () => {
    expect(parseTodayCloseBanner('Today the Theme Park will close at 12AM')).toBe('00:00');
    expect(parseTodayCloseBanner('Today the Theme Park will close at 12PM')).toBe('12:00');
  });

  test('returns null when banner is absent', () => {
    expect(parseTodayCloseBanner('<html><body>nothing relevant</body></html>')).toBeNull();
  });

  test('rejects "open at" banner (Copilot review fix)', () => {
    // Reusing the morning "open at" time as today's close would corrupt the
    // schedule entry to e.g. open=10:00 close=10:00. Only "close at" parses.
    const html = 'Today the Theme Park will open at 10AM';
    expect(parseTodayCloseBanner(html)).toBeNull();
  });

  test('is case-insensitive on AM/PM', () => {
    expect(parseTodayCloseBanner('Today the Theme Park will close at 5pm')).toBe('17:00');
  });
});

describe('parseSeasonWindow', () => {
  test('parses the canonical webshop blurb', () => {
    const html = '<span>Open daily from 10am between 21st March and 1st November 2026.</span>';
    expect(parseSeasonWindow(html)).toEqual({
      start: '2026-03-21',
      end: '2026-11-01',
      openHour: 10,
    });
  });

  test('handles missing day-suffix ordinals', () => {
    const html = 'Open daily from 9am between 1 April and 30 October 2026.';
    expect(parseSeasonWindow(html)).toEqual({
      start: '2026-04-01',
      end: '2026-10-30',
      openHour: 9,
    });
  });

  test('parses pm openings', () => {
    const html = 'Open daily from 1pm between 1st June and 31st August 2026.';
    expect(parseSeasonWindow(html)?.openHour).toBe(13);
  });

  test('returns null when blurb is absent', () => {
    expect(parseSeasonWindow('<html>nothing</html>')).toBeNull();
  });

  test('returns null when month name is invalid', () => {
    const html = 'Open daily from 10am between 21st Marchish and 1st Nov 2026.';
    expect(parseSeasonWindow(html)).toBeNull();
  });
});

describe('parseMapMarkers', () => {
  const fixture = `markersData = [{
    id: '216',
    icon: 'markers/47.png',
    title: 'Splash Battle',
    display_name: 'Splash Battle',
    lat: 54.21071676426168,
    lng: -0.8069901885986397,
    position:{lat:54.21071676426168,lng:-0.8069901885986397},
    area: 'splosh',
    type: 'ride',
  },
  {
    id: '378',
    icon: 'markers/04.png',
    title: 'The Club, Zoo Bar and Street Food Kitchen',
    display_name: 'The Club, Zoo Bar and Street Food Kitchen',
    lat: 54.21186750470534,
    lng: -0.8092216663360507,
    position:{lat:54.21186750470534,lng:-0.8092216663360507},
    area: 'riverside_one',
    type: 'info',
  },
  {
    id: '999',
    icon: 'markers/x.png',
    title: 'Children\\'s Planet Shop',
    display_name: 'Children\\'s Planet Shop',
    lat: 54.206621990407285,
    lng: -0.8078349814414998,
    position:{lat:54.206621990407285,lng:-0.8078349814414998},
    area: 'kids',
    type: 'info',
  }];`;

  test('extracts each marker with id, title, lat, lng, type', () => {
    const out = parseMapMarkers(fixture);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({
      id: '216',
      title: 'Splash Battle',
      lat: 54.21071676426168,
      lng: -0.8069901885986397,
      type: 'ride',
    });
    expect(out[1].type).toBe('info');
    expect(out[1].title).toContain('Zoo Bar');
  });

  test('decodes \\\' escaped apostrophes inside titles', () => {
    const out = parseMapMarkers(fixture);
    expect(out[2].title).toBe("Children's Planet Shop");
  });

  test('returns empty array on input with no markers', () => {
    expect(parseMapMarkers('<html>no markers here</html>')).toEqual([]);
  });

  test('skips markers with NaN coordinates', () => {
    // Defensive: malformed lat/lng shouldn't yield a marker.
    const bad = `markersData = [{id:'1',title:'x',lat:'nope',lng:'nope',type:'ride'}];`;
    expect(parseMapMarkers(bad)).toEqual([]);
  });
});

describe('findMarkerForRide', () => {
  const markers: Marker[] = [
    {id: '216', title: 'Splash Battle', lat: 1, lng: 2, type: 'ride'},
    {id: '301', title: 'Sik', lat: 3, lng: 4, type: 'ride'},
    {id: '302', title: 'Sik Shop', lat: 5, lng: 6, type: 'info'},
    {id: '400', title: 'Pirates of Zanzibar Show and Farewell Show', lat: 7, lng: 8, type: 'show'},
    {id: '500', title: "Children's Planet Shop", lat: 9, lng: 10, type: 'info'},
  ];

  test('returns the marker whose id matches the ride.parkMapMarkerId', () => {
    expect(findMarkerForRide('Splash Battle', '216', markers)?.id).toBe('216');
  });

  test('id-match wins over title clashes', () => {
    // Even if another marker has the same title, the id pin is authoritative.
    const m: Marker[] = [
      {id: '11', title: 'Sik', lat: 0, lng: 0, type: 'ride'},
      {id: '99', title: 'Sik', lat: 9, lng: 9, type: 'info'},
    ];
    expect(findMarkerForRide('Sik', '99', m)?.id).toBe('99');
  });

  test('falls back to exact-title match when id is empty/missing', () => {
    expect(findMarkerForRide('Sik', undefined, markers)?.id).toBe('301');
    expect(findMarkerForRide('Sik', '', markers)?.id).toBe('301');
  });

  test('exact-title match prefers type=ride over type=info', () => {
    const m: Marker[] = [
      {id: '1', title: 'Sik', lat: 0, lng: 0, type: 'info'},
      {id: '2', title: 'Sik', lat: 0, lng: 0, type: 'ride'},
    ];
    expect(findMarkerForRide('Sik', undefined, m)?.id).toBe('2');
  });

  test('falls back to prefix match when no exact title hit', () => {
    expect(findMarkerForRide('Pirates of Zanzibar', undefined, markers)?.id).toBe('400');
  });

  test('prefix match across apostrophe encoding (curly vs straight)', () => {
    expect(findMarkerForRide('Children’s Planet', undefined, markers)?.id).toBe('500');
  });

  test('returns undefined when no candidate matches', () => {
    expect(findMarkerForRide('Nonexistent Ride', undefined, markers)).toBeUndefined();
  });
});

describe('decideRideStatus', () => {
  test('REFURBISHMENT takes precedence over everything', () => {
    expect(decideRideStatus({statusOpen: true, underMaintenance: true, downAllDay: true})).toBe('REFURBISHMENT');
    expect(decideRideStatus({statusOpen: false, underMaintenance: true, downAllDay: false})).toBe('REFURBISHMENT');
  });

  test('!statusOpen → CLOSED (park-level closure)', () => {
    expect(decideRideStatus({statusOpen: false, underMaintenance: false, downAllDay: false})).toBe('CLOSED');
    expect(decideRideStatus({statusOpen: false, underMaintenance: false, downAllDay: true})).toBe('CLOSED');
  });

  test('downAllDay (with park open) → DOWN, not CLOSED (Copilot review fix)', () => {
    // Before the fix this returned CLOSED, conflating an operational fault with
    // a park-level closure. The typelib has a dedicated DOWN status for this.
    expect(decideRideStatus({statusOpen: true, underMaintenance: false, downAllDay: true})).toBe('DOWN');
  });

  test('default → OPERATING', () => {
    expect(decideRideStatus({statusOpen: true, underMaintenance: false, downAllDay: false})).toBe('OPERATING');
  });
});

describe('iterateScheduleDays', () => {
  const season: SeasonWindow = {start: '2026-03-21', end: '2026-11-01', openHour: 10};

  test('emits one entry per day from todayStr through season end inclusive', () => {
    const out = iterateScheduleDays({
      todayStr: '2026-10-30',
      season,
      todayClose: null,
      defaultClose: '17:00',
      timezone: 'Europe/London',
    });
    expect(out.map(d => d.date)).toEqual(['2026-10-30', '2026-10-31', '2026-11-01']);
    expect(out[2].date).toBe('2026-11-01');
  });

  test('uses scraped todayClose for today, defaultClose for future days', () => {
    const out = iterateScheduleDays({
      todayStr: '2026-10-30',
      season,
      todayClose: '21:00',
      defaultClose: '17:00',
      timezone: 'Europe/London',
    });
    expect(out[0].closingTime).toContain('T21:00:00');
    expect(out[1].closingTime).toContain('T17:00:00');
  });

  test('starts from season.start when today is before the season', () => {
    const out = iterateScheduleDays({
      todayStr: '2026-01-15',
      season,
      todayClose: null,
      defaultClose: '17:00',
      timezone: 'Europe/London',
      maxDays: 3,
    });
    expect(out.map(d => d.date)).toEqual(['2026-03-21', '2026-03-22', '2026-03-23']);
  });

  test('emits no days when today is past season end', () => {
    const out = iterateScheduleDays({
      todayStr: '2026-12-01',
      season,
      todayClose: null,
      defaultClose: '17:00',
      timezone: 'Europe/London',
    });
    expect(out).toEqual([]);
  });

  test('honours the maxDays cap', () => {
    const out = iterateScheduleDays({
      todayStr: '2026-03-21',
      season,
      todayClose: null,
      defaultClose: '17:00',
      timezone: 'Europe/London',
      maxDays: 5,
    });
    expect(out).toHaveLength(5);
  });

  test('opening time follows season.openHour', () => {
    const out = iterateScheduleDays({
      todayStr: '2026-06-15',
      season: {...season, openHour: 9},
      todayClose: null,
      defaultClose: '17:00',
      timezone: 'Europe/London',
      maxDays: 1,
    });
    expect(out[0].openingTime).toContain('T09:00:00');
  });

  test('switches GMT/BST offset across the DST boundary in late October', () => {
    const out = iterateScheduleDays({
      todayStr: '2026-10-24',
      season,
      todayClose: null,
      defaultClose: '17:00',
      timezone: 'Europe/London',
    });
    // Saturday 24 Oct is BST (+01:00); 1 Nov is GMT (+00:00).
    const oct24 = out.find(d => d.date === '2026-10-24');
    const nov01 = out.find(d => d.date === '2026-11-01');
    expect(oct24?.openingTime.endsWith('+01:00')).toBe(true);
    expect(nov01?.openingTime.endsWith('+00:00')).toBe(true);
  });
});

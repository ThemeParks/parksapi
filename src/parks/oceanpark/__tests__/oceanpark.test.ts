/**
 * Unit tests for Ocean Park Hong Kong.
 *
 * The mobile app's API (sop.oceanpark.com.hk) was suspended along with the
 * app; this park now scrapes the public website's server-rendered pages.
 * These tests exercise the pure parsing helpers and the entity/live-data/
 * schedule builders offline, without hitting the real site. Full integration
 * is exercised via `npm run dev -- oceanparkhongkong`.
 */
import {describe, test, expect, vi, beforeEach, afterEach} from 'vitest';
import {
  OceanParkHongKong,
  extractRscArray,
  findMatchingBracket,
  slugFromUrl,
  slugify,
  groupShowsBySlug,
  parseQueueMinutes,
  parseShowTimeSlot,
  parseHourRange,
  addDaysToDateString,
  computeAffineTransform,
  SHOW_ALIASES,} from '../oceanpark.js';

const TZ = 'Asia/Hong_Kong';

// ── extractRscArray / findMatchingBracket ────────────────────────────────────

describe('findMatchingBracket', () => {
  test('finds the matching close bracket for a simple array', () => {
    const str = '[1,2,3]tail';
    expect(findMatchingBracket(str, 0, '[', ']')).toBe(7);
  });

  test('ignores brackets that appear inside a quoted string', () => {
    const str = '[1,"a[b]c",3]tail';
    expect(findMatchingBracket(str, 0, '[', ']')).toBe(13);
  });

  test('honours escaped quotes so a string does not end early', () => {
    // The string value is: a"[not a real close]
    const str = String.raw`[1,"a\"[not a real close]",3]TAIL`;
    const end = findMatchingBracket(str, 0, '[', ']');
    expect(str.slice(end)).toBe('TAIL');
  });

  test('returns -1 when the bracket never closes', () => {
    expect(findMatchingBracket('[1,2,3', 0, '[', ']')).toBe(-1);
  });

  test('an escaped backslash immediately before a real closing quote does not extend the string', () => {
    // The string value is: a\  (a, then a literal backslash) — the quote right
    // after it is real and closes the string, so the following `]` is
    // structural, not part of the string content.
    const str = String.raw`[1,"a\\",3]TAIL`;
    const end = findMatchingBracket(str, 0, '[', ']');
    expect(str.slice(end)).toBe('TAIL');
  });
});

/**
 * Wrap decoded page content as a Next.js flight script chunk, letting
 * JSON.stringify handle the escaping (exactly as the real page does) instead
 * of hand-writing backslashes in fixtures.
 */
function wrapPush(decodedContent: string): string {
  return `<script>self.__next_f.push([1,${JSON.stringify(decodedContent)}])</script>`;
}

describe('extractRscArray', () => {
  test('extracts an array embedded in a single push() chunk', () => {
    const html = wrapPush('preamble junk\n"items":[{"nodeId":"abc"}]tail');
    const arr = extractRscArray(html, '"items":');
    expect(arr).toEqual([{nodeId: 'abc'}]);
  });

  test('skips non-matching push() chunks and finds the marker in a later one', () => {
    const html = wrapPush('unrelated chunk with no marker') +
      wrapPush('"items":[{"nodeId":"xyz"}]');
    const arr = extractRscArray(html, '"items":');
    expect(arr).toEqual([{nodeId: 'xyz'}]);
  });

  test('handles description text containing raw brackets without breaking the parse', () => {
    const html = wrapPush('"items":[{"description":"See the [Summit] show","nodeId":"1"}]');
    const arr = extractRscArray(html, '"items":') as any[];
    expect(arr).toHaveLength(1);
    expect(arr[0].description).toBe('See the [Summit] show');
  });

  test('returns null when there is no self.__next_f.push at all', () => {
    expect(extractRscArray('<html><body>no rsc here</body></html>', '"items":')).toBeNull();
  });

  test('returns null when the marker is never found', () => {
    const html = wrapPush(String.raw`"nothingHere":[1,2,3]`);
    expect(extractRscArray(html, '"items":')).toBeNull();
  });

  test('a validate callback rejects a same-named marker from the wrong widget and keeps scanning', () => {
    // First chunk's "items" array is a nav/breadcrumb list, not the target
    // shape; a validator checking for the expected key should skip it and
    // find the real one in a later chunk.
    const html = wrapPush('"items":[{"label":"Home"}]') +
      wrapPush('"items":[{"nodeId":"abc"}]');
    const arr = extractRscArray(html, '"items":', (a) => a.length === 0 || (typeof a[0] === 'object' && a[0] !== null && 'nodeId' in (a[0] as object)));
    expect(arr).toEqual([{nodeId: 'abc'}]);
  });

  test('caps scanning on a document larger than the size limit', () => {
    const huge = 'x'.repeat(2_000_001) + wrapPush('"items":[{"nodeId":"abc"}]');
    expect(extractRscArray(huge, '"items":')).toBeNull();
  });

  test('does not hang on many unterminated push() occurrences (quadratic-scan guard)', () => {
    // 500 unterminated push() calls back to back — well past MAX_PUSH_ATTEMPTS.
    // Without the attempt cap this would rescan to end-of-string 500 times.
    const malformed = 'self.__next_f.push(['.repeat(500);
    const start = Date.now();
    expect(extractRscArray(malformed, '"items":')).toBeNull();
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

// ── slugFromUrl / slugify ─────────────────────────────────────────────────

describe('slugFromUrl', () => {
  test('returns the last path segment', () => {
    expect(slugFromUrl('https://www.oceanpark.com.hk/en/a-day-at-the-park/attractions/arctic-blast'))
      .toBe('arctic-blast');
  });

  test('ignores a trailing slash', () => {
    expect(slugFromUrl('https://www.oceanpark.com.hk/en/a-day-at-the-park/dining-shopping/shopping/'))
      .toBe('shopping');
  });

  test('strips a query string before taking the last segment', () => {
    expect(slugFromUrl('https://www.oceanpark.com.hk/en/a-day-at-the-park/attractions/arctic-blast?utm=nav'))
      .toBe('arctic-blast');
  });

  test('strips a fragment before taking the last segment', () => {
    expect(slugFromUrl('https://www.oceanpark.com.hk/en/a-day-at-the-park/attractions/arctic-blast#reviews'))
      .toBe('arctic-blast');
  });
});

describe('slugify', () => {
  test('lowercases and hyphenates spaces/punctuation', () => {
    expect(slugify('Whiskers and Friends Meet (near Waterfront Gift Shop)'))
      .toBe('whiskers-and-friends-meet-near-waterfront-gift-shop');
  });

  test('strips accents', () => {
    expect(slugify('Café Ánimé')).toBe('cafe-anime');
  });

  test('trims leading/trailing hyphens produced by punctuation at the edges', () => {
    expect(slugify('"Marine Wonders"')).toBe('marine-wonders');
  });

  test('returns an empty string for punctuation-only input', () => {
    expect(slugify('!!!')).toBe('');
  });

  test('returns an empty string for empty input', () => {
    expect(slugify('')).toBe('');
  });
});

describe('groupShowsBySlug', () => {
  test('every curated title of every shipped family resolves to that family', () => {
    // Iterates the real table, so a family added with a mismatched id fails
    // here rather than silently never matching.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(SHOW_ALIASES.length).toBeGreaterThan(0);
      for (const family of SHOW_ALIASES) {
        expect(family.id).toBe(slugify(family.id));
        expect(family.location).toBeTruthy();
        // The id must be the slug of the show's bare name, or the table
        // documents one thing and matches another.
        expect(family.titles.map(slugify)).toContain(family.id);
        for (const title of family.titles) {
          expect([...groupShowsBySlug([{title}]).keys()]).toEqual([family.id]);
        }
      }
      expect(warn).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });

  test('curated titles of one family merge into one entity, in any order', () => {
    const rows = [
      {title: 'Gala of Lights', timeSlot: ['19:00:00']},
      {title: 'Gala Of Lights - Winter Celebration', timeSlot: ['20:00:00']},
    ];
    for (const order of [rows, [...rows].reverse()]) {
      const groups = groupShowsBySlug(order);
      expect([...groups.keys()]).toEqual(['gala-of-lights']);
      expect(groups.get('gala-of-lights')!.items).toHaveLength(2);
      // The edition name says more than the bare one.
      expect(groups.get('gala-of-lights')!.title).toBe('Gala Of Lights - Winter Celebration');
    }
  });

  test.each([
    ['ascii dash', 'Gala Of Lights - Lunar Splash Edition'],
    ['colon', 'Gala Of Lights: A Brand New Season'],
    ['em dash', 'Gala Of Lights \u2014 Some Future Edition'],
    ['fullwidth colon', 'Gala Of Lights\uff1aAutumn Spectacular'],
    ['figure dash', 'Gala Of Lights \u2012 Autumn'],
  ])('an unlisted edition (%s) keeps its own id and names the family it looks like', (_label, title) => {
    // Identity is the curated list and nothing else. The warning is the
    // whole mechanism for noticing the table has gone stale, so it has to
    // name the family a human should add the title to.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect([...groupShowsBySlug([{title}]).keys()]).toEqual([slugify(title)]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('looks like a new edition of "gala-of-lights"'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('strand the old id'));
    } finally { warn.mockRestore(); }
  });

  test('a subtitled show of no curated family is flagged differently', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect([...groupShowsBySlug([{title: 'Sea Dreams: Lunar Edition'}]).keys()])
        .toEqual(['sea-dreams-lunar-edition']);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('belongs to no curated family'));
    } finally { warn.mockRestore(); }
  });

  test.each([
    'Penguin Feeding Demonstration',
    'Bulu Boo Trick-or-Treat Party',
    'Chill Out Party 19:30 Special',
    'Gala Of Lights -Lunar Splash',
    'Roving Band (Near Lagoon Platform)',
  ])('an ordinary title raises no staleness warning: %s', title => {
    // An in-word hyphen, a clock, a one-sided dash and a bracketed variant
    // are not subtitles; warning about them would train the reader to ignore
    // the one signal that matters.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect([...groupShowsBySlug([{title}]).keys()]).toEqual([slugify(title)]);
      expect(warn).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });

  test('a row resolves the same way whatever else shares its payload', () => {
    // buildEntityList and buildLiveData fetch the schedule independently and
    // can read different cache generations, so a row's id must never depend
    // on which other rows arrived with it.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const row = {title: 'Gala of Lights', locations: [{location: {id: 'summit'}}]};
      expect([...groupShowsBySlug([row]).keys()]).toEqual(['gala-of-lights']);
      expect([...groupShowsBySlug([row, {title: 'Whiskers Show'}]).keys()])
        .toEqual(['gala-of-lights', 'whiskers-show']);
    } finally { warn.mockRestore(); }
  });

  test('a curated show at an unexpected zone keeps its identity and says so once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const groups = groupShowsBySlug([
        {title: 'Gala of Lights', timeSlot: ['19:00:00'], locations: [{location: {id: 'old-hong-kong'}}]},
        {title: 'Gala of Lights', timeSlot: ['21:00:00'], locations: [{location: {id: 'old-hong-kong'}}]},
      ]);
      expect([...groups.keys()]).toEqual(['gala-of-lights']);
      expect(groups.get('gala-of-lights')!.items).toHaveLength(2);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('check whether the park has reused the name'));
    } finally { warn.mockRestore(); }
  });

  test('keeps distinct parenthetical shows apart', () => {
    const titles = ['Animal Fun Talk (Macaw / Owl)', 'Animal Fun Talk (Sloth / Kinkajou)',
      'Sanrio Meet & Greet (Summit)', 'Sanrio Meet & Greet (Waterfront)'];
    expect([...groupShowsBySlug(titles.map(title => ({title}))).keys()]).toEqual(titles.map(slugify));
  });

  test('a bracketed suffix never collapses onto a curated family name', () => {
    // The real feed ships two different Roving Bands at two different venues
    // and four different Animal Fun Talks, all distinguished only by their
    // brackets. Even with those family names curated, they must stay apart.
    const aliases = [
      {id: 'roving-band', mapKey: 'rovingband', location: 'aqua-city', titles: ['Roving Band']},
      {id: 'animal-fun-talk', mapKey: 'aft', location: 'sloth-friends-studio', titles: ['Animal Fun Talk']},
    ];
    const titles = ['Roving Band (Near Lagoon Platform)', 'Roving Band (Near Ocean Park Tower)',
      'Animal Fun Talk (Macaw / Owl)', 'Animal Fun Talk (Sloth / Kinkajou)'];
    expect([...groupShowsBySlug(titles.map(title => ({title})), aliases).keys()]).toEqual(titles.map(slugify));
  });

  test('a hyphen inside a word is not a subtitle separator', () => {
    const aliases = [{id: 'bulu-boo-trick', mapKey: 'x', location: 'waterfront-plaza', titles: ['Bulu Boo Trick']}];
    const title = 'Bulu Boo Trick-or-Treat Party';
    expect([...groupShowsBySlug([{title}], aliases).keys()]).toEqual([slugify(title)]);
  });

  test('a curated title keeps its identity even when the park moves it', () => {
    // The venue guards the head-matching heuristic, never the curated list.
    // A show moving venue, or upstream refining a zone id, must not fragment
    // the family into the churn this table exists to abolish.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (const id of ['old-hong-kong', 'aqua-city-lagoon', 'aqua-city']) {
        const groups = groupShowsBySlug([{title: 'Gala Of Lights - Winter Celebration', locations: [{location: {id}}]}]);
        expect([...groups.keys()]).toEqual(['gala-of-lights']);
      }
      // The identity holds, but a show at an unexpected zone is still worth
      // saying out loud in case the park reused the name.
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('check whether the park has reused the name'));
    } finally { warn.mockRestore(); }
  });

  test('a bare curated title at a new venue does not collide with its own family', () => {
    // Regression: the bare title's slug IS the canonical id, so refusing it
    // used to drop one of the two rows, order-dependently.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const rows = [
        {title: 'Gala of Lights', timeSlot: ['19:00:00'], locations: [{location: {id: 'aqua-city-lagoon'}}]},
        {title: 'Gala Of Lights - Winter Celebration', timeSlot: ['20:00:00'], locations: [{location: {id: 'aqua-city-lagoon'}}]},
      ];
      for (const order of [rows, [...rows].reverse()]) {
        const groups = groupShowsBySlug(order);
        expect([...groups.keys()]).toEqual(['gala-of-lights']);
        expect(groups.get('gala-of-lights')!.items).toHaveLength(2);
        expect(groups.get('gala-of-lights')!.title).toBe('Gala Of Lights - Winter Celebration');
      }
    } finally { warn.mockRestore(); }
  });

  test('two rows with the identical title always merge, whatever the venue says', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const groups = groupShowsBySlug([
        {title: 'Gala of Lights', timeSlot: ['19:00:00'], locations: [{location: {id: 'aqua-city'}}]},
        {title: 'Gala of Lights', timeSlot: ['21:00:00'], locations: [{location: {id: 'summit'}}]},
      ]);
      expect([...groups.keys()]).toEqual(['gala-of-lights']);
      expect(groups.get('gala-of-lights')!.items.flatMap(i => i.timeSlot!)).toEqual(['19:00:00', '21:00:00']);
    } finally { warn.mockRestore(); }
  });

  test.each([
    ['locations is a bare object', {location: {id: 'aqua-city'}}],
    ['locations is a string', 'aqua-city'],
    ['locations holds null', [null]],
    ['locations holds an empty entry', [{}]],
    ['locations entry has no id', [{location: {}}]],
    ['locations is empty', []],
  ])('a malformed %s never throws out of the grouper', (_label, locations) => {
    // groupShowsBySlug runs inside buildEntityList with no catch around it,
    // so an unvalidated feed shape here takes down the whole entity list.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(() => groupShowsBySlug([{title: 'Gala Of Lights - Lunar Splash', locations} as never])).not.toThrow();
    } finally { warn.mockRestore(); }
  });

  test('keeps two different aliased shows apart instead of merging them', () => {
    // SHOW_ALIASES ships with one entry, so nothing else exercises a table
    // with more than one show in it. Two aliases must stay two identities,
    // each merging only its own editions, once the table grows.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const aliases = [
        {id: 'gala-of-lights', mapKey: 'galaoflights', location: 'aqua-city', titles: ['Gala of Lights', 'Gala Of Lights - Winter Celebration']},
        {id: 'neon-lighting-show', mapKey: 'neonls', location: 'old-hong-kong', titles: ['Neon Lighting Show', 'Neon Lighting Show - Lunar Edition']},
      ];
      const groups = groupShowsBySlug([
        {title: 'Gala Of Lights - Winter Celebration'},
        {title: 'Neon Lighting Show - Lunar Edition'},
        {title: 'Neon Lighting Show'},
      ], aliases);
      expect([...groups.keys()].sort()).toEqual(['gala-of-lights', 'neon-lighting-show']);
      expect(groups.get('gala-of-lights')!.items).toHaveLength(1);
      expect(groups.get('neon-lighting-show')!.items).toHaveLength(2);
      expect(groups.get('neon-lighting-show')!.title).toBe('Neon Lighting Show - Lunar Edition');
      expect(warn).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });


  test('does not warn for an unrelated show that merely shares no prefix', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      groupShowsBySlug([{title: 'Penguin Feeding Demonstration'}, {title: 'Galaxy Parade'}]);
      expect(warn).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });

  test('a curated title is matched by slug, so equivalent punctuation is still curated', () => {
    // The table spells this with an en dash; the feed may send an em dash, a
    // double hyphen or a fullwidth dash. All are the SAME curated title, so
    // none of them may take the adoption path or warn.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (const title of [
        'Gala Of Lights \u2014 Pandastic Birthday Edition',
        'Gala Of Lights -- Pandastic Birthday Edition',
        'Gala Of Lights \u2013 Pandastic Birthday Edition',
      ]) {
        const groups = groupShowsBySlug([{title}]);
        expect([...groups.keys()]).toEqual(['gala-of-lights']);
        expect(groups.get('gala-of-lights')!.title).toBe(title);
      }
      expect(warn).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });


  test('a separator inside brackets does not split the title', () => {
    const aliases = [{id: 'roving-band', mapKey: 'rovingband', location: 'aqua-city', titles: ['Roving Band']}];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (const title of ['Roving Band (Near Pier: Relocated)', 'Roving Band (Near Pier - Relocated)']) {
        expect([...groupShowsBySlug([{title}], aliases).keys()]).toEqual([slugify(title)]);
      }
    } finally { warn.mockRestore(); }
  });

  test('a curated edition beats an unvouched one for the display name, both orders', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const rows = [{title: 'Gala Of Lights \u2013 Pandastic Birthday Edition'}, {title: 'Gala Of Lights - Backstage Tour For Members'}];
      for (const order of [rows, [...rows].reverse()]) {
        expect(groupShowsBySlug(order).get('gala-of-lights')!.title)
          .toBe('Gala Of Lights \u2013 Pandastic Birthday Edition');
      }
    } finally { warn.mockRestore(); }
  });

  test.each([
    ['title missing', {timeSlot: ['19:00:00']}],
    ['title null', {title: null}],
    ['title a number', {title: 12345}],
    ['title a localised object', {title: {en: 'Gala of Lights', zh: '\u5149\u96d5\u532f\u6f14'}}],
    ['the row itself null', null],
  ])('a row with %s never throws and never loses its neighbours', (_label, bad) => {
    // groupShowsBySlug runs inside buildEntityList with no catch, so a throw
    // here rejects the entire entity list.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let groups!: ReturnType<typeof groupShowsBySlug>;
      expect(() => {
        groups = groupShowsBySlug([
          {title: 'Gala of Lights', timeSlot: ['19:00:00']},
          bad as never,
          {title: 'Whiskers Show', timeSlot: ['12:00:00']},
        ]);
      }).not.toThrow();
      expect([...groups.keys()]).toEqual(['gala-of-lights', 'whiskers-show']);
    } finally { warn.mockRestore(); }
  });

  test('a curated show listed at several zones warns once, not once per row', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const groups = groupShowsBySlug([
        {title: 'Gala of Lights', timeSlot: ['19:00:00'], locations: [{location: {id: 'aqua-city'}}]},
        {title: 'Gala of Lights', timeSlot: ['21:00:00'], locations: [{location: {id: 'aqua-city'}}]},
      ]);
      expect([...groups.keys()]).toEqual(['gala-of-lights']);
      // Both rows sit at the curated zone: nothing to say.
      expect(warn).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });

  test('a family whose titles omit its bare name still merges the bare row', () => {
    // Nothing forces ShowAlias.id to be the slug of one of its titles, so the
    // id is matched directly: the id IS the bare name by construction.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const aliases = [{id: 'gala-of-lights', mapKey: 'g', location: 'aqua-city', titles: ['Gala Of Lights - Winter Celebration']}];
      const rows = [
        {title: 'Gala of Lights', timeSlot: ['19:00:00']},
        {title: 'Gala Of Lights - Winter Celebration', timeSlot: ['20:00:00']},
      ];
      for (const order of [rows, [...rows].reverse()]) {
        const groups = groupShowsBySlug(order, aliases);
        expect([...groups.keys()]).toEqual(['gala-of-lights']);
        expect(groups.get('gala-of-lights')!.items.flatMap(i => i.timeSlot!).sort())
          .toEqual(['19:00:00', '20:00:00']);
      }
    } finally { warn.mockRestore(); }
  });

  test('a bracketed title keeps its own id whatever punctuation is inside it', () => {
    // A bracket is not a separator's delimiter any more — the head simply
    // stops at the first colon or spaced dash. What matters is the id: a
    // bracketed title must never collapse onto a curated family, because the
    // brackets are how the park tells its two Roving Bands apart.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const aliases = [{id: 'roving-band', mapKey: 'rb', location: 'aqua-city', titles: ['Roving Band']}];
      for (const title of [
        'Roving Band (Near Pier: Relocated)',
        'Roving Band (Near Pier - Relocated)',
        'Roving Band (Near Lagoon Platform)',
        'Roving Band (Unclosed - Winter',
      ]) {
        expect([...groupShowsBySlug([{title}], aliases).keys()]).toEqual([slugify(title)]);
      }
    } finally { warn.mockRestore(); }
  });

  test('a bracketed title never folds into a curated family, and says so', () => {
    // The brackets are what keep the two Roving Bands apart, so this must
    // keep its own id. The warning is still correct: that id carries the
    // subtitle and will move when the subtitle does.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const aliases = [{id: 'roving-band', mapKey: 'rb', location: 'aqua-city', titles: ['Roving Band']}];
      const groups = groupShowsBySlug([{title: 'Roving Band (Near Pier) - Relocated'}], aliases);
      expect([...groups.keys()]).toEqual([slugify('Roving Band (Near Pier) - Relocated')]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('belongs to no curated family'));
    } finally { warn.mockRestore(); }
  });

  test('two distinct titles that collide on slug keep only the first, and drop the second', () => {
    const groups = groupShowsBySlug([
      {title: 'Whiskers & Friends', timeSlot: ['11:00:00']},
      {title: 'Whiskers, Friends', timeSlot: ['15:00:00']},
    ]);
    // Both normalize to "whiskers-friends" — only one group must survive,
    // never two entries silently sharing the same id.
    expect(groups.size).toBe(1);
    expect(groups.get('whiskers-friends')!.title).toBe('Whiskers & Friends');
    expect(groups.get('whiskers-friends')!.items).toHaveLength(1);
  });

  test('a title that normalizes to an empty slug is dropped entirely', () => {
    const groups = groupShowsBySlug([{title: '!!!', timeSlot: ['11:00:00']}]);
    expect(groups.size).toBe(0);
  });

  test('distinct titles with distinct slugs both survive', () => {
    const groups = groupShowsBySlug([
      {title: 'All Star Jam', timeSlot: ['11:00:00']},
      {title: 'Animal Fun Talk', timeSlot: ['12:00:00']},
    ]);
    expect(groups.size).toBe(2);
  });
});

// ── parseQueueMinutes ─────────────────────────────────────────────────────

describe('parseQueueMinutes', () => {
  test('parses a normal wait', () => {
    expect(parseQueueMinutes(' 10  mins')).toBe(10);
  });

  test('parses zero distinctly from null (walk right on, not "no data")', () => {
    expect(parseQueueMinutes(' 0  mins')).toBe(0);
  });

  test('returns null for an explicit null (no queue mechanic / no signal)', () => {
    expect(parseQueueMinutes(null)).toBeNull();
  });

  test('returns null for undefined', () => {
    expect(parseQueueMinutes(undefined)).toBeNull();
  });

  test('returns null for text with no number', () => {
    expect(parseQueueMinutes('Closed')).toBeNull();
  });

  test('does not mistake an unrelated digit for a wait time', () => {
    // A status like "Reopens at 5pm" has a digit but isn't a wait-time
    // reading; only a number directly adjacent to "min" counts.
    expect(parseQueueMinutes('Reopens at 5pm')).toBeNull();
  });
});

// ── parseHourRange ────────────────────────────────────────────────────────

describe('parseHourRange', () => {
  test('parses a standard am-pm range to 24h', () => {
    expect(parseHourRange('10:00 am - 7:00 pm')).toEqual({open: '10:00', close: '19:00'});
  });

  test('handles 12:00 pm (noon) correctly', () => {
    expect(parseHourRange('12:00 pm - 8:30 pm')).toEqual({open: '12:00', close: '20:30'});
  });

  test('handles 12:00 am (midnight) correctly', () => {
    expect(parseHourRange('12:00 am - 6:00 am')).toEqual({open: '00:00', close: '06:00'});
  });

  test('returns null for an empty string (unpublished / closed day)', () => {
    expect(parseHourRange('')).toBeNull();
  });

  test('returns null for unparseable text', () => {
    expect(parseHourRange('Temporarily Closed')).toBeNull();
  });

  test('parses an overnight range with no day-rollover awareness (caller\'s job to roll it)', () => {
    // parseHourRange itself is date-agnostic — it just converts each side to
    // 24h. Rolling the close time to the next calendar date is buildSchedules'
    // responsibility (covered in the buildSchedules describe block below).
    expect(parseHourRange('6:00 pm - 12:30 am')).toEqual({open: '18:00', close: '00:30'});
  });
});

describe('getDailyScheduleItems', () => {
  test.each([
    ['an object', {}],
    ['a number', 5],
    ['zero', 0],
    ['true', true],
    ['a string', 'items'],
    ['an envelope', {data: []}],
  ])('a non-array items container (%s) yields no rows rather than throwing', async (_label, items) => {
    // `body?.items ?? []` passed all of these into `for...of`, and the throw
    // landed in buildLiveData's body, after its per-source catch had run —
    // taking every attraction wait time with it.
    const park = new OceanParkHongKong();
    vi.spyOn(park, 'fetchDailySchedule').mockResolvedValue({json: async () => ({items})} as any);
    await expect(park.getDailyScheduleItems('2026-09-14')).resolves.toEqual([]);
  });

  test('a real array still comes through', async () => {
    const park = new OceanParkHongKong();
    vi.spyOn(park, 'fetchDailySchedule').mockResolvedValue({json: async () => ({items: [{title: 'X'}]})} as any);
    await expect(park.getDailyScheduleItems('2026-09-14')).resolves.toEqual([{title: 'X'}]);
  });
});

describe('parseShowTimeSlot', () => {
  test.each([
    ['ascii hyphen', '11:00:00-17:00:00'],
    ['en dash', '11:00:00\u201317:00:00'],
    ['fullwidth hyphen', '11:00:00\uff0d17:00:00'],
    ['unicode hyphen', '11:00:00\u201017:00:00'],
    ['minus sign', '11:00:00 \u2212 17:00:00'],
    ['tilde', '11:00:00~17:00:00'],
    ['wave dash', '11:00:00\u301c17:00:00'],
    ['fullwidth tilde', '11:00:00\uff5e17:00:00'],
  ])('a range separated by a %s keeps both ends', (_label, raw) => {
    // A separator this misses does not cost the end time, it costs the whole
    // slot: the unsplit string fails the clock check and the performance
    // disappears from live data entirely.
    expect(parseShowTimeSlot(raw)).toEqual({start: '11:00:00', end: '17:00:00'});
  });

  test('a bare start time is unaffected by the wider separator set', () => {
    expect(parseShowTimeSlot('19:00:00')).toEqual({start: '19:00:00'});
  });

  test('parses a plain HH:MM:SS start time', () => {
    expect(parseShowTimeSlot('13:00:00')).toEqual({start: '13:00:00'});
  });

  test('parses a HH:MM start time, padding the seconds', () => {
    expect(parseShowTimeSlot('13:05')).toEqual({start: '13:05:00'});
  });

  test('parses the events-tab range shape into a start and an end', () => {
    // Real payload: the halloween-2026 tab publishes a continuous window
    // rather than individual performance times.
    expect(parseShowTimeSlot('11:00:00-17:00:00')).toEqual({start: '11:00:00', end: '17:00:00'});
  });

  test('tolerates whitespace and dash variants around the range separator', () => {
    expect(parseShowTimeSlot(' 11:00 - 17:00 ')).toEqual({start: '11:00:00', end: '17:00:00'});
    expect(parseShowTimeSlot('11:00:00\u201317:00:00')).toEqual({start: '11:00:00', end: '17:00:00'});
  });

  test('keeps only the start when the range end is not after the start', () => {
    expect(parseShowTimeSlot('17:00:00-11:00:00')).toEqual({start: '17:00:00'});
  });

  test('rejects out-of-range clock components rather than passing them on', () => {
    expect(parseShowTimeSlot('25:00:00')).toBeNull();
    expect(parseShowTimeSlot('12:60:00')).toBeNull();
    expect(parseShowTimeSlot('12:00:60')).toBeNull();
  });

  test('rejects text that is not a time at all', () => {
    expect(parseShowTimeSlot('')).toBeNull();
    expect(parseShowTimeSlot('All day')).toBeNull();
    expect(parseShowTimeSlot('10:00:00-12:00:00-14:00:00')).toBeNull();
  });

  test.each([
    ['a trailing separator', '11:00:00-'],
    ['a midnight close the clock check rejects', '11:00:00-24:00:00'],
    ['an end that is not a time', '11:00:00-nope'],
    ['a 12-hour end', '11:00:00 - 5pm'],
  ])('%s keeps the start rather than deleting the performance', (_label, raw) => {
    // Dropping the slot would publish the show CLOSED while it is running.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(parseShowTimeSlot(raw)).toEqual({start: '11:00:00'});
    } finally { warn.mockRestore(); }
  });

  test.each(['11:00:00--17:00:00', '11:00:00 -- 17:00:00', '11:00:00 \u2013\u2013 17:00:00'])(
    'a doubled dash still separates a range: %s', raw => {
      // A doubled hyphen typed for an em dash is the commonest CMS artefact;
      // before, it split into three parts and the whole slot was dropped.
      expect(parseShowTimeSlot(raw)).toEqual({start: '11:00:00', end: '17:00:00'});
    });

  test('rejects non-string input', () => {
    expect(parseShowTimeSlot(null)).toBeNull();
    expect(parseShowTimeSlot(undefined)).toBeNull();
    expect(parseShowTimeSlot(1300)).toBeNull();
  });
});

describe('addDaysToDateString', () => {
  test('adds days within the same month', () => {
    expect(addDaysToDateString('2026-07-07', 3)).toBe('2026-07-10');
  });

  test('rolls over a month boundary', () => {
    expect(addDaysToDateString('2026-07-31', 1)).toBe('2026-08-01');
  });

  test('rolls over a year boundary', () => {
    expect(addDaysToDateString('2026-12-31', 1)).toBe('2027-01-01');
  });

  test('adding zero days returns the same date', () => {
    expect(addDaysToDateString('2026-07-07', 0)).toBe('2026-07-07');
  });
});

// ── computeAffineTransform ────────────────────────────────────────────────

describe('computeAffineTransform', () => {
  test('recovers an exact linear mapping from noiseless reference points', () => {
    // lat = 0.001*x + 0*y + 22, lng = 0*x + 0.001*y + 114
    const refPoints = [
      {pixelX: 0, pixelY: 0, latitude: 22, longitude: 114},
      {pixelX: 1000, pixelY: 0, latitude: 23, longitude: 114},
      {pixelX: 0, pixelY: 1000, latitude: 22, longitude: 115},
      {pixelX: 1000, pixelY: 1000, latitude: 23, longitude: 115},
    ];
    const coeffs = computeAffineTransform(refPoints)!;
    expect(coeffs).toBeDefined();
    const lat = coeffs.a * 500 + coeffs.b * 500 + coeffs.c;
    const lng = coeffs.d * 500 + coeffs.e * 500 + coeffs.f;
    expect(lat).toBeCloseTo(22.5, 6);
    expect(lng).toBeCloseTo(114.5, 6);
  });

  test('returns null for collinear (degenerate) reference points', () => {
    const refPoints = [
      {pixelX: 0, pixelY: 0, latitude: 22, longitude: 114},
      {pixelX: 1, pixelY: 1, latitude: 22.1, longitude: 114.1},
      {pixelX: 2, pixelY: 2, latitude: 22.2, longitude: 114.2},
    ];
    expect(computeAffineTransform(refPoints)).toBeNull();
  });
});

// ── Class builders (stubbed network layer) ───────────────────────────────────

type CoordEntry = [string, {latitude: number; longitude: number}];

class Probe extends OceanParkHongKong {
  private readonly _attractions: any[];
  private readonly _diningTabs: any[];
  private readonly _scheduleItems: any[];
  private readonly _hoursByDate: Record<string, string | null>;
  private readonly _coordEntries: CoordEntry[];

  constructor(opts: {
    attractions?: any[];
    diningTabs?: any[];
    scheduleItems?: any[];
    hoursByDate?: Record<string, string | null>;
    coordEntries?: CoordEntry[];
  } = {}) {
    super();
    this._attractions = opts.attractions ?? [];
    this._diningTabs = opts.diningTabs ?? [];
    this._scheduleItems = opts.scheduleItems ?? [];
    this._hoursByDate = opts.hoursByDate ?? {};
    this._coordEntries = opts.coordEntries ?? [];
  }

  override async getAttractionItems(): Promise<any[]> {
    return this._attractions;
  }

  override async getDiningTabs(): Promise<any[]> {
    return this._diningTabs;
  }

  override async getDailyScheduleItems(_date: string): Promise<any[]> {
    return this._scheduleItems;
  }

  override async getParkOpeningHoursValue(date: string): Promise<string | null> {
    return this._hoursByDate[date] ?? null;
  }

  override async getCoordinateMapEntries(): Promise<CoordEntry[]> {
    return this._coordEntries;
  }

  public entities(): Promise<any[]> {
    return (this as any).buildEntityList();
  }

  public liveData(): Promise<any[]> {
    return (this as any).buildLiveData();
  }

  public schedules(): Promise<any[]> {
    return (this as any).buildSchedules();
  }
}

const mkAttraction = (overrides: Partial<any> = {}) => ({
  nodeId: 'node-1',
  nodeUrl: {label: 'Arctic Blast', url: 'https://www.oceanpark.com.hk/en/a-day-at-the-park/attractions/arctic-blast'},
  attractionTypes: [{id: 'thrill-rides', label: 'Thrill Rides'}],
  height: {min: 0, max: 300},
  queueTime: {text: ' 10  mins'},
  ...overrides,
});

describe('buildEntityList', () => {
  test('maps a ride attraction with a real height restriction', async () => {
    const probe = new Probe({
      attractions: [mkAttraction({height: {min: 100, max: 300}})],
    });
    const entities = await probe.entities();
    const attraction = entities.find((e) => e.id === 'attraction_node-1');
    expect(attraction).toBeDefined();
    expect(attraction.name).toBe('Arctic Blast');
    expect(attraction.attractionType).toBe('RIDE');
    expect(attraction.tags).toHaveLength(1);
    expect(attraction.tags[0].tag).toBe('MINIMUM_HEIGHT');
  });

  test('classifies in-park-transportation as TRANSPORT', async () => {
    const probe = new Probe({
      attractions: [mkAttraction({
        nodeId: 'node-2',
        attractionTypes: [{id: 'in-park-transportation', label: 'In-park Transportation'}],
      })],
    });
    const entities = await probe.entities();
    const attraction = entities.find((e) => e.id === 'attraction_node-2');
    expect(attraction.attractionType).toBe('TRANSPORT');
  });

  test('does not tag min/max height at the "no restriction" sentinel (0 / 300)', async () => {
    const probe = new Probe({attractions: [mkAttraction({height: {min: 0, max: 300}})]});
    const entities = await probe.entities();
    const attraction = entities.find((e) => e.id === 'attraction_node-1');
    expect(attraction.tags).toBeUndefined();
  });

  test('tags a real maximum height restriction', async () => {
    const probe = new Probe({attractions: [mkAttraction({height: {min: 0, max: 150}})]});
    const entities = await probe.entities();
    const attraction = entities.find((e) => e.id === 'attraction_node-1');
    expect(attraction.tags).toHaveLength(1);
    expect(attraction.tags[0].tag).toBe('MAXIMUM_HEIGHT');
  });

  test('defaults to RIDE when attractionTypes is empty', async () => {
    const probe = new Probe({attractions: [mkAttraction({attractionTypes: []})]});
    const entities = await probe.entities();
    const attraction = entities.find((e) => e.id === 'attraction_node-1');
    expect(attraction.attractionType).toBe('RIDE');
  });

  test('defaults to RIDE when attractionTypes is missing entirely', async () => {
    const {attractionTypes, ...rest} = mkAttraction();
    const probe = new Probe({attractions: [rest]});
    const entities = await probe.entities();
    const attraction = entities.find((e) => e.id === 'attraction_node-1');
    expect(attraction.attractionType).toBe('RIDE');
  });

  test('skips an attraction item missing nodeUrl instead of crashing the whole build', async () => {
    const {nodeUrl, ...malformed} = mkAttraction();
    const probe = new Probe({
      attractions: [malformed, mkAttraction({nodeId: 'node-2', nodeUrl: {label: 'Bumper Blaster', url: '.../bumper-blaster'}})],
    });
    const entities = await probe.entities();
    expect(entities.find((e) => e.id === 'attraction_node-1')).toBeUndefined();
    expect(entities.find((e) => e.id === 'attraction_node-2')).toBeDefined();
  });

  test('skips an attraction item missing nodeId instead of producing an "attraction_undefined" id', async () => {
    const {nodeId, ...malformed} = mkAttraction();
    const probe = new Probe({attractions: [malformed]});
    const entities = await probe.entities();
    expect(entities.find((e) => e.entityType === 'ATTRACTION')).toBeUndefined();
  });

  test('skips a restaurant item missing nodeUrl instead of crashing the whole build', async () => {
    const probe = new Probe({
      diningTabs: [{
        tab: {id: 'restaurants', label: 'Restaurants'},
        pageItems: [
          {} as any,
          {nodeUrl: {label: "Neptune's Restaurant", url: '.../neptune-s-restaurant'}},
        ],
      }],
    });
    const entities = await probe.entities();
    const restaurants = entities.filter((e) => e.entityType === 'RESTAURANT');
    expect(restaurants).toHaveLength(1);
    expect(restaurants[0].name).toBe("Neptune's Restaurant");
  });

  test('restaurant coordinates join by URL slug and fall back to the default when unmatched', async () => {
    const probe = new Probe({
      diningTabs: [{
        tab: {id: 'restaurants', label: 'Restaurants'},
        pageItems: [{nodeUrl: {label: "Neptune's Restaurant", url: 'https://www.oceanpark.com.hk/en/a-day-at-the-park/dining-shopping/restaurants/neptune-s-restaurant'}}],
      }],
      coordEntries: [['neptune-s-restaurant', {latitude: 3, longitude: 4}]],
    });
    const entities = await probe.entities();
    const restaurant = entities.find((e) => e.entityType === 'RESTAURANT');
    expect(restaurant.location).toEqual({latitude: 3, longitude: 4});
  });

  test('restaurant falls back to the default location when no coordinate match exists', async () => {
    const probe = new Probe({
      diningTabs: [{
        tab: {id: 'restaurants', label: 'Restaurants'},
        pageItems: [{nodeUrl: {label: "Neptune's Restaurant", url: 'https://www.oceanpark.com.hk/en/a-day-at-the-park/dining-shopping/restaurants/neptune-s-restaurant'}}],
      }],
      coordEntries: [],
    });
    const entities = await probe.entities();
    const restaurant = entities.find((e) => e.entityType === 'RESTAURANT');
    expect(restaurant.location.latitude).toBeCloseTo(22.2465, 4);
  });

  test('show coordinates join by slugified title and fall back to the default when unmatched', async () => {
    const probe = new Probe({
      scheduleItems: [{title: 'All Star Jam', timeSlot: ['11:00:00']}],
      coordEntries: [['show-url:all-star-jam', {latitude: 5, longitude: 6}]],
    });
    const entities = await probe.entities();
    const show = entities.find((e) => e.entityType === 'SHOW');
    expect(show.location).toEqual({latitude: 5, longitude: 6});
  });

  test('a non-string url in a NON-show category cannot zero every coordinate', async () => {
    // attractions/dining/animals/transportations/shops all go through the
    // same loop, and slugFromUrl calls .split. This is most of the park.
    const park = new OceanParkHongKong();
    vi.spyOn(park, 'fetchReferencePoints').mockResolvedValue({json: async () => [
      {pixelX: 0, pixelY: 0, latitude: 0, longitude: 0},
      {pixelX: 1, pixelY: 0, latitude: 1, longitude: 0},
      {pixelX: 0, pixelY: 1, latitude: 0, longitude: 1},
    ]} as any);
    vi.spyOn(park, 'fetchMapCategoryData').mockImplementation(async category =>
      ({json: async () => (category === 'attractions' ? [
        {url: 12345, x: 1, y: 1},
        {url: {en: '/en/x'}, x: 1, y: 1},
        {url: true, x: 1, y: 1},
        {url: '/en/attractions/hair-raiser', x: 2, y: 3},
      ] : [])}) as any);
    const coords = new Map(await park.getCoordinateMapEntries());
    expect(coords.get('hair-raiser')).toEqual({latitude: 2, longitude: 3});
  });

  test('a duplicated NON-show row keeps its pin, as it always has', async () => {
    // animals and shops already ship duplicate URL slugs. Suppressing an
    // ambiguous key is a shows-only rule; taking a ride's pin away the day
    // the feed duplicates one is not this change's business.
    const park = new OceanParkHongKong();
    vi.spyOn(park, 'fetchReferencePoints').mockResolvedValue({json: async () => [
      {pixelX: 0, pixelY: 0, latitude: 0, longitude: 0},
      {pixelX: 1, pixelY: 0, latitude: 1, longitude: 0},
      {pixelX: 0, pixelY: 1, latitude: 0, longitude: 1},
    ]} as any);
    vi.spyOn(park, 'fetchMapCategoryData').mockImplementation(async category =>
      ({json: async () => (category === 'attractions' ? [
        {url: '/en/attractions/hair-raiser', x: 1, y: 2},
        {url: '/en/attractions/hair-raiser', x: 3, y: 4},
      ] : [])}) as any);
    const coords = new Map(await park.getCoordinateMapEntries());
    expect(coords.get('hair-raiser')).toEqual({latitude: 3, longitude: 4});
  });

  test('a pixel that projects off the planet is dropped', async () => {
    // Number.isFinite is not a range check: a sentinel pixel projects to a
    // latitude of -934 and nothing downstream validates it.
    const park = new OceanParkHongKong();
    vi.spyOn(park, 'fetchReferencePoints').mockResolvedValue({json: async () => [
      {pixelX: 0, pixelY: 0, latitude: 0, longitude: 0},
      {pixelX: 1, pixelY: 0, latitude: 1, longitude: 0},
      {pixelX: 0, pixelY: 1, latitude: 0, longitude: 1},
    ]} as any);
    vi.spyOn(park, 'fetchMapCategoryData').mockImplementation(async category =>
      ({json: async () => (category === 'shows' ? [
        {name: 'Sentinel', api_key: 'sent', x: 99999999, y: 4},
        {name: 'Fine', api_key: 'fine', x: 3, y: 4},
      ] : [])}) as any);
    const coords = new Map(await park.getCoordinateMapEntries());
    expect(coords.has('show-key:sent')).toBe(false);
    expect(coords.get('show-key:fine')).toEqual({latitude: 3, longitude: 4});
    for (const [, v] of coords) {
      expect(Math.abs(v.latitude)).toBeLessThanOrEqual(90);
      expect(Math.abs(v.longitude)).toBeLessThanOrEqual(180);
    }
  });

  test('a projection that overflows is dropped, not published as null', async () => {
    const park = new OceanParkHongKong();
    // latitude = x + y, so a pair of huge pixels overflows to Infinity.
    vi.spyOn(park, 'fetchReferencePoints').mockResolvedValue({json: async () => [
      {pixelX: 0, pixelY: 0, latitude: 0, longitude: 0},
      {pixelX: 1, pixelY: 0, latitude: 1, longitude: 1},
      {pixelX: 0, pixelY: 1, latitude: 1, longitude: 0},
    ]} as any);
    vi.spyOn(park, 'fetchMapCategoryData').mockImplementation(async category =>
      ({json: async () => (category === 'shows' ? [
        {name: 'Overflow A', api_key: 'ova', x: 1e308, y: 1e308},
        {name: 'Overflow B', api_key: 'ovb', x: 1e308, y: 9e307},
        {name: 'Fine', api_key: 'fine', x: 3, y: 4},
      ] : [])}) as any);
    const coords = new Map(await park.getCoordinateMapEntries());
    // JSON renders Infinity as null, so an overflowing pin would both reach
    // an entity as a null latitude and collide with every other overflow.
    for (const [, v] of coords) {
      expect(Number.isFinite(v.latitude)).toBe(true);
      expect(Number.isFinite(v.longitude)).toBe(true);
    }
    expect(coords.get('show-key:fine')).toEqual({latitude: 7, longitude: 3});
    expect(coords.has('show-key:ova')).toBe(false);
  });

  const mapProbe = async (shows: any[]) => {
    const park = new OceanParkHongKong();
    vi.spyOn(park, 'fetchReferencePoints').mockResolvedValue({json: async () => [
      {pixelX: 0, pixelY: 0, latitude: 0, longitude: 0},
      {pixelX: 1, pixelY: 0, latitude: 1, longitude: 0},
      {pixelX: 0, pixelY: 1, latitude: 0, longitude: 1},
    ]} as any);
    vi.spyOn(park, 'fetchMapCategoryData').mockImplementation(async category =>
      ({json: async () => (category === 'shows' ? shows : [])}) as any);
    return new Map(await park.getCoordinateMapEntries());
  };

  test('a malformed map name cannot take down every coordinate in the park', async () => {
    // slugify() calls .normalize(), so a localised {en, zh} name used to
    // throw and the caller's catch zeroed the whole coordinate map.
    for (const name of [{en: 'Sea Lion Show'}, 42, null, ['a']] as any[]) {
      const coords = await mapProbe([
        {name, api_key: 'sealion', x: 5, y: 6},
        {name: 'Gala of Lights', api_key: 'galaoflights', x: 1, y: 2},
      ]);
      expect(coords.get('show-key:galaoflights')).toEqual({latitude: 1, longitude: 2});
      expect(coords.get('show-key:sealion')).toEqual({latitude: 5, longitude: 6});
    }
  });

  test('a name that slugifies to nothing does not publish a wildcard key', async () => {
    const coords = await mapProbe([{name: '\u6d77\u6d0b\u5287\u5834', api_key: 'cjk', x: 5, y: 6}]);
    expect(coords.has('show-name:')).toBe(false);
    expect(coords.get('show-key:cjk')).toEqual({latitude: 5, longitude: 6});
  });

  test('verbatim duplicate map rows still yield coordinates', async () => {
    const coords = await mapProbe([
      {name: 'Sea Show', api_key: 'seashow', x: 5, y: 6},
      {name: 'Sea Show', api_key: 'seashow', x: 5, y: 6},
      {name: 'Half Show', api_key: 'halfshow', x: 7, y: 8},
      {name: 'Half Show', api_key: 'halfshow'},
    ]);
    expect(coords.get('show-name:sea-show')).toEqual({latitude: 5, longitude: 6});
    expect(coords.get('show-name:half-show')).toEqual({latitude: 7, longitude: 8});
  });

  test('an ambiguous show is suppressed in the URL namespace too', async () => {
    // The two Roving Bands sit at different places. Withholding only the
    // name key left the bare URL slug free to serve the wrong one.
    const coords = await mapProbe([
      {name: 'Roving Band', api_key: 'rovingband', url: '/en/shows/roving-band', x: 5, y: 5},
      {name: 'Roving Band', api_key: 'rovingbandwf', url: '/en/water-world/shows/roving-band', x: 9, y: 9},
    ]);
    expect(coords.has('show-name:roving-band')).toBe(false);
    expect(coords.has('roving-band')).toBe(false);
    expect(coords.get('show-key:rovingband')).toEqual({latitude: 5, longitude: 5});
  });

  test('NaN pixel coordinates never reach an entity through the URL namespace', async () => {
    const coords = await mapProbe([
      {url: '/en/shows/nan-show', x: NaN, y: 4},
      {url: '/en/shows/bad-show', x: 'abc', y: 4},
      {url: '/en/shows/text-show', x: '30', y: 4},
      {url: '/en/shows/ok-show', x: 3, y: 4},
      {url: 12345, x: 1, y: 1},
    ]);
    expect(coords.has('show-url:nan-show')).toBe(false);
    // A numeric string is coerced, as the URL loop always did.
    expect(coords.get('show-url:text-show')).toEqual({latitude: 30, longitude: 4});
    expect(coords.get('show-url:ok-show')).toEqual({latitude: 3, longitude: 4});
  });

  test('a merged show reaches its map pin by canonical slug, not its edition title', async () => {
    // The map knows the bare show name; it has never heard of this season's
    // edition title, and a curated api_key can be renumbered upstream.
    const coordEntries = [['show-name:gala-of-lights', {latitude: 5, longitude: 6}]] as CoordEntry[];
    const show = (await new Probe({scheduleItems: [{title: 'Gala Of Lights - Winter Celebration'}], coordEntries}).entities())
      .find(e => e.entityType === 'SHOW');
    expect(show.id).toBe('show_gala-of-lights');
    expect(show.location).toEqual({latitude: 5, longitude: 6});
  });

  test('the curated map key wins over a disagreeing name match, and the clash is flagged', async () => {
    // Neither order is safe: a curated key can be renumbered upstream, and a
    // different production can take a family's name. The human-checked key
    // wins and the disagreement is logged rather than resolved in silence.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const coordEntries = [
        ['show-key:galaoflights', {latitude: 1, longitude: 1}],
        ['show-name:gala-of-lights', {latitude: 2, longitude: 2}],
        ['show-url:gala-of-lights', {latitude: 3, longitude: 3}],
      ] as CoordEntry[];
      const show = (await new Probe({scheduleItems: [{title: 'Gala of Lights'}], coordEntries}).entities())
        .find(e => e.entityType === 'SHOW');
      expect(show.location).toEqual({latitude: 1, longitude: 1});
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('point at different places'));
    } finally { warn.mockRestore(); }
  });

  test('agreeing key and name raise no clash warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const coordEntries = [
        ['show-key:galaoflights', {latitude: 1, longitude: 1}],
        ['show-name:gala-of-lights', {latitude: 1, longitude: 1}],
      ] as CoordEntry[];
      await new Probe({scheduleItems: [{title: 'Gala of Lights'}], coordEntries}).entities();
      expect(warn).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });

  test('a name match still serves a show with no curated key', async () => {
    const coordEntries = [['show-name:star-explorers-club', {latitude: 7, longitude: 8}]] as CoordEntry[];
    const show = (await new Probe({scheduleItems: [{title: 'Star Explorers Club'}], coordEntries}).entities())
      .find(e => e.entityType === 'SHOW');
    expect(show.location).toEqual({latitude: 7, longitude: 8});
  });

  test('a show reaches a pin filed in another category as a last resort', async () => {
    // The bare namespace is shared with attractions/dining; it is the only
    // rung that can reach a pin the shows category does not carry.
    const coordEntries = [['star-explorers-club', {latitude: 9, longitude: 10}]] as CoordEntry[];
    const show = (await new Probe({scheduleItems: [{title: 'Star Explorers Club'}], coordEntries}).entities())
      .find(e => e.entityType === 'SHOW');
    expect(show.location).toEqual({latitude: 9, longitude: 10});
  });

  test('a show with only a name match and no alias still gets its pin', async () => {
    const coordEntries = [['show-name:star-explorers-club', {latitude: 7, longitude: 8}]] as CoordEntry[];
    const show = (await new Probe({scheduleItems: [{title: 'Star Explorers Club'}], coordEntries}).entities())
      .find(e => e.entityType === 'SHOW');
    expect(show.location).toEqual({latitude: 7, longitude: 8});
  });

  test('reads coordinates without URLs and excludes ambiguous show names', async () => {
    const park = new OceanParkHongKong();
    vi.spyOn(park, 'fetchReferencePoints').mockResolvedValue({json: async () => [
      {pixelX: 0, pixelY: 0, latitude: 0, longitude: 0},
      {pixelX: 1, pixelY: 0, latitude: 1, longitude: 0},
      {pixelX: 0, pixelY: 1, latitude: 0, longitude: 1},
    ]} as any);
    vi.spyOn(park, 'fetchMapCategoryData').mockImplementation(async category => ({json: async () => category === 'shows' ? [
      {name: 'Gala of Lights', api_key: 'galaoflights', x: 5, y: 6},
      {name: 'Roving Band', api_key: 'rovingband', x: 1, y: 2},
      {name: 'Roving Band', api_key: 'rovingbandwf', x: 3, y: 4},
      {name: 'Invalid', x: null, y: 4},
      {name: 'Blank', x: '', y: 4},
      {name: 'False', x: false, y: 4},
    ] : []} as any));
    const coords = new Map(await park.getCoordinateMapEntries());
    expect(coords.get('show-key:galaoflights')).toEqual({latitude: 5, longitude: 6});
    expect(coords.get('show-name:gala-of-lights')).toEqual({latitude: 5, longitude: 6});
    expect(coords.has('show-name:roving-band')).toBe(false);
    // null / "" / false must never coerce to a real position at 0,0.
    expect(coords.has('show-name:invalid')).toBe(false);
    expect(coords.has('show-name:blank')).toBe(false);
    expect(coords.has('show-name:false')).toBe(false);
    const show = (await new Probe({scheduleItems: [{title: 'Gala of Lights'}], coordEntries: [...coords]}).entities())
      .find(e => e.entityType === 'SHOW');
    expect(show.location).toEqual({latitude: 5, longitude: 6});
  });

  test('show falls back to the default location when no coordinate match exists', async () => {
    const probe = new Probe({
      scheduleItems: [{title: 'All Star Jam', timeSlot: ['11:00:00']}],
      coordEntries: [],
    });
    const entities = await probe.entities();
    const show = entities.find((e) => e.entityType === 'SHOW');
    expect(show.location.latitude).toBeCloseTo(22.2465, 4);
  });

  test('two shows whose titles collide on slug do not produce duplicate entity ids', async () => {
    const probe = new Probe({
      scheduleItems: [
        {title: 'Whiskers & Friends', timeSlot: ['11:00:00']},
        {title: 'Whiskers, Friends', timeSlot: ['15:00:00']},
      ],
    });
    const entities = await probe.entities();
    const shows = entities.filter((e) => e.entityType === 'SHOW');
    const ids = shows.map((e: any) => e.id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicate ids
    expect(shows).toHaveLength(1);
  });

  test('joins attraction coordinates by URL slug', async () => {
    const probe = new Probe({
      attractions: [mkAttraction()],
      coordEntries: [['arctic-blast', {latitude: 1, longitude: 2}]],
    });
    const entities = await probe.entities();
    const attraction = entities.find((e) => e.id === 'attraction_node-1');
    expect(attraction.location).toEqual({latitude: 1, longitude: 2});
  });

  test('falls back to the default location when no coordinate match exists', async () => {
    const probe = new Probe({attractions: [mkAttraction()], coordEntries: []});
    const entities = await probe.entities();
    const attraction = entities.find((e) => e.id === 'attraction_node-1');
    expect(attraction.location.latitude).toBeCloseTo(22.2465, 4);
  });

  test('only the "restaurants" tab becomes RESTAURANT entities; other tabs are ignored', async () => {
    const probe = new Probe({
      diningTabs: [
        {
          tab: {id: 'restaurants', label: 'Restaurants'},
          pageItems: [{nodeUrl: {label: "Neptune's Restaurant", url: 'https://www.oceanpark.com.hk/en/a-day-at-the-park/dining-shopping/restaurants/neptune-s-restaurant'}}],
        },
        {
          tab: {id: 'food-kiosks', label: 'Food Kiosks'},
          cardItems: [{title: 'Popcorn Cart'}],
        },
      ],
    });
    const entities = await probe.entities();
    const restaurants = entities.filter((e) => e.entityType === 'RESTAURANT');
    expect(restaurants).toHaveLength(1);
    expect(restaurants[0].id).toBe('restaurant_neptune-s-restaurant');
    expect(entities.find((e) => e.name === 'Popcorn Cart')).toBeUndefined();
  });

  test('shows are deduplicated by title and get a slugified id', async () => {
    const probe = new Probe({
      scheduleItems: [
        {title: 'All Star Jam', timeSlot: ['11:00:00']},
        {title: 'All Star Jam', timeSlot: ['15:30:00']},
      ],
    });
    const entities = await probe.entities();
    const shows = entities.filter((e) => e.entityType === 'SHOW');
    expect(shows).toHaveLength(1);
    expect(shows[0].id).toBe('show_all-star-jam');
  });

  test('always includes the PARK entity', async () => {
    // buildEntityList() never returns a DESTINATION entity — that comes from
    // getDestinations() below, merged in separately by the base class.
    const probe = new Probe();
    const entities = await probe.entities();
    const park = entities.find((e) => e.entityType === 'PARK');
    expect(park).toBeDefined();
    expect(park!.id).toBe('oceanpark');
  });

  test('an attractions-fetch failure degrades to zero attractions instead of throwing the whole build', async () => {
    const probe = new Probe({
      diningTabs: [{
        tab: {id: 'restaurants', label: 'Restaurants'},
        pageItems: [{nodeUrl: {label: "Neptune's Restaurant", url: '.../neptune-s-restaurant'}}],
      }],
    });
    (probe as any).getAttractionItems = () => Promise.reject(new Error('attractions page down'));

    const entities = await probe.entities();
    expect(entities.find((e) => e.entityType === 'ATTRACTION')).toBeUndefined();
    // The unrelated dining source still comes through.
    expect(entities.find((e) => e.entityType === 'RESTAURANT')).toBeDefined();
    expect(entities.find((e) => e.entityType === 'PARK')).toBeDefined();
  });

  test('a dining-fetch failure degrades to zero restaurants without losing attractions', async () => {
    const probe = new Probe({attractions: [mkAttraction()]});
    (probe as any).getDiningTabs = () => Promise.reject(new Error('dining page down'));

    const entities = await probe.entities();
    expect(entities.find((e) => e.entityType === 'RESTAURANT')).toBeUndefined();
    expect(entities.find((e) => e.id === 'attraction_node-1')).toBeDefined();
  });
});

describe('getDestinations', () => {
  test('returns a single DESTINATION entity with the expected id, type, and timezone', async () => {
    const probe = new Probe();
    const destinations = await probe.getDestinations();
    expect(destinations).toHaveLength(1);
    expect(destinations[0].id).toBe('oceanparkresort');
    expect(destinations[0].entityType).toBe('DESTINATION');
    expect(destinations[0].timezone).toBe(TZ);
  });
});

describe('buildLiveData', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Fixed at 2026-07-07T12:00:00+08:00 (noon HK, no DST) so a ±1h window
    // never crosses a calendar day boundary.
    vi.setSystemTime(new Date('2026-07-07T04:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('merges verified editions with deduplicated times and matching entity IDs', async () => {
    const items = [
      {title: 'Gala of Lights', timeSlot: ['18:00:00', '19:00:00']},
      {title: 'Gala Of Lights - Winter Celebration', timeSlot: ['19:00:00', '20:00:00', '18:00:00-21:00:00']},
    ];
    for (const scheduleItems of [items, [...items].reverse()]) {
      const probe = new Probe({scheduleItems});
      const shows = (await probe.entities()).filter(e => e.entityType === 'SHOW');
      const live = await probe.liveData();
      expect(shows).toHaveLength(1);
      expect(live).toHaveLength(1);
      expect(live[0].id).toBe(shows[0].id);
      expect(live[0].id).toBe('show_gala-of-lights');
      expect(live[0].status).toBe('OPERATING');
      // 18:00 appears as both a bare start and as the start of 18:00-21:00:
      // one performance, published once, keeping the range.
      expect(live[0].showtimes).toHaveLength(3);
      expect(live[0].showtimes.filter((s: any) => s.startTime.endsWith('19:00:00+08:00'))).toHaveLength(1);
      expect(live[0].showtimes.filter((s: any) => s.endTime)).toHaveLength(1);
      expect(live[0].showtimes[0].endTime).toBeDefined();
      // Chronological, never feed order.
      expect(live[0].showtimes.map((s: any) => s.startTime))
        .toEqual([...live[0].showtimes.map((s: any) => s.startTime)].sort());
    }
  });

  test('two ranges sharing a start keep the later end, whatever the feed order', async () => {
    // First-wins let feed order pick the window, which could publish CLOSED
    // for an event that is still running.
    const rows = [
      {title: 'Gala of Lights', timeSlot: ['11:00:00-12:00:00']},
      {title: 'Gala Of Lights - Winter Celebration', timeSlot: ['11:00:00-17:00:00']},
    ];
    for (const scheduleItems of [rows, [...rows].reverse()]) {
      const live = await new Probe({scheduleItems}).liveData();
      expect(live).toHaveLength(1);
      expect(live[0].showtimes).toHaveLength(1);
      expect(live[0].showtimes[0].endTime).toContain('17:00:00+08:00');
      expect(live[0].status).toBe('OPERATING');
    }
  });

  test('two different shows may share a start time; dedup is per show', async () => {
    const probe = new Probe({scheduleItems: [
      {title: 'Penguin Feeding Demonstration', timeSlot: ['15:00:00']},
      {title: 'Meerkat Feeding Demonstration', timeSlot: ['15:00:00']},
    ]});
    const live = (await probe.liveData()).filter((l: any) => l.id.startsWith('show_'));
    expect(live).toHaveLength(2);
    for (const row of live) expect(row.showtimes).toHaveLength(1);
  });

  test('a point time and a range sharing a start publish once, keeping the range', async () => {
    const probe = new Probe({scheduleItems: [
      {title: 'Gala of Lights', timeSlot: ['19:00:00']},
      {title: 'Gala Of Lights - Winter Celebration', timeSlot: ['19:00:00-21:00:00']},
    ]});
    const live = await probe.liveData();
    expect(live).toHaveLength(1);
    expect(live[0].showtimes).toHaveLength(1);
    expect(live[0].showtimes[0].startTime).toContain('19:00:00+08:00');
    expect(live[0].showtimes[0].endTime).toContain('21:00:00+08:00');
  });

  test('merged showtimes come out chronological regardless of feed order', async () => {
    const rows = [
      {title: 'Gala Of Lights - Winter Celebration', timeSlot: ['21:00:00']},
      {title: 'Gala of Lights', timeSlot: ['14:00:00', '18:00:00']},
    ];
    for (const scheduleItems of [rows, [...rows].reverse()]) {
      const live = await new Probe({scheduleItems}).liveData();
      expect(live[0].showtimes.map((s: any) => s.startTime.slice(11, 19)))
        .toEqual(['14:00:00', '18:00:00', '21:00:00']);
    }
  });

  test('a map outage does not change canonical IDs or suppress showtimes', async () => {
    const probe = new Probe({scheduleItems: [{title: 'Gala Of Lights - Winter Celebration', timeSlot: ['19:00:00']}]});
    vi.spyOn(probe, 'getCoordinateMapEntries').mockRejectedValue(new Error('map offline'));
    const shows = (await probe.entities()).filter(e => e.entityType === 'SHOW');
    expect(shows[0].id).toBe('show_gala-of-lights');
    expect(shows[0].location.latitude).toBe(22.2465);
    const showtimes = (await probe.liveData())[0].showtimes;
    expect(showtimes).toHaveLength(1);
    expect(showtimes[0].startTime).toContain('19:00:00+08:00');
  });

  test('a numeric queueTime maps to OPERATING with that standby wait', async () => {
    const probe = new Probe({attractions: [mkAttraction({queueTime: {text: ' 10  mins'}})]});
    const live = await probe.liveData();
    const entry = live.find((l) => l.id === 'attraction_node-1');
    expect(entry.status).toBe('OPERATING');
    expect(entry.queue.STANDBY.waitTime).toBe(10);
  });

  test('a "0 mins" queueTime is OPERATING with a zero wait, not CLOSED', async () => {
    const probe = new Probe({attractions: [mkAttraction({queueTime: {text: ' 0  mins'}})]});
    const live = await probe.liveData();
    const entry = live.find((l) => l.id === 'attraction_node-1');
    expect(entry.status).toBe('OPERATING');
    expect(entry.queue.STANDBY.waitTime).toBe(0);
  });

  test('an explicit null queueTime (no queue mechanic / no signal) is CLOSED with no queue', async () => {
    const probe = new Probe({attractions: [mkAttraction({queueTime: null})]});
    const live = await probe.liveData();
    const entry = live.find((l) => l.id === 'attraction_node-1');
    expect(entry.status).toBe('CLOSED');
    expect(entry.queue).toBeUndefined();
  });

  test('a show with only future showtimes today is OPERATING and lists them', async () => {
    const probe = new Probe({
      scheduleItems: [{title: 'All Star Jam', timeSlot: ['13:00:00']}], // 1pm, after our noon "now"
    });
    const live = await probe.liveData();
    const entry = live.find((l) => l.id === 'show_all-star-jam');
    expect(entry.status).toBe('OPERATING');
    expect(entry.showtimes).toHaveLength(1);
    expect(entry.showtimes[0].startTime.startsWith('2026-07-07T13:00')).toBe(true);
  });

  test('a show with only past showtimes today is CLOSED with no showtimes', async () => {
    const probe = new Probe({
      scheduleItems: [{title: 'All Star Jam', timeSlot: ['11:00:00']}], // 11am, before our noon "now"
    });
    const live = await probe.liveData();
    const entry = live.find((l) => l.id === 'show_all-star-jam');
    expect(entry.status).toBe('CLOSED');
    expect(entry.showtimes).toBeUndefined();
  });

  test('a show with one past and one future slot keeps only the future one', async () => {
    const probe = new Probe({
      scheduleItems: [{title: 'All Star Jam', timeSlot: ['11:00:00', '13:00:00']}],
    });
    const live = await probe.liveData();
    const entry = live.find((l) => l.id === 'show_all-star-jam');
    expect(entry.status).toBe('OPERATING');
    expect(entry.showtimes).toHaveLength(1);
    expect(entry.showtimes[0].startTime.startsWith('2026-07-07T13:00')).toBe(true);
  });

  test('two shows colliding on slug do not clobber each other into one merged live-data row under one id', async () => {
    const probe = new Probe({
      scheduleItems: [
        {title: 'Whiskers & Friends', timeSlot: ['13:00:00']},
        {title: 'Whiskers, Friends', timeSlot: ['14:00:00']},
      ],
    });
    const live = await probe.liveData();
    const showEntries = live.filter((l) => l.id.startsWith('show_'));
    const ids = showEntries.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicate ids in the emitted array
  });

  test('a shows-fetch failure degrades to no show live data without losing attraction wait times', async () => {
    const probe = new Probe({attractions: [mkAttraction({queueTime: {text: ' 10  mins'}})]});
    (probe as any).getDailyScheduleItems = () => Promise.reject(new Error('daily schedule route down'));

    const live = await probe.liveData();
    expect(live.find((l) => l.id.startsWith('show_'))).toBeUndefined();
    const attraction = live.find((l) => l.id === 'attraction_node-1');
    expect(attraction.status).toBe('OPERATING');
    expect(attraction.queue.STANDBY.waitTime).toBe(10);
  });

  test('a range timeSlot does not reject the whole live-data build and take wait times with it', async () => {
    // Regression: Ocean Park's halloween-2026 tab publishes a window
    // ("11:00:00-17:00:00") in timeSlot instead of a start time. Handed
    // straight to constructDateTime() that produced an Invalid Date and a
    // RangeError that rejected buildLiveData() outright, so one event item
    // zeroed out every attraction wait time as well as every show.
    const probe = new Probe({
      attractions: [mkAttraction({queueTime: {text: ' 10  mins'}})],
      scheduleItems: [{title: 'Bulu Boo Trick-or-Treat Party', timeSlot: ['11:00:00-17:00:00']}],
    });

    const live = await probe.liveData();
    const attraction = live.find((l) => l.id === 'attraction_node-1');
    expect(attraction.status).toBe('OPERATING');
    expect(attraction.queue.STANDBY.waitTime).toBe(10);
  });

  test('a range timeSlot still running is OPERATING with both a start and an end time', async () => {
    // "now" is noon; the window runs 11:00-17:00, so it is mid-run.
    const probe = new Probe({
      scheduleItems: [{title: 'Bulu Boo Trick-or-Treat Party', timeSlot: ['11:00:00-17:00:00']}],
    });
    const live = await probe.liveData();
    const entry = live.find((l) => l.id === 'show_bulu-boo-trick-or-treat-party');
    expect(entry.status).toBe('OPERATING');
    expect(entry.showtimes).toHaveLength(1);
    expect(entry.showtimes[0].startTime.startsWith('2026-07-07T11:00')).toBe(true);
    expect(entry.showtimes[0].endTime.startsWith('2026-07-07T17:00')).toBe(true);
  });

  test('a range timeSlot that has already finished is CLOSED', async () => {
    const probe = new Probe({
      scheduleItems: [{title: 'Bulu Boo Trick-or-Treat Party', timeSlot: ['09:00:00-10:00:00']}],
    });
    const live = await probe.liveData();
    const entry = live.find((l) => l.id === 'show_bulu-boo-trick-or-treat-party');
    expect(entry.status).toBe('CLOSED');
    expect(entry.showtimes).toBeUndefined();
  });

  test('an unparseable timeSlot is dropped without losing the other slots of the same show', async () => {
    const probe = new Probe({
      scheduleItems: [{title: 'All Star Jam', timeSlot: ['Weather permitting', '13:00:00']}],
    });
    const live = await probe.liveData();
    const entry = live.find((l) => l.id === 'show_all-star-jam');
    expect(entry.status).toBe('OPERATING');
    expect(entry.showtimes).toHaveLength(1);
    expect(entry.showtimes[0].startTime.startsWith('2026-07-07T13:00')).toBe(true);
  });

  test('an attractions-fetch failure degrades to no attraction wait times without losing show live data', async () => {
    const probe = new Probe({scheduleItems: [{title: 'All Star Jam', timeSlot: ['13:00:00']}]});
    (probe as any).getAttractionItems = () => Promise.reject(new Error('attractions page down'));

    const live = await probe.liveData();
    expect(live.find((l) => l.id.startsWith('attraction_'))).toBeUndefined();
    const show = live.find((l) => l.id === 'show_all-star-jam');
    expect(show.status).toBe('OPERATING');
  });
});

describe('buildSchedules', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-07T04:00:00Z')); // noon HK
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('emits an OPERATING entry for a date with published hours', async () => {
    const probe = new Probe({hoursByDate: {'2026-07-07': '10:00 am - 7:00 pm'}});
    const scheds = await probe.schedules();
    const entry = scheds[0].schedule.find((s: any) => s.date === '2026-07-07');
    expect(entry).toBeDefined();
    expect(entry.type).toBe('OPERATING');
    expect(entry.openingTime.startsWith('2026-07-07T10:00')).toBe(true);
    expect(entry.closingTime.startsWith('2026-07-07T19:00')).toBe(true);
  });

  test('skips a date with no published hours (empty string) rather than emitting a bogus entry', async () => {
    const probe = new Probe({hoursByDate: {'2026-07-07': ''}});
    const scheds = await probe.schedules();
    expect(scheds[0].schedule.find((s: any) => s.date === '2026-07-07')).toBeUndefined();
  });

  test('skips a date with no data at all (beyond the published window)', async () => {
    const probe = new Probe({hoursByDate: {}});
    const scheds = await probe.schedules();
    expect(scheds[0].schedule).toHaveLength(0);
  });

  test('rolls an overnight closing time to the next calendar date instead of before the opening time', async () => {
    const probe = new Probe({hoursByDate: {'2026-07-07': '6:00 pm - 12:30 am'}});
    const scheds = await probe.schedules();
    const entry = scheds[0].schedule.find((s: any) => s.date === '2026-07-07');
    expect(entry).toBeDefined();
    expect(entry.openingTime.startsWith('2026-07-07T18:00')).toBe(true);
    expect(entry.closingTime.startsWith('2026-07-08T00:30')).toBe(true);
    expect(new Date(entry.closingTime).getTime()).toBeGreaterThan(new Date(entry.openingTime).getTime());
  });

  test('a normal same-day range is not rolled forward (no regression)', async () => {
    const probe = new Probe({hoursByDate: {'2026-07-07': '10:00 am - 7:00 pm'}});
    const scheds = await probe.schedules();
    const entry = scheds[0].schedule.find((s: any) => s.date === '2026-07-07');
    expect(entry.closingTime.startsWith('2026-07-07T19:00')).toBe(true);
  });

  test('logs a warning when a date has non-empty but unparseable hours text', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const probe = new Probe({hoursByDate: {'2026-07-07': '10:00 - 19:00'}}); // 24h format, not the expected am/pm
    const scheds = await probe.schedules();
    expect(scheds[0].schedule.find((s: any) => s.date === '2026-07-07')).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('2026-07-07'));
    warnSpy.mockRestore();
  });

  test('one failed date request degrades to fewer days instead of zeroing the entire schedule', async () => {
    const probe = new Probe({hoursByDate: {'2026-07-08': '10:00 am - 7:00 pm'}});
    const originalGet = probe.getParkOpeningHoursValue.bind(probe);
    (probe as any).getParkOpeningHoursValue = (date: string) => {
      if (date === '2026-07-07') return Promise.reject(new Error('transient 502'));
      return originalGet(date);
    };

    const scheds = await probe.schedules();
    expect(scheds[0].schedule.find((s: any) => s.date === '2026-07-07')).toBeUndefined();
    expect(scheds[0].schedule.find((s: any) => s.date === '2026-07-08')).toBeDefined();
  });
});

// ── injectUserAgent ───────────────────────────────────────────────────────────

describe('injectUserAgent', () => {
  // www.oceanpark.com.hk WAF-blocks any request without a browser-like UA
  // (returns a 403 "System Maintenance" page instead of the real SSR
  // content) — regression coverage for the bug this caused: every
  // attractions/dining/schedule fetch failed on every single sync, so
  // buildLiveData's per-source .catch() silently emitted zero live data for
  // attractions and shows on every cycle, not just an occasional flaky one.
  test('sets the configured User-Agent header on the request', async () => {
    const park = new OceanParkHongKong({config: {baseURL: 'https://www.oceanpark.com.hk', userAgent: 'TestAgent/1.0'} as any});
    const req: any = {headers: {accept: 'text/html'}};
    await park.injectUserAgent(req);
    expect(req.headers['user-agent']).toBe('TestAgent/1.0');
    expect(req.headers.accept).toBe('text/html');
  });

  test('throws a clear config error instead of silently sending an unauthenticated request', async () => {
    const park = new OceanParkHongKong({config: {baseURL: 'https://www.oceanpark.com.hk', userAgent: ''} as any});
    await expect(park.injectUserAgent({headers: {}} as any)).rejects.toThrow('OCEANPARK_USERAGENT');
  });
});

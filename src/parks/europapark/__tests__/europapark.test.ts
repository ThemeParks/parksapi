/**
 * Unit tests for Europa-Park pure helpers.
 *
 * The class itself is integration-tested via `npm run dev -- europapark`.
 * Pure logic is exercised here without network access.
 */
import {describe, test, expect} from 'vitest';
import {EuropaPark} from '../europapark.js';
import {addDays, formatInTimezone} from '../../../datetime.js';

const TZ = 'Europe/Berlin';

/** Date offset from now as a YYYY-MM-DD string in the park timezone. */
const isoDay = (offsetDays: number): string => {
  const [mm, dd, yyyy] = formatInTimezone(addDays(new Date(), offsetDays), TZ, 'date').split('/');
  return `${yyyy}-${mm}-${dd}`;
};

/**
 * Subclass that stubs the two network-backed getters so buildSchedules() can be
 * exercised offline. buildSchedules() is protected; expose it for assertions.
 */
class ScheduleProbe extends EuropaPark {
  private readonly _seasons: any[];
  private readonly _live: any;
  constructor(seasons: any[], live: any = {}) {
    super();
    this._seasons = seasons;
    this._live = live;
  }
  override async getSeasons(): Promise<any> {
    return this._seasons;
  }
  override async getLiveCalendar(): Promise<any> {
    return this._live;
  }
  public schedules(): Promise<any[]> {
    return this.buildSchedules();
  }
  /** Find the OPERATING entry for a given date in the main Europa-Park schedule. */
  async operatingEntry(date: string): Promise<any> {
    const scheds = await this.schedules();
    const main = scheds.find((s) => s.id === 'park_493');
    return main?.schedule.find((e: any) => e.date === date && e.type === 'OPERATING');
  }
}

describe('Europa-Park schedule: post-midnight closing time', () => {
  test('special-day 00:00 close (Sommernächte) rolls to the next calendar day', async () => {
    const special = isoDay(30);
    const next = isoDay(31);
    const probe = new ScheduleProbe([
      {
        startAt: `${isoDay(-10)}T09:00:00+02:00`,
        endAt: `${isoDay(60)}T18:00:00+02:00`,
        scopes: ['europapark'],
        status: 'live',
        closed: false,
        specialOpenTimes: [
          {
            dateAt: `${special}T00:00:00+02:00`,
            startAt: `${special}T09:00:00+02:00`,
            endAt: `${special}T00:00:00+02:00`, // closing BEFORE opening in upstream feed
          },
        ],
      },
    ]);

    const entry = await probe.operatingEntry(special);
    expect(entry).toBeDefined();
    expect(entry.openingTime.startsWith(`${special}T09:00`)).toBe(true);
    // Closing rolled forward to 00:00 of the following day.
    expect(entry.closingTime.startsWith(`${next}T00:00`)).toBe(true);
    // Core invariant: the operating window is positive.
    expect(new Date(entry.closingTime).getTime()).toBeGreaterThan(
      new Date(entry.openingTime).getTime(),
    );
  });

  test('regular-day 00:00 close also rolls forward (both branches covered)', async () => {
    const regular = isoDay(5);
    const next = isoDay(6);
    const probe = new ScheduleProbe([
      {
        startAt: `${isoDay(-10)}T10:00:00+02:00`,
        endAt: `${isoDay(60)}T00:00:00+02:00`, // daily close component = midnight
        scopes: ['europapark'],
        status: 'live',
        closed: false,
      },
    ]);

    const entry = await probe.operatingEntry(regular);
    expect(entry).toBeDefined();
    expect(entry.closingTime.startsWith(`${next}T00:00`)).toBe(true);
    expect(new Date(entry.closingTime).getTime()).toBeGreaterThan(
      new Date(entry.openingTime).getTime(),
    );
  });

  test('normal 18:00 close is left unchanged (no regression)', async () => {
    const regular = isoDay(5);
    const probe = new ScheduleProbe([
      {
        startAt: `${isoDay(-10)}T09:00:00+02:00`,
        endAt: `${isoDay(60)}T18:00:00+02:00`,
        scopes: ['europapark'],
        status: 'live',
        closed: false,
      },
    ]);

    const entry = await probe.operatingEntry(regular);
    expect(entry).toBeDefined();
    expect(entry.closingTime.startsWith(`${regular}T18:00`)).toBe(true);
    expect(entry.closingTime.substring(0, 10)).toBe(regular); // not rolled
  });

  test('special day with startAt set but endAt null does not crash (regression)', async () => {
    // The seasons type allows endAt === null independently of startAt. Such an
    // entry reaches the roll helper with a null closingTime; it must pass through
    // untouched rather than throw on substring().
    const special = isoDay(20);
    const probe = new ScheduleProbe([
      {
        startAt: `${isoDay(-10)}T09:00:00+02:00`,
        endAt: `${isoDay(60)}T18:00:00+02:00`,
        scopes: ['europapark'],
        status: 'live',
        closed: false,
        specialOpenTimes: [
          {
            dateAt: `${special}T00:00:00+02:00`,
            startAt: `${special}T09:00:00+02:00`,
            endAt: null,
          },
        ],
      },
    ]);

    await expect(probe.schedules()).resolves.toBeDefined();
    const entry = await probe.operatingEntry(special);
    expect(entry).toBeDefined();
    expect(entry.closingTime).toBeNull(); // preserved, not rolled, not crashed
  });

  test('live "today" overlay with a 00:00 end rolls forward too', async () => {
    const today = isoDay(0);
    const next = isoDay(1);
    const probe = new ScheduleProbe(
      [
        {
          startAt: `${isoDay(-10)}T09:00:00+02:00`,
          endAt: `${isoDay(60)}T18:00:00+02:00`,
          scopes: ['europapark'],
          status: 'live',
          closed: false,
        },
      ],
      {
        today: {
          date: `${today}T00:00:00+02:00`,
          start: `${today}T09:00:00+02:00`,
          end: `${today}T00:00:00+02:00`, // live feed reports midnight close
        },
      },
    );

    const entry = await probe.operatingEntry(today);
    expect(entry).toBeDefined();
    expect(entry.closingTime.startsWith(`${next}T00:00`)).toBe(true);
    expect(new Date(entry.closingTime).getTime()).toBeGreaterThan(
      new Date(entry.openingTime).getTime(),
    );
  });
});

const mkWait = (code: number, time = 0) => ({code, time});
const mkAttraction = (id: number, code: number) =>
  ({id: `pois_${id}`, name: `Attraction ${id}`, entityType: 'ATTRACTION', scopes: ['europapark'], code} as any);

// Sub-class to expose the protected glitch detector for testing.
class Probe extends EuropaPark {
  public probe(waits: any[], entities: any[]): boolean {
    return this._isWaitsGlitch(waits, entities);
  }
}

describe('_isWaitsGlitch', () => {
  const probe = new Probe();

  test('returns false when no coded attractions exist', () => {
    // Defensive: avoid divide-by-zero when the entity build returned nothing.
    expect(probe.probe([mkWait(1)], [])).toBe(false);
  });

  test('returns false on a typical operating-day mix (~45% of attractions in waits)', () => {
    const entities = Array.from({length: 100}, (_, i) => mkAttraction(i, i));
    const waits = Array.from({length: 45}, (_, i) => mkWait(i, 5 + (i % 30)));
    expect(probe.probe(waits, entities)).toBe(false);
  });

  test('returns false at the boundary (exactly 85%)', () => {
    // Strict > 0.85 — equal-to is treated as non-glitch.
    const entities = Array.from({length: 100}, (_, i) => mkAttraction(i, i));
    const waits = Array.from({length: 85}, (_, i) => mkWait(i, 0));
    expect(probe.probe(waits, entities)).toBe(false);
  });

  test('returns true just above the boundary (86%)', () => {
    const entities = Array.from({length: 100}, (_, i) => mkAttraction(i, i));
    const waits = Array.from({length: 86}, (_, i) => mkWait(i, 0));
    expect(probe.probe(waits, entities)).toBe(true);
  });

  test('returns true for the observed glitch fingerprint (~94% of catalogue)', () => {
    // 2026-04-20 shape: ~129 of ~137 coded attractions present.
    const entities = Array.from({length: 137}, (_, i) => mkAttraction(i, i));
    const waits = Array.from({length: 129}, (_, i) => mkWait(i, 0));
    expect(probe.probe(waits, entities)).toBe(true);
  });

  test('returns true even when wait values look plausible (different time shape)', () => {
    // Detector is agnostic to time values — a future glitch with all entries
    // showing e.g. waitTime=1 would still match if it covered the whole
    // catalogue. This is the headline reason we picked this signal.
    const entities = Array.from({length: 100}, (_, i) => mkAttraction(i, i));
    const waits = Array.from({length: 95}, (_, i) => mkWait(i, 1));
    expect(probe.probe(waits, entities)).toBe(true);
  });

  test('ignores SHOW entities in the denominator', () => {
    // Shows have codes and appear in the entities list but should not count
    // toward the attraction catalogue.
    const entities = [
      ...Array.from({length: 50}, (_, i) => mkAttraction(i, i)),
      ...Array.from({length: 30}, (_, i) =>
        ({id: `shows_${i}`, name: `Show ${i}`, entityType: 'SHOW', scopes: ['europapark'], code: 9000 + i} as any),
      ),
    ];
    const waits = Array.from({length: 46}, (_, i) => mkWait(i, 0));
    // 46/50 attractions = 92% → glitch, even though 46/80 entities is only 58%.
    expect(probe.probe(waits, entities)).toBe(true);
  });

  test('ignores attractions without a code (cannot appear in waits)', () => {
    // No-code attractions (walk-around trails, saunas) can never appear in
    // waits, so they must be excluded from the denominator.
    const entities = [
      ...Array.from({length: 50}, (_, i) => mkAttraction(i, i)),
      ...Array.from({length: 10}, (_, i) => mkAttraction(2000 + i, undefined as any)),
    ];
    const waits = Array.from({length: 46}, (_, i) => mkWait(i, 0));
    // 46/50 coded attractions = 92%. With the 10 no-code attractions counted,
    // the ratio would be 46/60 = 77% and we'd miss the glitch.
    expect(probe.probe(waits, entities)).toBe(true);
  });

  test('ignores attractions with NaN/Infinity codes', () => {
    // Non-finite codes from malformed upstream JSON would inflate the
    // denominator without ever matching a wait; mirrors the Number.isFinite
    // gate already applied to waits.
    const entities = [
      ...Array.from({length: 50}, (_, i) => mkAttraction(i, i)),
      mkAttraction(9001, NaN),
      mkAttraction(9002, Infinity),
    ];
    const waits = Array.from({length: 46}, (_, i) => mkWait(i, 0));
    expect(probe.probe(waits, entities)).toBe(true);
  });
});

// ── Show name resolution ────────────────────────────────────────────────────
// Some upstream shows (e.g. Rulantica show 133 "TALENT ACADEMY on Stage")
// arrive with an empty public `name` while the title sits in `analyticsName`.
// Without a fallback they are dropped by the `if (!name) return` guard and
// never reach the entity list / moderation queue.
class EntityProbe extends EuropaPark {
  private readonly _pois: any[];
  constructor(pois: any[]) {
    super();
    this._pois = pois;
  }
  override async getPOIs(): Promise<any> {
    return this._pois;
  }
}

describe('getParkEntities show name fallback', () => {
  const pois = [
    {
      id: 747,
      type: 'showlocation',
      name: 'Stage at Skip Strand',
      scopes: ['rulantica'],
      latitude: 48.26,
      longitude: 7.74,
      shows: [
        {id: 133, name: '', analyticsName: 'TALENT ACADEMY on Stage'},
        {id: 134, name: 'The secret of the vikings', analyticsName: 'internal label'},
        {id: 135, name: '', analyticsName: ''},
      ],
    },
  ];

  test('falls back to analyticsName when a show has an empty name', async () => {
    const entities = await new EntityProbe(pois).getParkEntities();
    const show133 = entities.find((e) => e.id === 'shows_133');
    expect(show133).toBeDefined();
    expect(show133!.name).toBe('TALENT ACADEMY on Stage');
    expect(show133!.entityType).toBe('SHOW');
  });

  test('keeps the public name when one is present', async () => {
    const entities = await new EntityProbe(pois).getParkEntities();
    const show134 = entities.find((e) => e.id === 'shows_134');
    expect(show134!.name).toBe('The secret of the vikings');
  });

  test('still skips a show with neither name nor analyticsName', async () => {
    const entities = await new EntityProbe(pois).getParkEntities();
    expect(entities.find((e) => e.id === 'shows_135')).toBeUndefined();
  });
});

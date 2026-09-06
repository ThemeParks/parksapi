/**
 * Regression for programme#86 ("USH: 25 shows never leave OPERATING, so the
 * rows never get written and read as stale").
 *
 * show-list.json's show_times[] lists the WHOLE day's ENABLED performances
 * from midnight, so `hasFutureShowtimes` (parseShowTimes) stays true all
 * night once the feed rolls to the next operating day — a show sampled at
 * 03:00 with the park shut for hours still has a slot hours away. Before the
 * fix, mapUniversalShowStatus's CLOSED/CANCELED/unknown default branch read
 * that as OPERATING with no reference to park hours, so the status (and
 * therefore the wiki row) never changed across the overnight closure and
 * `lastUpdated` froze.
 *
 * These tests drive the full buildLiveData → getLiveData pipeline (not just
 * the pure mapUniversalShowStatus helper) so the venue-schedule lookup and
 * resolveScheduleVenue wiring are covered too, using UniversalStudios (a
 * single-park resort — venue place_id 'ush.ush', legacy venue id '13825')
 * to match the reported incident directly.
 */
import {describe, test, expect, vi, afterEach} from 'vitest';
import {UniversalStudios, UniversalOrlando, mapUniversalShowStatus, hasImminentPerformance, type UniversalShowListEntry} from '../universal.js';

// Real wall-clock hours from the incident: EXTRA_HOURS 08:00-09:00 PDT,
// general open 09:00-19:00 PDT. All offsets are -07:00 (Pacific, no DST
// re-projection needed since these are already Pacific-local strings for
// this fixture — see isParkOperatingNow, which compares absolute instants).
const USH_SCHEDULE_FIXTURE = [
  {
    Date: '2026-08-18',
    VenueStatus: 'Open',
    OpenTimeString: '2026-08-18T09:00:00-07:00',
    CloseTimeString: '2026-08-18T19:00:00-07:00',
    EarlyEntryString: '2026-08-18T08:00:00-07:00',
  },
];

const SHOW: UniversalShowListEntry = {
  show_id: 'ush.cw.entertainment.meet_mario_and_luigi',
  resort_area_code: 'USH',
  venue_id: 'ush.ush',
  name: 'Meet Mario and Luigi',
  // Not OPEN/RIDE_NOW/a delay/an explicit long closure — falls into the
  // default branch that used to ignore park hours entirely.
  status: 'CLOSED',
  show_externally: true,
  show_times: [
    // "Today's" full day of slots, as the feed actually serves it from
    // midnight — some already past by any of the sampled times below, one
    // still ahead of both.
    {show_time_id: 'a', status: 'ENABLED', start_time: '2026-08-18T16:30:00.000Z'}, // 09:30 PDT
    {show_time_id: 'b', status: 'ENABLED', start_time: '2026-08-19T01:00:00.000Z'}, // 18:00 PDT
  ],
};

const HHN_NIGHTS = [{
  date: '2026-09-03',
  name: 'Halloween Horror Nights',
  openingTime: '19:00',
  closingTime: '01:00',
  closesNextDay: true,
}];

const HHN_SHOW: UniversalShowListEntry = {
  ...SHOW,
  show_id: 'ush.upper_lot.events.hhn_2026_show_the_purge',
  venue_id: 'ush.upper_lot',
  name: 'The Purge: Dangerous Waters',
  category: 'hhn',
  status: 'OPEN',
  show_times: [
    {show_time_id: 'hhn-a', status: 'ENABLED', start_time: '2026-09-04T04:00:00.000Z'},
    {show_time_id: 'hhn-b', status: 'ENABLED', start_time: '2026-09-04T06:00:00.000Z'},
    {show_time_id: 'hhn-c', status: 'ENABLED', start_time: '2026-09-04T07:30:00.000Z'},
  ],
};

const USH_HHN_DAYTIME_SCHEDULE = [{
  Date: '2026-09-04',
  OpenTimeString: '2026-09-04T12:00:00-04:00',
  CloseTimeString: '2026-09-04T21:00:00-04:00',
  EarlyEntryString: '2026-09-04T11:00:00-04:00',
  SpecialEntryUnix: 0,
}];

function stubPark<T extends UniversalStudios | UniversalOrlando>(
  park: T,
  showList: UniversalShowListEntry[],
  scheduleByVenueId: Record<string, any> = {'13825': USH_SCHEDULE_FIXTURE},
): T {
  (park as any)._init = async () => undefined;
  (park as any).getWaitTimes = async () => [];
  (park as any).getVirtualQueueStates = async () => [];
  // buildLiveData reads the place list to fold express-queue POIs onto their
  // maze; no express variants in these fixtures, so an empty list is exact.
  (park as any).getPlaces = async () => [];
  (park as any).getShowList = async () => showList;
  // venueId-aware, unlike a fixed return value: needed for UOR (4 distinct
  // legacy venue ids sharing one buildLiveData call) to prove each park
  // gates independently rather than all sharing whatever the stub returns.
  (park as any).getVenueSchedule = async (venueId: string) => {
    if (!(venueId in scheduleByVenueId)) throw new Error(`no schedule fixture stubbed for venue ${venueId}`);
    return scheduleByVenueId[venueId];
  };
  return park;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('a performance happening now outranks the published windows', () => {
  // Both published windows are incomplete, in opposite directions, and the
  // feed found both on the first night the gate ran:
  //   - Epic Universe's "Universal Celestial Goodnight" has ONE performance at
  //     20:30 against a 20:00 posted park close.
  //   - Hollywood's "Meet HamiKuma" performs at 17:30 and 18:30 during HHN
  //     early access, before the 19:00 ticketed-event window opens.
  // Each published CLOSED beside a performance that was minutes away or
  // already on stage. Enumerating windows keeps losing this race.
  const show = (slots: string[], status = 'OPEN'): UniversalShowListEntry => ({
    show_id: 'x.y.shows.z', resort_area_code: 'X', venue_id: 'x.y',
    name: 'A Show', status, show_externally: true,
    show_times: slots.map((t, i) => ({show_time_id: String(i), status: 'ENABLED', start_time: t})),
  } as any);
  // parkOperating=false throughout: the park is shut / the event is not open.
  const verdict = (s: UniversalShowListEntry, iso: string) =>
    mapUniversalShowStatus(s.status, true, false, hasImminentPerformance(s, new Date(iso)));

  test('a single performance 20 minutes away reads OPERATING', () => {
    expect(verdict(show(['2026-09-06T00:30:00Z']), '2026-09-06T00:10:00Z')).toBe('OPERATING');
  });

  test('the same performance 5 minutes AFTER it started still reads OPERATING', () => {
    // parseShowTimes drops anything already begun, so a one-slot show is
    // otherwise indistinguishable from one that finished for the day —
    // it would read CLOSED while literally on stage.
    expect(verdict(show(['2026-09-06T00:30:00Z']), '2026-09-06T00:35:00Z')).toBe('OPERATING');
  });

  test('45 minutes after the last performance it reads CLOSED again', () => {
    expect(verdict(show(['2026-09-06T00:30:00Z']), '2026-09-06T01:15:00Z')).toBe('CLOSED');
  });

  test('an early-access slot before the event window reads OPERATING', () => {
    const hamikuma = show(['2026-09-06T00:30:00Z', '2026-09-06T01:30:00Z']);
    expect(verdict(hamikuma, '2026-09-06T01:05:00Z')).toBe('OPERATING');
  });

  test('a slot 54 minutes away does NOT count — nobody can see it yet', () => {
    // Meet Mario at 18:06 PT with its next performance at 19:00: park shut,
    // event not open. CLOSED is the honest answer, and the window must be
    // tight enough to say so.
    expect(verdict(show(['2026-09-06T02:00:00Z']), '2026-09-06T01:06:00Z')).toBe('CLOSED');
  });

  test('THE #321 CASE SURVIVES: a next-day slot never counts as imminent', () => {
    // 03:00 local, park shut for hours, tomorrow's 09:00 performance listed.
    // This is the overnight staleness the whole gate was built for; a looser
    // window would quietly undo it.
    expect(verdict(show(['2026-09-06T16:00:00Z']), '2026-09-06T10:00:00Z')).toBe('CLOSED');
  });

  test('an explicit long closure is not reopened by a stale slot', () => {
    expect(verdict(show(['2026-09-06T00:30:00Z'], 'EXTENDED_CLOSURE'), '2026-09-06T00:10:00Z')).toBe('CLOSED');
  });

  test('a delayed show still reads DOWN, not OPERATING', () => {
    expect(verdict(show(['2026-09-06T00:30:00Z'], 'BRIEF_DELAY'), '2026-09-06T00:10:00Z')).toBe('DOWN');
  });

  test('disabled slots are ignored', () => {
    const s: any = show(['2026-09-06T00:30:00.000Z']);
    s.show_times[0].status = 'DISABLED';
    expect(hasImminentPerformance(s, new Date('2026-09-06T00:10:00.000Z'))).toBe(false);
  });

  test('a show with no show_times at all is not imminent', () => {
    // show_times is optional on UniversalShowListEntry, so the ?? [] fallback
    // is load-bearing in production and nothing else exercises it.
    expect(hasImminentPerformance({show_id: 'a', name: 'b', status: 'OPEN',
      show_externally: true, resort_area_code: 'X', venue_id: 'x.y'} as any,
      new Date('2026-09-06T00:10:00.000Z'))).toBe(false);
  });

  test('THE WINDOW IS EXACTLY 30 MINUTES, in both directions', () => {
    // The constant is sized by Meet HamiKuma's early-access slot, which is
    // exactly 30 minutes out at the moment it first goes wrong — so inclusive
    // 30 is load-bearing, not decorative, and retuning it must break a test.
    const s = show(['2026-09-06T00:30:00.000Z']);
    expect(hasImminentPerformance(s, new Date('2026-09-06T00:00:00.000Z'))).toBe(true);  // -30m exactly
    expect(hasImminentPerformance(s, new Date('2026-09-06T01:00:00.000Z'))).toBe(true);  // +30m exactly
    expect(hasImminentPerformance(s, new Date('2026-09-05T23:59:59.000Z'))).toBe(false); // -30m01s
    expect(hasImminentPerformance(s, new Date('2026-09-06T01:00:01.000Z'))).toBe(false); // +30m01s
  });
});

describe('resolveParkDay picks the nearest relevant day, not the last one listed', () => {
  // Hollywood has TWO relevant dates: its own, and the Eastern one the legacy
  // server keys rows to. Between 21:00 and midnight Pacific the Eastern date
  // has already rolled over, so both today's and tomorrow's rows are
  // "relevant". A last-one-wins rule adopts TOMORROW's window and silently
  // drops the post-close grace — and makes the answer depend on the upstream
  // array's ordering, which is not a property worth relying on.
  const TODAY = {
    Date: '2026-09-05', VenueStatus: '',
    OpenTimeString: '2026-09-05T08:00:00-07:00',
    CloseTimeString: '2026-09-05T22:00:00-07:00',
  };
  const TOMORROW = {
    Date: '2026-09-06', VenueStatus: '',
    OpenTimeString: '2026-09-06T08:00:00-07:00',
    CloseTimeString: '2026-09-06T22:00:00-07:00',
  };

  async function windowAt(iso: string, rows: any[]) {
    const park: any = stubPark(new UniversalStudios(), [], {'13825': rows});
    const day = await park.resolveParkDay('13825', new Date(iso));
    return day.window;
  }

  test('the nearest day wins whichever order the rows arrive in', async () => {
    // 22:30 PT on the 5th: half an hour past today's 22:00 close, inside the
    // grace. Tomorrow's window opens 9.5 hours away.
    const at = '2026-09-06T05:30:00.000Z';
    const ascending = await windowAt(at, [TODAY, TOMORROW]);
    const descending = await windowAt(at, [TOMORROW, TODAY]);
    expect(ascending).toEqual(descending);
    expect(new Date(ascending.closesAt).toISOString()).toBe('2026-09-06T05:00:00.000Z'); // 22:00 PT on the 5th
  });

  test('the operating verdict is unaffected by which window is kept', async () => {
    const at = '2026-09-06T05:30:00.000Z';
    for (const rows of [[TODAY, TOMORROW], [TOMORROW, TODAY]]) {
      const park: any = stubPark(new UniversalStudios(), [], {'13825': rows});
      expect((await park.resolveParkDay('13825', new Date(at))).operating).toBe(false);
    }
  });
});

describe('Universal buildLiveData — the imminent rule is actually wired in', () => {
  // Every other test above calls the pure functions directly. That leaves the
  // call site itself unasserted: replacing hasImminentPerformance(show, now)
  // with `false`, or transposing it with parkOperating (both booleans, so the
  // compiler stays silent), passes a suite made only of unit tests. These
  // drive the real buildLiveData -> getLiveData path instead.
  const DAY_SHUT = [
    {Date: '2026-09-05', VenueStatus: '', OpenTimeString: '2026-09-05T08:00:00-07:00', CloseTimeString: '2026-09-05T18:00:00-07:00'},
    {Date: '2026-09-06', VenueStatus: '', OpenTimeString: '2026-09-06T08:00:00-07:00', CloseTimeString: '2026-09-06T18:00:00-07:00'},
  ];

  async function rowAt(iso: string, slots: string[], status: string) {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(iso));
    const show: UniversalShowListEntry = {
      show_id: 'ush.upper_lot.shows.meet.hamikuma',
      resort_area_code: 'USH', venue_id: 'ush.upper_lot',
      name: 'Meet HamiKuma', status, show_externally: true,
      show_times: slots.map((t, i) => ({show_time_id: String(i), status: 'ENABLED', start_time: t})),
    } as any;
    const park: any = stubPark(new UniversalStudios(), [show], {'13825': DAY_SHUT});
    park.getEventNights = async () => [];
    park.getPlaces = async () => [];
    const rows = await park.getLiveData();
    vi.useRealTimers();
    return rows.find((r: any) => r.id === 'ush.upper_lot.shows.meet.hamikuma');
  }

  test('just past the close, performance 20 minutes out: the row is OPERATING', async () => {
    // 18:10 PT, ten minutes after the 18:00 close, slot at 18:30 — Celestial
    // Goodnight's shape. Only the imminent rule can produce OPERATING here: if
    // the call site is unwired, or its argument transposed with parkOperating
    // (false), this reads CLOSED.
    const row = await rowAt('2026-09-06T01:10:00.000Z', ['2026-09-06T01:30:00.000Z'], 'OPEN');
    expect(row.status).toBe('OPERATING');
  });

  test("status CLOSED — the shape Universal actually reports between appearances", async () => {
    // Meet-and-greets report CLOSED between slots, which is the DEFAULT branch
    // of mapUniversalShowStatus, not the OPEN branch every other new test
    // exercises. Both shows this change was written for are this shape.
    const row = await rowAt('2026-09-06T01:10:00.000Z', ['2026-09-06T01:30:00.000Z'], 'CLOSED');
    expect(row.status).toBe('OPERATING');
    expect(row.showtimes).toHaveLength(1);
  });

  test('park shut and nothing imminent: still CLOSED', async () => {
    // The control. Same park, same shut hours, slot 14 hours away — the
    // overnight staleness case, through the full pipeline.
    const row = await rowAt('2026-09-06T01:10:00.000Z', ['2026-09-06T16:00:00.000Z'], 'CLOSED');
    expect(row.status).toBe('CLOSED');
  });

  test('MEET HELLO KITTY: a mis-stamped slot cannot resurrect a show at 02:30', async () => {
    // The real regression the first version shipped. USH's Meet Hello Kitty
    // carries eleven slots across 09:00-15:00 PDT plus a twelfth at
    // 2026-09-06T09:30:00.000Z — tomorrow's 09:30 local stamped Z instead of
    // -07:00, landing at 02:30 PDT. Park shut since 18:00, event over at
    // 02:00. Unanchored, the imminent rule published OPERATING for a full
    // hour in the middle of the night off that single row.
    const row = await rowAt(
      '2026-09-06T09:30:00.000Z',                                   // 02:30 PDT
      ['2026-09-05T22:00:00.000Z', '2026-09-06T09:30:00.000Z'],     // 15:00 PDT + the bad row
      'OPEN',
    );
    expect(row.status).toBe('CLOSED');
  });

  test('an hour past close is the limit, not four hours', async () => {
    // 19:40 PT with a slot at 20:00: 1h40m past the 18:00 close, beyond the
    // grace. The rule must not reach here even though a slot is 20 min away.
    const row = await rowAt('2026-09-06T02:40:00.000Z', ['2026-09-06T03:00:00.000Z'], 'OPEN');
    expect(row.status).toBe('CLOSED');
  });
});

describe('Universal buildLiveData — an ordinary show performing inside the event', () => {
  // Super Nintendo World stays open through Halloween Horror Nights. On
  // 2026-09-05 "Meet Mario and Luigi", "Meet Toad" and "Meet Princess Peach"
  // carry ENABLED performances at 19:00-21:30 PT while Hollywood's day park
  // closed at 18:00 — and they are categorised `general`, not `hhn`. Gated on
  // day-park hours alone they publish CLOSED beside a showtime happening right
  // now: the exact contradiction this gate was built to remove, from the other
  // side of the clock.
  const NIGHT = [{
    date: '2026-09-05', name: 'Halloween Horror Nights',
    openingTime: '19:00', closingTime: '02:00', closesNextDay: true,
  }];
  // BOTH days: isParkOperatingNow fails open unless it finds a row for the
  // current day in either the park's own timezone or Eastern, so a fixture
  // with only the 5th would leave the gate ungated after midnight and prove
  // nothing.
  const DAY_SHUT = [
    {
      Date: '2026-09-05', VenueStatus: '',
      OpenTimeString: '2026-09-05T08:00:00-07:00',
      CloseTimeString: '2026-09-05T18:00:00-07:00',
    },
    {
      Date: '2026-09-06', VenueStatus: '',
      OpenTimeString: '2026-09-06T08:00:00-07:00',
      CloseTimeString: '2026-09-06T18:00:00-07:00',
    },
  ];

  // The event calendar is only consulted when an hhn-category show is in the
  // list, so the ordinary show cannot be ungated by the event without one
  // present. That is the real shape: The Purge is in tonight's feed.
  const HHN_SHOW = {
    show_id: 'ush.upper_lot.events.hhn_2026_show_the_purge',
    resort_area_code: 'USH', venue_id: 'ush.upper_lot', category: 'hhn',
    name: 'The Purge: Dangerous Waters', status: 'CLOSED', show_externally: true,
    show_times: [{show_time_id: 'p', status: 'ENABLED', start_time: '2026-09-06T04:00:00Z'}],
  } as any;

  function meet(slotsUtc: string[]): UniversalShowListEntry {
    return {
      show_id: 'ush.lower_lot.shows.meet_mario_and_luigi',
      resort_area_code: 'USH', venue_id: 'ush.lower_lot',
      name: 'Meet Mario and Luigi', status: 'CLOSED', show_externally: true,
      show_times: slotsUtc.map((t, i) => ({show_time_id: String(i), status: 'ENABLED', start_time: t})),
    } as any;
  }

  async function statusAt(iso: string, slots: string[]) {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(iso));
    const park: any = stubPark(new UniversalStudios(), [meet(slots), HHN_SHOW], {'13825': DAY_SHUT});
    park.getEventNights = async () => NIGHT;
    park.getPlaces = async () => [];
    const rows = await park.getLiveData();
    vi.useRealTimers();
    return rows.find((r: any) => r.id === 'ush.lower_lot.shows.meet_mario_and_luigi');
  }

  test('performs during the event: OPERATING, not CLOSED-with-a-showtime', async () => {
    // 20:10 PT, day park shut two hours, event running, 21:00 PT slot ahead.
    const row = await statusAt('2026-09-06T03:10:00Z', ['2026-09-06T04:00:00Z']);
    expect(row.status).toBe('OPERATING');
    expect(row.showtimes).toHaveLength(1);
  });

  test('its slots done for the night: CLOSED even though the event runs on', async () => {
    // 23:00 PT, event open until 02:00, but this show has finished.
    const row = await statusAt('2026-09-06T06:00:00Z', ['2026-09-06T04:00:00Z']);
    expect(row.status).toBe('CLOSED');
  });

  test('ONLY a next-day slot: still CLOSED, however long the event runs', async () => {
    // 00:30 PT mid-event with tomorrow's 09:00 PT slot ahead. A bare "the
    // event is on" check would report OPERATING here and undo the overnight
    // staleness fix this gate exists for.
    const row = await statusAt('2026-09-06T07:30:00Z', ['2026-09-06T16:00:00Z']);
    expect(row.status).toBe('CLOSED');
  });

  test('after the event closes: CLOSED', async () => {
    const row = await statusAt('2026-09-06T10:30:00Z', ['2026-09-06T16:00:00Z']);
    expect(row.status).toBe('CLOSED');
  });
});

describe('Universal buildLiveData — show status clock-gated against park hours', () => {
  test('overnight, park shut: show reads CLOSED even though a slot is still hours away', async () => {
    // 03:00 PDT, 2026-08-18 — before EarlyEntryString (08:00 PDT). This is
    // the incident window: park closed since ~19:12 PDT the prior evening,
    // both show_times slots technically "in the future" relative to now.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-18T10:00:00.000Z'));

    const park = stubPark(new UniversalStudios(), [SHOW]);
    const liveData = await park.getLiveData();
    const entry = liveData.find((d) => d.id === 'ush.cw.entertainment.meet_mario_and_luigi');

    expect(entry).toBeDefined();
    expect(entry!.status).toBe('CLOSED'); // was 'OPERATING' before the fix
  });

  test('during EXTRA_HOURS, park open: the same show reads OPERATING', async () => {
    // 08:25 PDT, 2026-08-18 — inside EarlyEntryString..OpenTimeString.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-18T15:25:00.000Z'));

    const park = stubPark(new UniversalStudios(), [SHOW]);
    const liveData = await park.getLiveData();
    const entry = liveData.find((d) => d.id === 'ush.cw.entertainment.meet_mario_and_luigi');

    expect(entry).toBeDefined();
    expect(entry!.status).toBe('OPERATING');
  });

  test('during general operating hours, park open: the same show reads OPERATING', async () => {
    // 12:00 PDT, 2026-08-18 — well inside OpenTimeString..CloseTimeString.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-18T19:00:00.000Z'));

    const park = stubPark(new UniversalStudios(), [SHOW]);
    const liveData = await park.getLiveData();
    const entry = liveData.find((d) => d.id === 'ush.cw.entertainment.meet_mario_and_luigi');

    expect(entry).toBeDefined();
    expect(entry!.status).toBe('OPERATING');
  });

  // Live evidence, not just theory: sampled at 03:24 PDT with USH's own
  // schedule confirming the park shut, 25 of 31 externally-shown show-list
  // entries carried `status: "OPEN"` outright. The status field itself is
  // stale overnight, same as the ride wait-time feed (parksapi #316), so an
  // explicit OPEN is gated exactly like the showtimes-derived default.
  test('explicit OPEN status IS clock-gated: closed park overrides it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-18T10:00:00.000Z')); // overnight, park shut

    const openShow: UniversalShowListEntry = {...SHOW, status: 'OPEN'};
    const park = stubPark(new UniversalStudios(), [openShow]);
    const liveData = await park.getLiveData();
    const entry = liveData.find((d) => d.id === 'ush.cw.entertainment.meet_mario_and_luigi');

    expect(entry!.status).toBe('CLOSED'); // was 'OPERATING' before the fix — the observed incident
  });

  test('explicit OPEN status during EXTRA_HOURS: park open, reads OPERATING', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-18T15:25:00.000Z')); // 08:25 PDT, EXTRA_HOURS

    const openShow: UniversalShowListEntry = {...SHOW, status: 'OPEN'};
    const park = stubPark(new UniversalStudios(), [openShow]);
    const liveData = await park.getLiveData();
    const entry = liveData.find((d) => d.id === 'ush.cw.entertainment.meet_mario_and_luigi');

    expect(entry!.status).toBe('OPERATING');
  });

  test('venue schedule lookup failure degrades to ungated (old behaviour), not a thrown error', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-18T10:00:00.000Z')); // overnight, park shut

    const park = stubPark(new UniversalStudios(), [SHOW]);
    (park as any).getVenueSchedule = async () => { throw new Error('upstream 500'); };

    const liveData = await park.getLiveData();
    const entry = liveData.find((d) => d.id === 'ush.cw.entertainment.meet_mario_and_luigi');

    expect(entry!.status).toBe('OPERATING');
  });

  test('a show at CityWalk (no schedule-bearing venue) is not gated', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-18T10:00:00.000Z')); // overnight, USH park shut

    const cityWalkShow: UniversalShowListEntry = {
      ...SHOW,
      show_id: 'ush.cw.entertainment.5_towers_stage',
      venue_id: 'ush.cw',
    };
    const park = stubPark(new UniversalStudios(), [cityWalkShow]);
    const liveData = await park.getLiveData();
    const entry = liveData.find((d) => d.id === 'ush.cw.entertainment.5_towers_stage');

    expect(entry!.status).toBe('OPERATING'); // hours unknown -> ungated, same as before the fix
  });

  // resolveScheduleVenue's reparenting branch (NON_SURFACED_VENUE_PARENT),
  // driven end-to-end through buildLiveData rather than just unit-tested in
  // isolation: a show whose venue_id is the sub-area 'ush.upper_lot' must
  // gate against the SURFACED park's schedule ('ush.ush' / legacy 13825),
  // not go ungated for lack of a direct match.
  test('a show at Upper Lot reparents onto ush.ush\'s schedule (not ungated)', async () => {
    const upperLotShow: UniversalShowListEntry = {
      ...SHOW,
      show_id: 'ush.upper_lot.shows.meet_dracula',
      venue_id: 'ush.upper_lot',
    };

    // Overnight, ush.ush schedule says shut -> reparented show must gate CLOSED.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-18T10:00:00.000Z'));
    let park = stubPark(new UniversalStudios(), [upperLotShow]);
    let liveData = await park.getLiveData();
    let entry = liveData.find((d) => d.id === 'ush.upper_lot.shows.meet_dracula');
    expect(entry!.status).toBe('CLOSED');
    vi.useRealTimers();

    // Inside ush.ush's operating window -> the same reparented show is OPERATING.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-18T19:00:00.000Z'));
    park = stubPark(new UniversalStudios(), [upperLotShow]);
    liveData = await park.getLiveData();
    entry = liveData.find((d) => d.id === 'ush.upper_lot.shows.meet_dracula');
    expect(entry!.status).toBe('OPERATING');
  });

  // The `parkOperatingByVenue.get(scheduleVenue) ?? true` fail-open branch:
  // resolveScheduleVenue passes an unrecognised (but non-null) venue_id
  // through as-is, and it simply never appears as a key in the venue map
  // built from PARK_PLACE_ID_TO_LEGACY_VENUE_ID — must fall open (ungated),
  // not throw and not silently resolve to closed.
  test('a show at an unrecognised venue_id (no PARK_PLACE_ID_TO_LEGACY_VENUE_ID entry) falls open, ungated', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-18T10:00:00.000Z')); // overnight, USH's real park shut

    const mysteryVenueShow: UniversalShowListEntry = {
      ...SHOW,
      show_id: 'ush.some_new_area.shows.mystery_show',
      venue_id: 'ush.some_new_area', // not in NON_SURFACED_VENUE_PARENT, not a surfaced park key
    };
    const park = stubPark(new UniversalStudios(), [mysteryVenueShow]);
    const liveData = await park.getLiveData();
    const entry = liveData.find((d) => d.id === 'ush.some_new_area.shows.mystery_show');

    expect(entry!.status).toBe('OPERATING'); // hours unknown -> ungated
  });

  test('a non-array schedule response does not throw and degrades to ungated', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-18T10:00:00.000Z')); // overnight, park shut

    const park = stubPark(new UniversalStudios(), [SHOW]);
    (park as any).getVenueSchedule = async () => ({error: 'not found', problem: 'VENUE_NOT_FOUND'});

    const liveData = await park.getLiveData();
    const entry = liveData.find((d) => d.id === 'ush.cw.entertainment.meet_mario_and_luigi');

    expect(entry!.status).toBe('OPERATING');
  });

  test('an empty schedule array degrades to ungated (indistinguishable from an upstream glitch)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-18T10:00:00.000Z')); // overnight, park shut

    const park = stubPark(new UniversalStudios(), [SHOW]);
    (park as any).getVenueSchedule = async () => [];

    const liveData = await park.getLiveData();
    const entry = liveData.find((d) => d.id === 'ush.cw.entertainment.meet_mario_and_luigi');

    expect(entry!.status).toBe('OPERATING');
  });

  test('a malformed current day plus a valid future day degrades to ungated', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-18T19:00:00.000Z'));

    const park = stubPark(new UniversalStudios(), [SHOW]);
    (park as any).getVenueSchedule = async () => [
      {Date: '2026-08-18', VenueStatus: 'Open'},
      {
        Date: '2026-08-19',
        VenueStatus: 'Open',
        OpenTimeString: '2026-08-19T09:00:00-07:00',
        CloseTimeString: '2026-08-19T19:00:00-07:00',
      },
    ];

    const liveData = await park.getLiveData();
    const entry = liveData.find((d) => d.id === SHOW.show_id);

    expect(entry!.status).toBe('OPERATING');
  });

  test('an omitted current day plus a valid future row degrades to ungated', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-18T19:00:00.000Z'));

    const park = stubPark(new UniversalStudios(), [SHOW]);
    (park as any).getVenueSchedule = async () => [{
      Date: '2026-08-19',
      VenueStatus: 'Open',
      OpenTimeString: '2026-08-19T09:00:00-07:00',
      CloseTimeString: '2026-08-19T19:00:00-07:00',
    }];

    const entry = (await park.getLiveData()).find((d) => d.id === SHOW.show_id);
    expect(entry!.status).toBe('OPERATING');
  });

  test('an inverted current-day window degrades to ungated', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-18T19:00:00.000Z'));

    const park = stubPark(new UniversalStudios(), [SHOW]);
    (park as any).getVenueSchedule = async () => [{
      Date: '2026-08-18',
      VenueStatus: 'Open',
      OpenTimeString: '2026-08-18T19:00:00-07:00',
      CloseTimeString: '2026-08-18T09:00:00-07:00',
    }];

    const entry = (await park.getLiveData()).find((d) => d.id === SHOW.show_id);
    expect(entry!.status).toBe('OPERATING');
  });

  test('a malformed EarlyEntryString falls back to the valid general opening', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-18T19:00:00.000Z'));

    const park = stubPark(new UniversalStudios(), [SHOW], {
      '13825': [{
        ...USH_SCHEDULE_FIXTURE[0],
        EarlyEntryString: 'not-a-date',
      }],
    });
    const liveData = await park.getLiveData();
    const entry = liveData.find((d) => d.id === SHOW.show_id);

    expect(entry!.status).toBe('OPERATING');
  });

  test('a schedule where every day is explicitly Closed is a confident CLOSED, not a fail-open', async () => {
    // Distinguishes "we have real data and it says closed" (Volcano Bay's
    // off-season) from "we have no usable data" (the empty-array case
    // above) — both must not throw, but only the latter should fail open.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-18T19:00:00.000Z')); // would be OPERATING hours if open

    const park = stubPark(new UniversalStudios(), [SHOW]);
    (park as any).getVenueSchedule = async () => [
      {Date: '2026-08-18', VenueStatus: 'Closed'},
    ];

    const liveData = await park.getLiveData();
    const entry = liveData.find((d) => d.id === 'ush.cw.entertainment.meet_mario_and_luigi');

    expect(entry!.status).toBe('CLOSED');
  });

  test('a schedule day with no VenueStatus field at all still gates correctly (real USH shape has none)', async () => {
    // src/parks/universal/gentype/UniversalStudios.fetchVenueSchedule.ts —
    // real USH captures never include VenueStatus at all, unlike UOR's
    // fixture. Prove the openMs/closeMs-only path works without it.
    const noStatusFixture = [
      {
        Date: '2026-08-18',
        OpenTimeString: '2026-08-18T09:00:00-07:00',
        CloseTimeString: '2026-08-18T19:00:00-07:00',
        EarlyEntryString: '2026-08-18T08:00:00-07:00',
      },
    ];

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-18T10:00:00.000Z')); // overnight, before EarlyEntry
    let park = stubPark(new UniversalStudios(), [SHOW], {'13825': noStatusFixture});
    let liveData = await park.getLiveData();
    let entry = liveData.find((d) => d.id === 'ush.cw.entertainment.meet_mario_and_luigi');
    expect(entry!.status).toBe('CLOSED');
    vi.useRealTimers();

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-18T19:00:00.000Z')); // inside the window
    park = stubPark(new UniversalStudios(), [SHOW], {'13825': noStatusFixture});
    liveData = await park.getLiveData();
    entry = liveData.find((d) => d.id === 'ush.cw.entertainment.meet_mario_and_luigi');
    expect(entry!.status).toBe('OPERATING');
  });

  test('multi-day schedule: matches the correct day, not just the first entry', async () => {
    // Two days with DIFFERENT hours; `now` only falls inside the second
    // day's window. A bug that only checked schedule[0] would wrongly gate
    // this CLOSED.
    const multiDayFixture = [
      {
        Date: '2026-08-17',
        VenueStatus: 'Open',
        OpenTimeString: '2026-08-17T09:00:00-07:00',
        CloseTimeString: '2026-08-17T17:00:00-07:00', // closes well before `now` below
      },
      {
        Date: '2026-08-18',
        VenueStatus: 'Open',
        OpenTimeString: '2026-08-18T09:00:00-07:00',
        CloseTimeString: '2026-08-18T23:00:00-07:00',
      },
    ];

    // SHOW's fixed show_times are both in the past by this point in the
    // month, which would fail hasFutureShowtimes regardless of gating — use
    // a show with a slot still ahead of this test's `now`.
    const lateShow: UniversalShowListEntry = {
      ...SHOW,
      show_times: [
        {show_time_id: 'c', status: 'ENABLED', start_time: '2026-08-19T04:30:00.000Z'},
      ],
    };

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-19T04:00:00.000Z')); // 2026-08-18T21:00 PDT — only day 2 covers this
    const park = stubPark(new UniversalStudios(), [lateShow], {'13825': multiDayFixture});
    const liveData = await park.getLiveData();
    const entry = liveData.find((d) => d.id === 'ush.cw.entertainment.meet_mario_and_luigi');

    expect(entry!.status).toBe('OPERATING');
  });

  describe('Hollywood HHN — ticketed-event shows use the event window only', () => {
    function hhnPark(
      showList: UniversalShowListEntry[],
      eventNights: typeof HHN_NIGHTS = HHN_NIGHTS,
    ): UniversalStudios {
      const park = stubPark(
        new UniversalStudios(),
        showList,
        {'13825': USH_HHN_DAYTIME_SCHEDULE},
      );
      (park as any).getEventNights = async () => eventNights;
      return park;
    }

    test('live HHN show remains OPERATING while the daytime park is closed', async () => {
      vi.useFakeTimers();
      // Live-verified 2026-09-03 at 23:58 PDT: day park closed, HHN open,
      // The Purge OPEN with a final 00:30 performance still ahead.
      vi.setSystemTime(new Date('2026-09-04T06:58:00.000Z'));

      const liveData = await hhnPark([HHN_SHOW]).getLiveData();
      const entry = liveData.find((d) => d.id === HHN_SHOW.show_id);

      expect(entry!.status).toBe('OPERATING');
      expect(entry!.showtimes).toHaveLength(1);
    });

    test('ordinary next-day show remains CLOSED during HHN after midnight', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-09-04T06:58:00.000Z'));

      const daytimeShow: UniversalShowListEntry = {
        ...SHOW,
        show_id: 'ush.upper_lot.shows.daytime_only',
        venue_id: 'ush.upper_lot',
        status: 'OPEN',
        show_times: [{
          show_time_id: 'day-a',
          status: 'ENABLED',
          start_time: '2026-09-04T18:00:00.000Z',
        }],
      };
      const liveData = await hhnPark([HHN_SHOW, daytimeShow]).getLiveData();
      const entry = liveData.find((d) => d.id === daytimeShow.show_id);

      expect(entry!.status).toBe('CLOSED');
    });

    test('HHN show closes after the official event window', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-09-04T08:15:00.000Z')); // 01:15 PDT

      const liveData = await hhnPark([HHN_SHOW]).getLiveData();
      const entry = liveData.find((d) => d.id === HHN_SHOW.show_id);

      expect(entry!.status).toBe('CLOSED');
    });

    test('empty event calendar fails open for event shows only', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-09-04T06:58:00.000Z'));
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      const liveData = await hhnPark([HHN_SHOW], []).getLiveData();
      const entry = liveData.find((d) => d.id === HHN_SHOW.show_id);

      expect(entry!.status).toBe('OPERATING');
    });

    test('a malformed event calendar fails open rather than closing a live event', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-09-04T06:58:00.000Z'));
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      const malformed = [{...HHN_NIGHTS[0], openingTime: 'bad'}];
      const entry = (await hhnPark([HHN_SHOW], malformed).getLiveData())
        .find((d) => d.id === HHN_SHOW.show_id);

      expect(entry!.status).toBe('OPERATING');
    });

    test('event-calendar fetch failure fails open rather than closing a live event', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-09-04T06:58:00.000Z'));
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      const park = hhnPark([HHN_SHOW]);
      (park as any).getEventNights = async () => {
        throw new Error('HTTP 403');
      };
      const liveData = await park.getLiveData();
      const entry = liveData.find((d) => d.id === HHN_SHOW.show_id);

      expect(entry!.status).toBe('OPERATING');
    });

    test('does not fetch the event calendar when no event show is present', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-09-04T06:58:00.000Z'));

      const park = hhnPark([SHOW]);
      const getEventNights = vi.fn(async () => HHN_NIGHTS);
      (park as any).getEventNights = getEventNights;
      await park.getLiveData();

      expect(getEventNights).not.toHaveBeenCalled();
    });
  });

  // Universal Orlando: 4 parks sharing one buildLiveData call, each with its
  // own legacy venue id and independently computed operating state. Proves
  // the resortKey-filtered venue loop and per-venue gating both work when
  // more than one venue is in play at once — UOR was entirely untested
  // before this (only single-park UniversalStudios was exercised above).
  describe('Universal Orlando — multiple parks gated independently in one cycle', () => {
    const UOR_OPEN_SCHEDULE = [
      {
        Date: '2026-08-18',
        VenueStatus: 'Open',
        OpenTimeString: '2026-08-18T09:00:00-04:00',
        CloseTimeString: '2026-08-18T21:00:00-04:00',
      },
    ];
    const UOR_CLOSED_SCHEDULE = [
      {Date: '2026-08-18', VenueStatus: 'Closed'},
    ];

    test('a show at USF (open) reads OPERATING while a show at IOA (closed) reads CLOSED, same cycle', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-08-18T19:00:00.000Z')); // 15:00 EDT — inside USF's window

      const usfShow: UniversalShowListEntry = {
        ...SHOW,
        show_id: 'uor.usf.shows.bourne_stuntacular',
        venue_id: 'uor.usf',
      };
      const ioaShow: UniversalShowListEntry = {
        ...SHOW,
        show_id: 'uor.ioa.shows.frog_choir',
        venue_id: 'uor.ioa',
      };

      const park = stubPark(new UniversalOrlando(), [usfShow, ioaShow], {
        '10010': UOR_OPEN_SCHEDULE,   // uor.usf
        '10000': UOR_CLOSED_SCHEDULE, // uor.ioa
        '24000': UOR_CLOSED_SCHEDULE, // uor.eu
        '13801': UOR_CLOSED_SCHEDULE, // uor.vb
      });

      const liveData = await park.getLiveData();
      const usfEntry = liveData.find((d) => d.id === 'uor.usf.shows.bourne_stuntacular');
      const ioaEntry = liveData.find((d) => d.id === 'uor.ioa.shows.frog_choir');

      expect(usfEntry!.status).toBe('OPERATING');
      expect(ioaEntry!.status).toBe('CLOSED');
    });

    test('one UOR park\'s schedule-fetch failure does not corrupt gating for the others', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-08-18T19:00:00.000Z'));

      const usfShow: UniversalShowListEntry = {
        ...SHOW,
        show_id: 'uor.usf.shows.bourne_stuntacular',
        venue_id: 'uor.usf',
      };
      const ioaShow: UniversalShowListEntry = {
        ...SHOW,
        show_id: 'uor.ioa.shows.frog_choir',
        venue_id: 'uor.ioa',
      };

      const park = stubPark(new UniversalOrlando(), [usfShow, ioaShow], {
        '10010': UOR_OPEN_SCHEDULE,   // uor.usf — healthy
        '24000': UOR_CLOSED_SCHEDULE, // uor.eu
        '13801': UOR_CLOSED_SCHEDULE, // uor.vb
        // '10000' (uor.ioa) deliberately unstubbed -> stubPark's fixture
        // throws "no schedule fixture stubbed for venue 10000", exercising
        // isParkOperatingNow's own catch block for that one venue only.
      });

      const liveData = await park.getLiveData();
      const usfEntry = liveData.find((d) => d.id === 'uor.usf.shows.bourne_stuntacular');
      const ioaEntry = liveData.find((d) => d.id === 'uor.ioa.shows.frog_choir');

      expect(usfEntry!.status).toBe('OPERATING'); // unaffected by IOA's failure
      expect(ioaEntry!.status).toBe('OPERATING'); // IOA's own lookup failed -> ungated, not crashed
    });
  });
});

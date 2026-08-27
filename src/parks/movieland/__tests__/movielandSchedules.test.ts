import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  Movieland,
  parseMovielandLegend,
  parseMovielandSeason,
  movielandScheduleEntries,
  movielandMonthsToFetch,
  type MovielandCalendarMonth,
} from "../movieland.js";
import type { HTTPObj } from "../../../http.js";

/**
 * Movieland's opening hours are not in the Helpy app feed at all — the service
 * worker whitelists exactly five data files and none of them is a calendar.
 * They live on the CanevaWorld website, split across two halves that are only
 * meaningful together:
 *
 *   - the schedule page carries a colour legend, `data-cid` -> "10:00 - 19:00"
 *   - `bootstrap/template_calendar_data/0/3/{year}/{month}` maps each date to
 *     one of those `data-cid` values
 *
 * Fixtures are the live responses captured on 2026-08-27, chosen for the three
 * things that can go wrong:
 *
 *   October   contains 31/10 "10.00 - 24.00" — an hour ISO cannot express, on
 *             a date that is also past the end of European summer time.
 *   November  is dot-separated ("10.00 - 19.00") and mostly closed days.
 *   December  is out of season and returns no top-level days, but still nests
 *             a full `prev_month` block. Reading that would publish November's
 *             hours a second time under December.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8");
const month = (name: string) =>
  JSON.parse(fixture(name)) as MovielandCalendarMonth;

const TZ = "Europe/Rome";
const PAGE = fixture("calendarPage.html");
const LEGEND = parseMovielandLegend(PAGE);

describe("parseMovielandLegend", () => {
  test("reads the hours the site paints onto each day colour", () => {
    expect(LEGEND["895"]).toEqual({
      openingTime: "10:00",
      closingTime: "18:00",
    });
  });

  test("keeps the event name a day belongs to", () => {
    expect(LEGEND["897"]).toMatchObject({
      openingTime: "10:00",
      closingTime: "23:00",
      description: "Movy Night",
    });
  });

  test("accepts the dot-separated form the site also uses", () => {
    expect(LEGEND["1737"]).toMatchObject({
      openingTime: "10:00",
      closingTime: "19:00",
      description: "Natale all'improvviso",
    });
  });

  test("rolls a 24:00 close over to midnight on the next day", () => {
    // "Halloween Night 10.00 - 24.00". ISO has no hour 24.
    expect(LEGEND["900"]).toMatchObject({
      openingTime: "10:00",
      closingTime: "00:00",
      closesNextDay: true,
    });
  });

  test("marks a closed day rather than inventing hours for it", () => {
    expect(LEGEND["1775"]).toEqual({ closed: true });
  });

  test("drops the marketing tiles that share the legend markup", () => {
    // cid 762 is "Acquista un biglietto per Movieland..." — same markup, no
    // hours, and it never appears in the calendar data.
    expect(LEGEND["762"]).toBeUndefined();
  });

  test("covers every colour the 2026 calendar actually uses", () => {
    // The 12 content ids observed across the whole published season.
    for (const cid of ["895", "896", "897", "898", "900", "901", "902",
                       "1737", "1775", "3066", "3222", "3715"]) {
      expect(LEGEND[cid], `legend missing cid ${cid}`).toBeDefined();
    }
  });
});

describe("parseMovielandSeason", () => {
  test("reads the season bounds off the calendar widget", () => {
    expect(parseMovielandSeason(PAGE)).toEqual({
      min: "2026-04-01",
      max: "2026-11-30",
    });
  });
});

describe("movielandScheduleEntries", () => {
  const october = movielandScheduleEntries(month("month-2026-10.json"), LEGEND, TZ);

  test("publishes only the days the park is open", () => {
    // October 2026: 31 days, 17 of them closed.
    expect(october).toHaveLength(14);
    expect(october.map((e) => e.date)).not.toContain("2026-10-01");
  });

  test("returns entries in date order", () => {
    const dates = october.map((e) => e.date);
    expect(dates).toEqual([...dates].sort());
  });

  test("resolves a midnight close onto the following date", () => {
    const halloween = october.find((e) => e.date === "2026-10-31");
    expect(halloween).toMatchObject({
      type: "OPERATING",
      openingTime: "2026-10-31T10:00:00+01:00",
      closingTime: "2026-11-01T00:00:00+01:00",
      description: "Halloween Night",
    });
  });

  test("uses the offset in force on the day, not the offset today", () => {
    // European summer time ended 2026-10-25, so the same 10:00 opening is
    // +02:00 before that date and +01:00 after it.
    expect(october.find((e) => e.date === "2026-10-24")?.openingTime)
      .toBe("2026-10-24T10:00:00+02:00");
    expect(october.find((e) => e.date === "2026-10-30")?.openingTime)
      .toBe("2026-10-30T10:00:00+01:00");
  });

  test("reads the dot-separated November hours", () => {
    const november = movielandScheduleEntries(month("month-2026-11.json"), LEGEND, TZ);
    expect(november).toHaveLength(9);
    expect(november.find((e) => e.date === "2026-11-07")).toMatchObject({
      openingTime: "2026-11-07T10:00:00+01:00",
      closingTime: "2026-11-07T19:00:00+01:00",
    });
  });

  test("ignores the neighbouring months nested in the payload", () => {
    // December is out of season: no top-level days, but the response still
    // carries a populated `prev_month`. Walking it would republish November.
    const december = month("month-2026-12.json");
    expect(JSON.stringify(december)).toContain("2026-11-");
    expect(movielandScheduleEntries(december, LEGEND, TZ)).toEqual([]);
  });

  test("skips a day whose colour is missing from the legend", () => {
    const unknown: MovielandCalendarMonth = {
      contents_calendars: { "2": { "2026-08-01": { "99999": {} } } },
    };
    expect(movielandScheduleEntries(unknown, LEGEND, TZ)).toEqual([]);
  });
});

describe("movielandMonthsToFetch", () => {
  test("walks forward from the given month", () => {
    expect(movielandMonthsToFetch(2026, 8, 3)).toEqual([
      { year: 2026, month: 8 },
      { year: 2026, month: 9 },
      { year: 2026, month: 10 },
    ]);
  });

  test("rolls into the next year", () => {
    expect(movielandMonthsToFetch(2026, 11, 4)).toEqual([
      { year: 2026, month: 11 },
      { year: 2026, month: 12 },
      { year: 2027, month: 1 },
      { year: 2027, month: 2 },
    ]);
  });
});

describe("Movieland calendar URLs", () => {
  test("builds the URLs the schedule fetches use", async () => {
    const park = new Movieland();
    park.webBase = "https://example.invalid";
    expect(park.calendarPageUrl()).toBe(
      "https://example.invalid/calendario-orari-prezzi.html",
    );
    expect(park.calendarMonthUrl(2026, 11)).toBe(
      "https://example.invalid/bootstrap/template_calendar_data/0/3/2026/11",
    );
  });

});

describe("Movieland.buildSchedules", () => {
  function scheduledPark(): Movieland {
    const park = new Movieland();
    park.webBase = "https://example.invalid";
    park.scheduleMonths = 3;
    park.fetchCalendarPage = (async () => ({ text: async () => PAGE })) as any;
    park.fetchCalendarMonth = (async (year: number, m: number) => ({
      json: async () => {
        try {
          return month(`month-${year}-${m}.json`);
        } catch {
          return {}; // months outside the captured range, as the site returns
        }
      },
    })) as any;
    // The real one is @cache-decorated and would key against a shared sqlite
    // file; the parse itself is covered above.
    park.getCalendarLegend = (async () => LEGEND) as any;
    return park;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    // 12:00 Rome on a live October day: the fetch window is Oct, Nov, Dec.
    vi.setSystemTime(new Date("2026-10-15T10:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  test("publishes one entry per open day across the fetched months", async () => {
    const schedules = await scheduledPark().getSchedules();

    expect(schedules).toHaveLength(1);
    expect(schedules[0].id).toBe("movieland");
    // 14 open days in October + 9 in November; December is out of season.
    expect(schedules[0].schedule).toHaveLength(23);
    expect(schedules[0].schedule[0].date).toBe("2026-10-02");
    expect(schedules[0].schedule.at(-1)?.date).toBe("2026-11-29");
  });

  test("publishes the whole current month, including days already past", async () => {
    // The endpoint serves whole months and the earlier days are kept rather
    // than trimmed to today, so the wiki keeps a usable recent history.
    vi.setSystemTime(new Date("2026-10-28T10:00:00Z"));
    const dates = (await scheduledPark().getSchedules())[0].schedule.map((e) => e.date);
    expect(dates).toContain("2026-10-02");
    expect(dates).toContain("2026-10-31");
  });

  test("reads the month from the park's timezone, not the host's", async () => {
    // 23:30 UTC on 31 October is already 1 November in Rome. Reading the month
    // in UTC would fetch October, November, December and miss January.
    vi.setSystemTime(new Date("2026-10-31T23:30:00Z"));
    const park = scheduledPark();
    const asked: string[] = [];
    park.fetchCalendarMonth = (async (y: number, m: number) => {
      asked.push(`${y}-${m}`);
      return { json: async () => ({}) };
    }) as any;
    await park.getSchedules();
    expect(asked).toEqual(["2026-11", "2026-12", "2027-1"]);
  });

  test("does not republish a month under its neighbour", async () => {
    const dates = (await scheduledPark().getSchedules())[0].schedule.map((e) => e.date);
    expect(new Set(dates).size).toBe(dates.length);
  });

  test("publishes nothing at all rather than an empty schedule", async () => {
    // Out of season every month comes back with no days. Returning
    // [{id, schedule: []}] would push an empty schedule to the wiki and wipe
    // the hours already there; returning [] is a no-op the sync skips.
    vi.setSystemTime(new Date("2027-01-15T10:00:00Z"));
    await expect(scheduledPark().getSchedules()).resolves.toEqual([]);
  });

  test("stays a no-op when no website origin is configured", async () => {
    const park = new Movieland();
    park.webBase = "";
    await expect(park.getSchedules()).resolves.toEqual([]);
  });

  test("refuses to publish hours when the legend parses empty", async () => {
    const park = scheduledPark();
    park.getCalendarLegend = (async () => ({})) as any;
    await expect(park.getSchedules()).rejects.toThrow(/legend/i);
  });
});

import { describe, test, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  isUniversalEventOperatingNow,
  parseUniversalEventCalendar,
  UniversalOrlando,
  UniversalStudios,
} from "../universal.js";
import { CacheLib } from "../../../cache.js";

/**
 * Halloween Horror Nights is absent from every feed parksapi already reads.
 * `venues/10010/hours` returns 65 days of 09:00-17:00 with `SpecialEntryUnix`,
 * `EarlyEntryUnix`, `VenueStatus`, `Holiday` and `IsShowScheduled` all unset,
 * including 31 October, and HHN is not one of the 14 venues. Without this the
 * API shows houses OPERATING until 02:00 while the park's published hours
 * ended at 17:00.
 *
 * The event calendar lives on the website instead, in the Tridion CMS payload
 * behind the `gds-event-day-calendar` component:
 *
 *   GET /contentdata/uor/en/us/hhn//about/index.html
 *
 * Served as text/html, JSON throughout, no auth and no browser fingerprint
 * needed. Fixture captured 2026-08-28, trimmed to the calendar presentation.
 */

const FIXTURE = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "fixtures", "hhnEventCalendar.json"),
    "utf8",
  ),
);

const nights = parseUniversalEventCalendar(FIXTURE);

describe("parseUniversalEventCalendar", () => {
  test("publishes every night the event actually runs", () => {
    // 49 regular nights + 2 Premium Scream Nights. The 16 "No Event Today"
    // dates are the nights it does NOT run and must not appear.
    expect(nights).toHaveLength(51);
  });

  test("excludes the block that lists the nights with no event", () => {
    expect(nights.map((n) => n.name)).not.toContain("No Event Today");
    // 31 August is a "No Event Today" date.
    expect(nights.find((n) => n.date === "2026-08-31")).toBeUndefined();
  });

  test("reads the event name when the CMS puts it in `heading`", () => {
    // Block 1: heading = name, eyebrow = hours.
    expect(nights.find((n) => n.date === "2026-08-27")).toMatchObject({
      name: "Halloween Horror Nights Premium Scream Night",
      openingTime: "18:30",
      closingTime: "02:00",
    });
  });

  test("reads the event name when the CMS puts it in `eyebrow` instead", () => {
    // Block 2 has them the other way round: heading = "6:30 PM - 2:00 AM".
    // Trusting position here would name every regular night after its hours.
    expect(nights.find((n) => n.date === "2026-08-28")).toMatchObject({
      name: "Halloween Horror Nights",
      openingTime: "18:30",
      closingTime: "02:00",
    });
  });

  test("finds Hollywood's bounded event window after its early-access block", () => {
    const hollywood = {
      ComponentPresentations: [{
        Component: {
          Schema: {RootElementName: "GDSCalendar"},
          Fields: {
            calendarData: {
              LinkedComponentValues: [{
                Fields: {
                  calendarConfig: {
                    EmbeddedValues: [{
                      eventDates: {DateTimeValues: ["2026-09-03T00:00:00"]},
                      blockData: {
                        LinkedComponentValues: [{
                          Fields: {
                            blocksData: {
                              LinkedComponentValues: [
                                {
                                  Fields: {
                                    heading: {Values: ["Halloween Horror Nights Early Access"]},
                                    eyebrow: {Values: ["5:30pm"]},
                                  },
                                },
                                {
                                  Fields: {
                                    heading: {Values: ["Halloween Horror Nights"]},
                                    eyebrow: {Values: ["7:00 PM - 1:00 AM"]},
                                  },
                                },
                              ],
                            },
                          },
                        }],
                      },
                    }],
                  },
                },
              }],
            },
          },
        },
      }],
    };

    expect(parseUniversalEventCalendar(hollywood)).toEqual([{
      date: "2026-09-03",
      name: "Halloween Horror Nights",
      openingTime: "19:00",
      closingTime: "01:00",
      closesNextDay: true,
    }]);
  });

  test("accepts both dash characters the same document uses", () => {
    // Block 1 uses an en dash, block 2 a hyphen.
    const premium = nights.filter((n) => n.name.includes("Premium"));
    const regular = nights.filter((n) => n.name === "Halloween Horror Nights");
    expect(premium).toHaveLength(2);
    expect(regular).toHaveLength(49);
  });

  test("marks a past-midnight close as landing on the next day", () => {
    expect(nights.every((n) => n.closesNextDay)).toBe(true);
  });

  test("reduces the authored timestamps to plain calendar dates", () => {
    // eventDates carry authoring noise: "2026-08-27T14:36:10",
    // "2026-08-28T13:19:17.126". Carrying that through would put an unusable
    // value in ScheduleEntry.date and break the schedule construction.
    expect(nights.every((n) => /^\d{4}-\d{2}-\d{2}$/.test(n.date))).toBe(true);
  });

  test("covers the published season end to end", () => {
    const dates = nights.map((n) => n.date);
    expect(dates[0]).toBe("2026-08-27");
    expect(dates.at(-1)).toBe("2026-11-01");
    expect(new Set(dates).size).toBe(dates.length);
  });

  test("returns entries in date order", () => {
    const dates = nights.map((n) => n.date);
    expect(dates).toEqual([...dates].sort());
  });

  test("survives a payload with no calendar rather than throwing", () => {
    expect(parseUniversalEventCalendar({ ComponentPresentations: [] })).toEqual([]);
    expect(parseUniversalEventCalendar({})).toEqual([]);
    expect(parseUniversalEventCalendar(null)).toEqual([]);
  });

  test("skips a block whose hours are unparseable rather than guessing", () => {
    const broken = JSON.parse(JSON.stringify(FIXTURE));
    const cfgs =
      broken.ComponentPresentations[0].Component.Fields.calendarData
        .LinkedComponentValues[0].Fields.calendarConfig.EmbeddedValues;
    for (const c of cfgs) {
      const f =
        c.blockData.LinkedComponentValues[0].Fields.blocksData
          .LinkedComponentValues[0].Fields;
      if (f.heading) f.heading.Values = ["Coming Soon"];
      if (f.eyebrow) f.eyebrow.Values = ["Halloween Horror Nights"];
    }
    expect(parseUniversalEventCalendar(broken)).toEqual([]);
  });
});

describe("isUniversalEventOperatingNow", () => {
  const hollywoodNight = [{
    date: "2026-09-03",
    name: "Halloween Horror Nights",
    openingTime: "19:00",
    closingTime: "01:00",
    closesNextDay: true,
  }];

  test("handles a ticketed event that closes after midnight", () => {
    expect(isUniversalEventOperatingNow(
      hollywoodNight,
      new Date("2026-09-04T06:58:00.000Z"),
      "America/Los_Angeles",
    )).toBe(true);
    expect(isUniversalEventOperatingNow(
      hollywoodNight,
      new Date("2026-09-04T08:01:00.000Z"),
      "America/Los_Angeles",
    )).toBe(false);
  });

  test("treats malformed event windows as unknown", () => {
    expect(isUniversalEventOperatingNow(
      [{...hollywoodNight[0], openingTime: "bad"}],
      new Date("2026-09-04T06:58:00.000Z"),
      "America/Los_Angeles",
    )).toBeNull();
  });
});

describe("UniversalOrlando.buildSchedules", () => {
  function park(): any {
    const p: any = new UniversalOrlando();
    p.eventCalendarURL = "https://example.invalid/calendar";
    p.eventCalendarPlaceId = "uor.usf";
    // Two day-park days, the second of which is also an HHN night.
    p.getVenueSchedule = async () => [
      {
        Date: "2026-08-28",
        VenueStatus: "",
        OpenTimeString: "2026-08-28T09:00:00-04:00",
        CloseTimeString: "2026-08-28T17:00:00-04:00",
      },
      {
        Date: "2026-08-31",
        VenueStatus: "",
        OpenTimeString: "2026-08-31T09:00:00-04:00",
        CloseTimeString: "2026-08-31T17:00:00-04:00",
      },
    ];
    p.getEventNights = async () => parseUniversalEventCalendar(FIXTURE);
    return p;
  }

  test("attaches the event nights to the park the event runs in", async () => {
    const schedules = await park().getSchedules();
    const usf = schedules.find((s: any) => s.id === "uor.usf");
    const ioa = schedules.find((s: any) => s.id === "uor.ioa");

    expect(usf.schedule.filter((e: any) => e.type === "TICKETED_EVENT")).toHaveLength(51);
    expect(ioa.schedule.some((e: any) => e.type === "TICKETED_EVENT")).toBe(false);
  });

  test("publishes the event alongside that day's park hours, not instead of them", async () => {
    const usf = (await park().getSchedules()).find((s: any) => s.id === "uor.usf");
    const aug28 = usf.schedule.filter((e: any) => e.date === "2026-08-28");

    expect(aug28.map((e: any) => e.type).sort()).toEqual(["OPERATING", "TICKETED_EVENT"]);
    const event = aug28.find((e: any) => e.type === "TICKETED_EVENT");
    expect(event.openingTime).toBe("2026-08-28T18:30:00-04:00");
    expect(event.closingTime).toBe("2026-08-29T02:00:00-04:00");
    expect(event.description).toBe("Halloween Horror Nights");
  });

  test("leaves a day-park day with no event untouched", async () => {
    // 31 August is a "No Event Today" date.
    const usf = (await park().getSchedules()).find((s: any) => s.id === "uor.usf");
    const aug31 = usf.schedule.filter((e: any) => e.date === "2026-08-31");
    expect(aug31.map((e: any) => e.type)).toEqual(["OPERATING"]);
  });

  test("skips malformed or inverted venue windows without taking schedules down", async () => {
    const p = park();
    p.getEventNights = async () => [];
    p.getVenueSchedule = async () => [
      {Date: "2026-08-28", OpenTimeString: "not-a-date", CloseTimeString: "2026-08-28T17:00:00-04:00"},
      {Date: "2026-08-29", OpenTimeString: "2026-08-29T17:00:00-04:00", CloseTimeString: "2026-08-29T09:00:00-04:00"},
      {
        Date: "2026-08-30",
        OpenTimeString: "2026-08-30T09:00:00-04:00",
        CloseTimeString: "2026-08-30T17:00:00-04:00",
        EarlyEntryString: "not-a-date",
      },
    ];

    const usf = (await p.getSchedules()).find((s: any) => s.id === "uor.usf");
    expect(usf.schedule).toEqual([expect.objectContaining({
      date: "2026-08-30",
      type: "OPERATING",
      openingTime: "2026-08-30T09:00:00-04:00",
      closingTime: "2026-08-30T17:00:00-04:00",
    })]);
  });

  test("still publishes park hours when the event calendar fails", async () => {
    // A website change must not take the day-park schedule down with it.
    const p = park();
    p.getEventNights = async () => { throw new Error("503"); };
    const usf = (await p.getSchedules()).find((s: any) => s.id === "uor.usf");
    expect(usf.schedule.filter((e: any) => e.type === "OPERATING")).toHaveLength(2);
    expect(usf.schedule.some((e: any) => e.type === "TICKETED_EVENT")).toBe(false);
  });

  test("emits nothing extra when no event calendar is configured", async () => {
    const p = park();
    p.eventCalendarPlaceId = "";
    const usf = (await p.getSchedules()).find((s: any) => s.id === "uor.usf");
    expect(usf.schedule.every((e: any) => e.type === "OPERATING")).toBe(true);
  });
});

describe("event calendar fetch discipline", () => {
  // getEventNights is @cache'd on class + method, so entries are shared across
  // instances and across configs. Each case starts from a clean slate.
  beforeEach(async () => {
    await CacheLib.clearByClassName("UniversalOrlando");
    await CacheLib.clearByClassName("UniversalStudios");
  });

  const CONFIG = {
    eventCalendarURL: "https://example.invalid/calendar",
    eventCalendarPlaceId: "uor.usf",
  };

  test("Hollywood defaults to its own official calendar and host park", () => {
    const hollywood: any = new UniversalStudios();
    expect(hollywood.eventCalendarURL).toBe(
      "https://www.universalstudioshollywood.com/contentdata/ush/en/us/hhn//about/index.html",
    );
    expect(hollywood.eventCalendarPlaceId).toBe("ush.ush");
  });

  test("Hollywood refuses an explicitly mismatched Orlando calendar", async () => {
    // Both resorts retain the legacy UNIVERSALSTUDIOS config namespace.
    // Even an explicit bad override must not fetch a calendar belonging to a
    // park outside this resort.
    const hollywood: any = new UniversalStudios({ config: CONFIG } as any);
    let fetched = 0;
    hollywood.fetchEventCalendar = async () => { fetched++; throw new Error("should not fetch"); };

    await expect(hollywood.getEventNights()).resolves.toEqual([]);
    expect(fetched).toBe(0);
  });

  test("Orlando does fetch it", async () => {
    const orlando: any = new UniversalOrlando({ config: CONFIG } as any);
    let fetched = 0;
    orlando.fetchEventCalendar = async () => {
      fetched++;
      return { text: async () => JSON.stringify(FIXTURE) };
    };

    await expect(orlando.getEventNights()).resolves.toHaveLength(51);
    expect(fetched).toBe(1);
  });

  test("a blocked fetch keeps failing rather than sticking as empty", async () => {
    // One box's IP is blocked by the site's WAF (2026-08-28). A failure that
    // cached as [] would mean twelve silent hours of "no events"; it has to
    // stay loud so the next poll retries and the warning keeps appearing.
    const orlando: any = new UniversalOrlando({ config: CONFIG } as any);
    orlando.fetchEventCalendar = async () => { throw new Error("HTTP 403"); };

    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(orlando.getEventNights()).rejects.toThrow(/403/);
    }
  });

  test("a blocked fetch is reported, not swallowed", async () => {
    const orlando: any = new UniversalOrlando({ config: CONFIG } as any);
    orlando.getVenueSchedule = async () => [];
    orlando.getEventNights = async () => { throw new Error("HTTP 403"); };
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
    try {
      await orlando.getSchedules();
    } finally {
      console.warn = original;
    }
    expect(warnings.join("\n")).toMatch(/event calendar unavailable/i);
  });
});

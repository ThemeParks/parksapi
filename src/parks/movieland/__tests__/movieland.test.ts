import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import {
  Movieland,
  movielandEntityId,
  movielandShowtimes,
} from "../movieland.js";
import { CacheLib } from "../../../cache.js";
import type { HTTPObj } from "../../../http.js";

/**
 * `shows.it.json` and `points_movieland.json` are two independent Helpy feeds
 * joined on id, and the join has three wrinkles worth pinning down:
 *
 *  1. A show row does not always carry the id of the point it belongs to.
 *     `mv_show_voicesmagic` (a show row) belongs to `mv_show_voicemagic` (a
 *     point), and only `infoPointId` links them.
 *  2. Two show rows can target the same point. "Once upon a time in Bugs Town"
 *     publishes `mv_show_bugstownshow` at 11:00 and `mv_show_bugstowshow2` at
 *     19:00, both pointing at `mv_show_bugstownshow`. Both are performances of
 *     the same show, so both belong in the same entity.
 *  3. Point ids are not entity-id safe. `mv_show_meet&greet1` has to become
 *     `mv_show_meet_greet1` to publish, so the lookup set and the id being
 *     looked up have to agree on which form they are in. That agreement spans
 *     `buildLiveData` and `movielandShowtimes`, so case 3 is asserted through
 *     the destination rather than against the helper alone.
 *
 * Fixtures are trimmed from the live feeds on 2026-08-26.
 */

const DATE = "2026-08-26";
const TZ = "Europe/Rome";

const showRow = (
  id: string,
  infoPointId: string | undefined,
  schedule: Record<string, string[]>,
) => ({ id, infoPointId, parco: "movieland", schedule });

const showPoint = (id: string, nome: string) => ({
  id,
  nome,
  categoria: "show",
  lat: "45.47623",
  lng: "10.7262",
});

/** Mirrors the lookup set `buildLiveData` hands to the helper. */
const pointSet = (...pointIds: string[]) =>
  new Set(pointIds.map(movielandEntityId));

function stubbedPark(points: any[], shows: any[]): Movieland {
  const park = new Movieland();
  const asJson = (body: any) =>
    (async () => ({ json: async () => body }) as any as HTTPObj) as any;
  park.fetchPoints = asJson(points);
  park.fetchShows = asJson(shows);
  return park;
}

describe("movielandEntityId", () => {
  test("strips diacritics rather than replacing them", () => {
    expect(movielandEntityId("mv_casinò")).toBe("mv_casino");
  });

  test("replaces characters the entity id charset rejects", () => {
    expect(movielandEntityId("mv_show_meet&greet1")).toBe(
      "mv_show_meet_greet1",
    );
  });

  test("leaves an already-safe id untouched", () => {
    expect(movielandEntityId("mv_show_medusa")).toBe("mv_show_medusa");
  });
});

describe("movielandShowtimes", () => {
  test("matches a show row on its own id", () => {
    const live = movielandShowtimes(
      [showRow("mv_show_medusa", "mv_show_medusa", { [DATE]: ["14:30"] })],
      pointSet("mv_show_medusa"),
      DATE,
      TZ,
    );

    expect(live).toHaveLength(1);
    expect(live[0].id).toBe("mv_show_medusa");
    expect(live[0].status).toBe("OPERATING");
    expect(live[0].showtimes).toEqual([
      { type: "Performance", startTime: "2026-08-26T14:30:00+02:00" },
    ]);
  });

  test("falls back to infoPointId when the row id is not itself a point", () => {
    // Live pairing: row `mv_show_voicesmagic` -> point `mv_show_voicemagic`.
    const live = movielandShowtimes(
      [
        showRow("mv_show_voicesmagic", "mv_show_voicemagic", {
          [DATE]: ["20:00"],
        }),
      ],
      pointSet("mv_show_voicemagic"),
      DATE,
      TZ,
    );

    expect(live).toHaveLength(1);
    expect(live[0].id).toBe("mv_show_voicemagic");
  });

  test("keeps every performance when two rows target the same point", () => {
    const live = movielandShowtimes(
      [
        showRow("mv_show_bugstownshow", "mv_show_bugstownshow", {
          [DATE]: ["11:00"],
        }),
        showRow("mv_show_bugstowshow2", "mv_show_bugstownshow", {
          [DATE]: ["19:00"],
        }),
      ],
      pointSet("mv_show_bugstownshow"),
      DATE,
      TZ,
    );

    expect(live).toHaveLength(1);
    expect(live[0].id).toBe("mv_show_bugstownshow");
    expect(live[0].showtimes?.map((s) => s.startTime)).toEqual([
      "2026-08-26T11:00:00+02:00",
      "2026-08-26T19:00:00+02:00",
    ]);
  });

  test("drops rows belonging to the neighbouring waterpark", () => {
    // `shows.it.json` carries CanevaWorld Aquapark rows; none of their ids
    // resolve to a Movieland point.
    const live = movielandShowtimes(
      [showRow("cw_show_characters", undefined, { [DATE]: ["12:00"] })],
      pointSet("mv_show_medusa"),
      DATE,
      TZ,
    );

    expect(live).toEqual([]);
  });

  test("emits nothing for a show with no performances on the requested date", () => {
    const live = movielandShowtimes(
      [
        showRow("mv_show_medusa", "mv_show_medusa", {
          "2026-08-27": ["14:30"],
        }),
      ],
      pointSet("mv_show_medusa"),
      DATE,
      TZ,
    );

    expect(live).toEqual([]);
  });

  test("ignores malformed time strings", () => {
    const live = movielandShowtimes(
      [
        showRow("mv_show_medusa", "mv_show_medusa", {
          [DATE]: ["14:30", "", "25:00", "TBA"],
        }),
      ],
      pointSet("mv_show_medusa"),
      DATE,
      TZ,
    );

    expect(live[0].showtimes).toHaveLength(1);
  });
});

describe("Movieland.buildLiveData", () => {
  beforeEach(() => {
    CacheLib.clear();
    vi.useFakeTimers();
    // 14:00 in Rome on the fixture date.
    vi.setSystemTime(new Date("2026-08-26T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    CacheLib.clear();
  });

  test("publishes a show whose point id needs normalising", async () => {
    const park = stubbedPark(
      [showPoint("mv_show_meet&greet1", "Movy Meet & Greet")],
      [
        showRow("mv_show_meetgreet", "mv_show_meet&greet1", {
          [DATE]: ["11:00", "15:00"],
        }),
      ],
    );

    const live = await park.getLiveData();

    expect(live).toHaveLength(1);
    expect(live[0].id).toBe("mv_show_meet_greet1");
    expect(live[0].showtimes).toHaveLength(2);
  });

  test("live data ids match the entity ids the same feed produces", async () => {
    const points = [
      showPoint("mv_show_meet&greet1", "Movy Meet & Greet"),
      showPoint("mv_show_medusa", "Medusa Epic Show"),
    ];
    const park = stubbedPark(points, [
      showRow("mv_show_meetgreet", "mv_show_meet&greet1", {
        [DATE]: ["11:00"],
      }),
      showRow("mv_show_medusa", "mv_show_medusa", { [DATE]: ["14:30"] }),
    ]);

    const entityIds = new Set((await park.getEntities()).map((e) => e.id));
    const live = await park.getLiveData();

    expect(live).toHaveLength(2);
    for (const entry of live) {
      expect(entityIds).toContain(entry.id);
    }
  });

  test("returns no live data rather than throwing when the shows feed fails", async () => {
    const park = stubbedPark(
      [showPoint("mv_show_medusa", "Medusa Epic Show")],
      [],
    );
    park.fetchShows = (async () => {
      throw new Error("503");
    }) as any;

    await expect(park.getLiveData()).resolves.toEqual([]);
  });
});

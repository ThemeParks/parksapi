import { describe, test, expect } from "vitest";
import { reconcileLiveRows, type ServedRow } from "../staleLiveRows.js";

/**
 * The retirement gate only tracks ids it has seen live, so anything already
 * frozen when it first ran can never be retired by it. This comparison is the
 * read-only half of the reconciliation that closes that hole.
 *
 * Everything here is about not over-reporting: a wrong entry in this list
 * becomes a closed row later, so the bias is toward saying nothing when the
 * evidence is thin.
 */

const NOW = new Date("2026-08-29T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

const row = (over: Partial<ServedRow> = {}): ServedRow => ({
  id: "guid-1",
  externalId: "park.ride.one",
  name: "Ride One",
  entityType: "ATTRACTION",
  status: "OPERATING",
  lastUpdated: hoursAgo(100),
  ...over,
});

describe("reconcileLiveRows", () => {
  test("reports a row the build no longer produces", () => {
    const r = reconcileLiveRows(["park.ride.two"], [row()], NOW);
    expect(r.stale).toHaveLength(1);
    expect(r.stale[0]).toMatchObject({ externalId: "park.ride.one", ageHours: 100 });
  });

  test("says nothing about a row the build still produces", () => {
    expect(reconcileLiveRows(["park.ride.one"], [row()], NOW).stale).toEqual([]);
  });

  test("ignores rows the API already serves as closed", () => {
    // Only OPERATING and DOWN assert the entity is active; a CLOSED row is
    // already correct and reporting it would re-close it forever.
    for (const status of ["CLOSED", "REFURBISHMENT", "OPERATING"]) {
      const r = reconcileLiveRows([], [row({ status })], NOW);
      expect(r.stale.length, status).toBe(status === "OPERATING" ? 1 : 0);
    }
  });

  test("treats DOWN as an active claim too", () => {
    // A ride stuck DOWN forever is as wrong as one stuck OPERATING.
    expect(reconcileLiveRows([], [row({ status: "DOWN" })], NOW).stale).toHaveLength(1);
  });

  test("ignores a row that is merely mid-cycle", () => {
    expect(reconcileLiveRows([], [row({ lastUpdated: hoursAgo(3) })], NOW).stale).toEqual([]);
  });

  test("excludes PARK entities by default", () => {
    // Whether a park should carry live data at all is an open question
    // an open question; it must not be answered by accident here.
    expect(reconcileLiveRows([], [row({ entityType: "PARK" })], NOW).stale).toEqual([]);
  });

  test("skips a row with no externalId rather than guessing", () => {
    // Nothing to match against the build, so the row cannot be judged.
    expect(reconcileLiveRows([], [row({ externalId: undefined })], NOW).stale).toEqual([]);
  });

  test("skips a row with an unparseable timestamp", () => {
    expect(reconcileLiveRows([], [row({ lastUpdated: "not a date" })], NOW).stale).toEqual([]);
    expect(reconcileLiveRows([], [row({ lastUpdated: undefined })], NOW).stale).toEqual([]);
  });

  test("orders oldest first", () => {
    const rows = [
      row({ id: "a", externalId: "a", lastUpdated: hoursAgo(60) }),
      row({ id: "b", externalId: "b", lastUpdated: hoursAgo(900) }),
      row({ id: "c", externalId: "c", lastUpdated: hoursAgo(300) }),
    ];
    expect(reconcileLiveRows([], rows, NOW).stale.map((s) => s.externalId)).toEqual(["b", "c", "a"]);
  });

  describe("degraded-feed guard", () => {
    test("flags a build that produced nothing at all", () => {
      const r = reconcileLiveRows([], [row()], NOW);
      expect(r.degraded).toMatch(/no live data/);
    });

    test("flags a build that produced a fraction of what is served", () => {
      // 10 rows served, 2 produced: a broken poll, not a park that retired 8
      // attractions overnight.
      const served = Array.from({ length: 10 }, (_, i) =>
        row({ id: `g${i}`, externalId: `e${i}` }));
      const r = reconcileLiveRows(["e0", "e1"], served, NOW);
      expect(r.degraded).toMatch(/degraded/);
      expect(r.stale).toHaveLength(8); // still reported, but marked untrustworthy
    });

    test("stays quiet when the build looks healthy", () => {
      const served = Array.from({ length: 10 }, (_, i) =>
        row({ id: `g${i}`, externalId: `e${i}` }));
      const r = reconcileLiveRows(
        Array.from({ length: 9 }, (_, i) => `e${i}`), served, NOW);
      expect(r.degraded).toBeUndefined();
      expect(r.stale).toHaveLength(1);
    });

    test("does not flag a genuinely small park", () => {
      // Four served rows, one produced. Too few to distinguish a broken feed
      // from a small park, so the guard stays out of it.
      const served = Array.from({ length: 4 }, (_, i) =>
        row({ id: `g${i}`, externalId: `e${i}` }));
      expect(reconcileLiveRows(["e0"], served, NOW).degraded).toBeUndefined();
    });
  });
});

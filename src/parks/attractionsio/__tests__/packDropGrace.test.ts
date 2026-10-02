/**
 * The pack-drop grace window.
 *
 * Chessington's asset pack version 2026-10-01T16:44:01Z dropped 23 rides
 * (Dragon's Fury, Rattlesnake, Tiger Rock, the PAW Patrol rides, ...) while the
 * live feed kept scheduling them for the next day. Items that leave the pack
 * stay published while BOTH hold: the last pack that contained them is within
 * PACK_DROP_GRACE_DAYS, and the live feed either carries them with
 * OpeningTimes covering today (park-local) or reports them IsOperational.
 *
 * Fixtures are real data, trimmed: the 2026-10-01 pack, the records the pack
 * dropped (as last published), and the live feed fetched that night. The store
 * is driven through the module's own _diffAndUpsert, so removed_at is stamped
 * exactly as a real sync stamps it.
 */

import {describe, test, expect, beforeEach, afterEach, vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {
  ChessingtonWorldOfAdventures,
  ThorpePark,
  PACK_DROP_GRACE_DAYS,
  isScheduledOnDate,
} from '../attractionsiov1.js';
import {database} from '../../../cache.js';

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

const CHESSINGTON = fixture('chessington-2026-10-01.json');
const VORTEX_LIVE = fixture('thorpe-vortex-live-2026-10-01.json').record;

const DAY = 24 * 60 * 60 * 1000;

// The previous pack, the last that held the rides, and the sync that first saw
// the new pack.
const LAST_PACK = '2026-09-30T13:05:07Z';
const DROPPED_AT = new Date('2026-10-01T20:55:08Z');
// 10:30 BST on the day the live feed schedules (2026-10-02).
const NEXT_MORNING = new Date('2026-10-02T09:30:00Z');

// The 23 rides the pack dropped (plus show 52674, which the feed does not schedule).
const DROPPED_RIDES = [
  3931, 3932, 3933, 3934, 3935, 3936, 3937, 3942, 3948, 3953, 3954, 3959, 3961,
  3972, 7439, 7441, 16752, 16753, 49126, 49127, 49128, 49129, 49132,
].map(String);

const liveRecord = (id: string) =>
  CHESSINGTON.live.entities.Item.records.find((r: any) => String(r._id) === id);

// Dropped rides the feed carries with OpeningTimes for 2026-10-02.
const SCHEDULED_RIDES = DROPPED_RIDES.filter(id =>
  isScheduledOnDate(liveRecord(id)?.OpeningTimes, 'Europe/London', '2026-10-02'));

// Dropped rides the feed runs or schedules: the 20 above plus AMAZU (3972),
// which carries OpeningTimes null and IsOperational true.
const KEPT_RIDES = DROPPED_RIDES.filter(id =>
  SCHEDULED_RIDES.includes(id) || liveRecord(id)?.IsOperational === true);

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

function clearStore() {
  database.exec('DELETE FROM attractionsio_entities');
  database.exec('DELETE FROM attractionsio_versions');
}

/** Run a sync of `pack` at time `at`, through the module's own store diff. */
function syncAt(park: any, pack: any, version: string, at: Date) {
  vi.setSystemTime(at);
  park._diffAndUpsert(pack, version);
}

function previousPack() {
  const pack = CHESSINGTON.pack;
  return {...pack, Item: [...pack.Item, ...CHESSINGTON.droppedItems]};
}

function chessington(live: any = CHESSINGTON.live): any {
  const park: any = new ChessingtonWorldOfAdventures();
  park.getPOIData = async () => park._readEntitiesFromDB();
  park.fetchLiveData = async () => ({json: async () => live});
  return park;
}

/**
 * Store as a real sync leaves it: the previous pack (version `lastPack`), then
 * the 2026-10-01 pack, first seen at `droppedAt`.
 */
function chessingtonAfterDrop(
  {lastPack = LAST_PACK, droppedAt = DROPPED_AT, live}: {lastPack?: string; droppedAt?: Date; live?: any} = {},
): any {
  const park = chessington(live);
  syncAt(park, previousPack(), lastPack, new Date(Date.parse(lastPack) + 60_000));
  syncAt(park, CHESSINGTON.pack, CHESSINGTON.packVersion, droppedAt);
  return park;
}

const ids = (entities: any[]) => new Set(entities.map(e => e.id));

beforeEach(() => {
  clearStore();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  clearStore();
});

describe('isScheduledOnDate', () => {
  const tz = 'Europe/London';
  const range = (start: string, end: string) => JSON.stringify({type: 'range', start, end});

  test('a range on the date schedules it', () => {
    expect(isScheduledOnDate(range('2026-10-02 10:00:00', '2026-10-02 16:00:00'), tz, '2026-10-02')).toBe(true);
  });

  test('a range on another date does not', () => {
    expect(isScheduledOnDate(range('2026-10-01 10:00:00', '2026-10-01 16:00:00'), tz, '2026-10-02')).toBe(false);
    expect(isScheduledOnDate(range('2026-10-03 10:00:00', '2026-10-03 16:00:00'), tz, '2026-10-02')).toBe(false);
  });

  test('a range spanning the date schedules it', () => {
    expect(isScheduledOnDate(range('2026-10-01 18:00:00', '2026-10-03 02:00:00'), tz, '2026-10-02')).toBe(true);
  });

  test('null, blank and malformed values do not', () => {
    expect(isScheduledOnDate(null, tz, '2026-10-02')).toBe(false);
    expect(isScheduledOnDate(undefined, tz, '2026-10-02')).toBe(false);
    expect(isScheduledOnDate('', tz, '2026-10-02')).toBe(false);
    expect(isScheduledOnDate('{not json', tz, '2026-10-02')).toBe(false);
  });
});

describe('pack-drop grace window: Chessington 2026-10-01', () => {
  test('the fixture is the real drop: 23 rides gone from the pack, still in the feed', () => {
    const packIds = new Set(CHESSINGTON.pack.Item.map((i: any) => String(i._id)));
    for (const id of DROPPED_RIDES) expect(packIds.has(id)).toBe(false);
    // All but three carry a window for 2026-10-02; those three carry none.
    expect(SCHEDULED_RIDES).toHaveLength(20);
    expect(DROPPED_RIDES.filter(id => !SCHEDULED_RIDES.includes(id)).sort()).toEqual(['3959', '3972', '49132']);
    // Of those three, the feed reports only AMAZU running.
    // (The trimmed fixture omits null fields, so a null OpeningTimes is absent.)
    expect(liveRecord('3972')?.OpeningTimes ?? null).toBeNull();
    expect(liveRecord('3972')?.IsOperational).toBe(true);
    expect(liveRecord('3959')?.OpeningTimes ?? null).toBeNull();
    expect(liveRecord('3959')?.IsOperational).toBe(false);
    expect(liveRecord('49132')?.OpeningTimes ?? null).toBeNull();
    expect(liveRecord('49132')?.IsOperational).toBe(false);
    expect(KEPT_RIDES).toHaveLength(21);
  });

  test('without the window the pack alone publishes none of them', async () => {
    const park = chessington();
    syncAt(park, CHESSINGTON.pack, CHESSINGTON.packVersion, DROPPED_AT);
    vi.setSystemTime(NEXT_MORNING);
    const published = ids(await park.getEntities());
    for (const id of DROPPED_RIDES) expect(published.has(id)).toBe(false);
  });

  test("Dragon's Fury and the other scheduled or running rides stay published, with their last-known details", async () => {
    const park = chessingtonAfterDrop();
    vi.setSystemTime(NEXT_MORNING);
    const entities = await park.getEntities();
    const byId = new Map<string, any>(entities.map((e: any) => [e.id, e]));

    for (const id of KEPT_RIDES) {
      expect(byId.get(id)?.entityType, id).toBe('ATTRACTION');
      expect(byId.get(id)?.parentId, id).toBe('chessingtonworldofadventures');
    }
    expect(byId.get('3933')).toMatchObject({name: "Dragon's Fury", entityType: 'ATTRACTION'});
    expect(byId.get('49126')).toMatchObject({name: "Chase's Mountain Mission", entityType: 'ATTRACTION'});

    expect(byId.get('3972')).toMatchObject({name: 'AMAZU: Treetop Adventure', entityType: 'ATTRACTION'});

    // Dropped rides the feed neither schedules today nor runs are not kept.
    for (const id of ['3959', '49132']) expect(byId.has(id), id).toBe(false);
    // Nor is the dropped show, which has no live record scheduling it.
    expect(byId.has('52674')).toBe(false);

    // Everything the current pack publishes is still there, once each.
    const all = entities.map((e: any) => e.id);
    expect(new Set(all).size).toBe(all.length);
    for (const id of ['3929', '10496', '3938', '10846', '44112']) expect(byId.has(id), id).toBe(true);
  });

  test('kept rides get live data from the feed', async () => {
    const park = chessingtonAfterDrop();
    vi.setSystemTime(NEXT_MORNING);
    const live = await park.getLiveData();
    const byId = new Map<string, any>(live.map((l: any) => [l.id, l]));
    // The ride branch is unchanged: an explicit IsOpen decides, else
    // IsOperational. AMAZU's record (IsOperational true, IsOpen false) reads
    // CLOSED, as it would for a ride still in the pack.
    for (const id of KEPT_RIDES) {
      const rec = liveRecord(id);
      const open = typeof rec.IsOpen === 'boolean' ? rec.IsOpen : !!rec.IsOperational;
      expect(byId.get(id)?.status, id).toBe(open ? 'OPERATING' : 'CLOSED');
    }
    expect(byId.has('3972')).toBe(true);
  });

  test(`an item whose last pack is more than ${PACK_DROP_GRACE_DAYS} days old is not published`, async () => {
    const park = chessingtonAfterDrop({lastPack: iso(NEXT_MORNING.getTime() - (PACK_DROP_GRACE_DAYS * DAY + 60_000))});
    vi.setSystemTime(NEXT_MORNING);
    const published = ids(await park.getEntities());
    for (const id of DROPPED_RIDES) expect(published.has(id), id).toBe(false);
  });

  test('an item whose last pack is just inside the window is still published', async () => {
    const park = chessingtonAfterDrop({lastPack: iso(NEXT_MORNING.getTime() - (PACK_DROP_GRACE_DAYS * DAY - 60 * 60_000))});
    vi.setSystemTime(NEXT_MORNING);
    const published = ids(await park.getEntities());
    expect(published.has('3933')).toBe(true);
  });

  test('a store that has not synced since September does not revive items that left the pack in September', async () => {
    // Last synced against the 2026-09-10 pack; the next sync it runs, today,
    // stamps removed_at now. The pack is what dates the removal, not the stamp.
    const park = chessingtonAfterDrop({lastPack: '2026-09-10T09:53:22Z', droppedAt: new Date(NEXT_MORNING.getTime() - 60_000)});
    vi.setSystemTime(NEXT_MORNING);
    const published = ids(await park.getEntities());
    for (const id of DROPPED_RIDES) expect(published.has(id), id).toBe(false);
  });

  test('an item whose last pack version is not a timestamp is not published', async () => {
    const park = chessingtonAfterDrop();
    database.exec(
      "UPDATE attractionsio_entities SET last_version = 'not-a-date' " +
      "WHERE park_id = 'chessingtonworldofadventuresresort' AND removed_at IS NOT NULL",
    );
    vi.setSystemTime(NEXT_MORNING);
    const published = ids(await park.getEntities());
    for (const id of DROPPED_RIDES) expect(published.has(id), id).toBe(false);
  });

  test('an item the feed neither schedules today nor runs is not published', async () => {
    const live = structuredClone(CHESSINGTON.live);
    for (const r of live.entities.Item.records) r.IsOperational = false;
    const park = chessingtonAfterDrop({live});
    // The day after the feed's window: 2026-10-03 park-local.
    vi.setSystemTime(new Date('2026-10-03T09:30:00Z'));
    const published = ids(await park.getEntities());
    for (const id of DROPPED_RIDES) expect(published.has(id), id).toBe(false);
  });

  test('a running item is kept on a day the feed does not schedule it', async () => {
    const park = chessingtonAfterDrop();
    vi.setSystemTime(new Date('2026-10-03T09:30:00Z'));
    const published = ids(await park.getEntities());
    expect(published.has('3972')).toBe(true); // IsOperational true
    expect(published.has('3933')).toBe(false); // window was 2026-10-02 only
  });

  test('Treetop Hoppers and Rubble & Rocky\'s Play Zone are kept only once the feed reports them running', async () => {
    const asIs = chessingtonAfterDrop();
    vi.setSystemTime(NEXT_MORNING);
    const before = ids(await asIs.getEntities());
    expect(before.has('3959')).toBe(false);
    expect(before.has('49132')).toBe(false);

    clearStore();
    const live = structuredClone(CHESSINGTON.live);
    for (const r of live.entities.Item.records) {
      if (r._id === 3959 || r._id === 49132) r.IsOperational = true;
    }
    const running = chessingtonAfterDrop({live});
    vi.setSystemTime(NEXT_MORNING);
    const after = ids(await running.getEntities());
    expect(after.has('3959')).toBe(true);
    expect(after.has('49132')).toBe(true);
  });

  test('an item missing from the feed is not published', async () => {
    const live = structuredClone(CHESSINGTON.live);
    live.entities.Item.records = live.entities.Item.records.filter((r: any) => r._id !== 3933);
    const park = chessingtonAfterDrop({live});
    vi.setSystemTime(NEXT_MORNING);
    const published = ids(await park.getEntities());
    expect(published.has('3933')).toBe(false);
    expect(published.has('3948')).toBe(true);
  });

  test('an item that returns to the pack is published from the pack, once', async () => {
    const park = chessingtonAfterDrop();
    syncAt(park, previousPack(), '2026-10-02T08:00:00Z', NEXT_MORNING);
    const entities = await park.getEntities();
    expect(entities.filter((e: any) => e.id === '3933')).toHaveLength(1);
    expect(ids(entities).has('3959')).toBe(true); // back in the pack, schedule irrelevant
  });
});

describe('pack-drop grace window: long-retired items stay dead', () => {
  function thorpe(): any {
    const park: any = new ThorpePark();
    const pack = {
      Resort: [{_id: 1, Name: 'Thorpe Park Resort'}],
      Category: [{_id: 10, Name: 'Rides'}],
      Item: [{_id: 3880, Name: 'Stealth', Category: 10}],
    };
    park.getPOIData = async () => park._readEntitiesFromDB();
    park.fetchLiveData = async () => ({json: async () => ({entities: {Item: {records: [VORTEX_LIVE]}}})});
    return {park, pack};
  }

  test("the feed still schedules Thorpe's Vortex (3881) today", () => {
    expect(isScheduledOnDate(VORTEX_LIVE.OpeningTimes, 'Europe/London', '2026-10-02')).toBe(true);
  });

  test('Vortex is not revived when the store never held it', async () => {
    const {park, pack} = thorpe();
    syncAt(park, pack, 'v1', DROPPED_AT);
    vi.setSystemTime(NEXT_MORNING);
    expect(ids(await park.getEntities()).has('3881')).toBe(false);
  });

  test('Vortex is not revived when it left the pack long ago', async () => {
    const {park, pack} = thorpe();
    const withVortex = {...pack, Item: [...pack.Item, {_id: 3881, Name: 'Vortex', Category: 10}]};
    syncAt(park, withVortex, '2025-01-10T12:00:00Z', new Date('2025-01-10T12:01:00Z'));
    syncAt(park, pack, '2025-02-01T12:00:00Z', new Date('2025-02-01T12:01:00Z'));
    syncAt(park, pack, '2026-10-01T16:00:00Z', DROPPED_AT); // later syncs do not move removed_at
    vi.setSystemTime(NEXT_MORNING);
    const published = ids(await park.getEntities());
    expect(published.has('3881')).toBe(false);
    expect(published.has('3880')).toBe(true);
  });

  test('Vortex is not revived by a store that only noticed today, even if the feed says it is running', async () => {
    const {park, pack} = thorpe();
    const withVortex = {...pack, Item: [...pack.Item, {_id: 3881, Name: 'Vortex', Category: 10}]};
    syncAt(park, withVortex, '2025-01-10T12:00:00Z', new Date('2025-01-10T12:01:00Z'));
    syncAt(park, pack, '2026-10-01T16:00:00Z', new Date(NEXT_MORNING.getTime() - 60_000));
    park.fetchLiveData = async () =>
      ({json: async () => ({entities: {Item: {records: [{...VORTEX_LIVE, IsOperational: true}]}}})});
    vi.setSystemTime(NEXT_MORNING);
    expect(ids(await park.getEntities()).has('3881')).toBe(false);
  });
});

describe('pack-drop grace window: normal churn is unchanged', () => {
  test('with nothing recently dropped, entities are exactly the pack and the feed is not read for it', async () => {
    const park = chessington();
    syncAt(park, CHESSINGTON.pack, CHESSINGTON.packVersion, DROPPED_AT);
    vi.setSystemTime(NEXT_MORNING);
    let liveReads = 0;
    park.fetchLiveData = async () => {
      liveReads++;
      return {json: async () => CHESSINGTON.live};
    };
    expect(await park.getPackDropGraceItems()).toEqual([]);
    expect(liveReads).toBe(0);
  });

  test('a recently dropped item the feed neither schedules nor runs drops out as before', async () => {
    const park = chessingtonAfterDrop();
    vi.setSystemTime(NEXT_MORNING);
    const grace = (await park.getPackDropGraceItems()).map((i: any) => String(i._id)).sort();
    expect(grace).toEqual([...KEPT_RIDES].sort());
    expect(grace).not.toContain('52674'); // the dropped show
  });
});

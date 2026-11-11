import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {ParcAsterix, type POIEntry} from '../parcasterix.js';
import {CacheLib} from '../../../cache.js';

/**
 * The play areas report `isOpen: true` with `latency: null` on every poll,
 * open day or not. On 2026-11-11, an attested closed day in the off-season,
 * they were the only four of 36 attractions saying open, and the wiki had
 * served them as OPERATING since April.
 *
 * Once the calendar says nothing is in session, an open flag with no measured
 * wait is published CLOSED. A ride with a measured wait is left alone: rides
 * do run on closed days for private events.
 */
const here = dirname(fileURLToPath(import.meta.url));
const capture = JSON.parse(
  readFileSync(join(here, 'fixtures/polling-2026-11-11-closed-day.json'), 'utf8'),
);

const PLAY_AREAS = ['31365', '31366', '31373', '31376'];

const attraction = (drupalId: number): POIEntry => ({
  drupal_id: drupalId,
  title: `Attraction ${drupalId}`,
  titles: {en: `Attraction ${drupalId}`},
  latitude: 49.13675,
  longitude: 2.573816,
  _type: 'attraction',
});

const latency = (drupalId: string, isOpen: boolean, latencyValue: number | null) => ({
  drupalId,
  latency: latencyValue,
  isOpen,
  message: null,
  openingTime: null,
  closingTime: '18:00:00',
});

const openDay = (date: string) => ({
  date,
  type: 'OPERATING',
  openingTime: `${date}T10:00:00+01:00`,
  closingTime: `${date}T18:00:00+01:00`,
});

/** 2026-11-11 15:55Z: the time of the capture, 16:55 in Paris. */
const CAPTURED_AT = new Date('2026-11-11T15:55:00Z');

function stubbedPark(
  latencies: unknown[],
  schedules: unknown[],
  calendar: unknown[],
  closedDates: string[],
): ParcAsterix {
  const park = new ParcAsterix();
  const poi = (latencies as {drupalId: string}[]).map((l) => attraction(Number(l.drupalId)));
  vi.spyOn(park as any, 'getPolling').mockResolvedValue({latencies, schedules});
  vi.spyOn(park as any, 'getPOIData').mockResolvedValue({poi, calendar, closedDates});
  return park;
}

const byId = (live: {id: string}[]) => new Map(live.map((l) => [l.id, l]));

describe('Parc Asterix play areas outside a session', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    CacheLib.clearByClassName('ParcAsterix', {includePersistent: true});
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('closes the four play areas on the captured closed day', async () => {
    vi.setSystemTime(CAPTURED_AT);
    // The capture's own calendar: next session 2026-12-19, today attested closed.
    const live = await stubbedPark(
      capture.latencies,
      capture.schedules,
      [openDay('2026-12-19')],
      ['2026-11-11'],
    ).getLiveData();

    const rows = byId(live);
    for (const id of PLAY_AREAS) {
      expect(rows.get(id)).toEqual({id, status: 'CLOSED'});
    }
    // Before the fix these four were the only OPERATING rows in the build.
    expect(live.filter((l) => l.status === 'OPERATING')).toEqual([]);
  });

  it('keeps a ride with a measured wait open on a closed day', async () => {
    vi.setSystemTime(CAPTURED_AT);
    const latencies = [
      ...capture.latencies.filter((l: {drupalId: string}) => l.drupalId !== '31304'),
      latency('31304', true, 15),
    ];
    const live = byId(
      await stubbedPark(latencies, [], [openDay('2026-12-19')], ['2026-11-11']).getLiveData(),
    );

    expect(live.get('31304')).toEqual({
      id: '31304',
      status: 'OPERATING',
      queue: {STANDBY: {waitTime: 15}},
    });
    expect(live.get('31365')).toEqual({id: '31365', status: 'CLOSED'});
  });

  it('closes a play area after the park has closed for the night', async () => {
    // 20:00 in Paris on an ordinary 10:00-18:00 day.
    vi.setSystemTime(new Date('2026-11-11T19:00:00Z'));
    const live = byId(
      await stubbedPark(capture.latencies, [], [openDay('2026-11-11')], []).getLiveData(),
    );

    expect(live.get('31365')).toEqual({id: '31365', status: 'CLOSED'});
  });

  it('leaves a play area open while the park is in session', async () => {
    // 13:00 in Paris on an open day: the flag is about now, so it stands.
    vi.setSystemTime(new Date('2026-11-11T12:00:00Z'));
    const live = byId(
      await stubbedPark(capture.latencies, [], [openDay('2026-11-11')], []).getLiveData(),
    );

    expect(live.get('31365')).toMatchObject({id: '31365', status: 'OPERATING'});
  });

  it('changes nothing when the calendar cannot say', async () => {
    vi.setSystemTime(CAPTURED_AT);
    // No calendar at all is `unknown`: no evidence the park is shut.
    const live = byId(await stubbedPark(capture.latencies, [], [], []).getLiveData());

    expect(live.get('31365')).toMatchObject({id: '31365', status: 'OPERATING'});
  });

  it('changes nothing on a day with no hours the park did not attest', async () => {
    vi.setSystemTime(CAPTURED_AT);
    const live = byId(
      await stubbedPark(capture.latencies, [], [openDay('2026-12-19')], []).getLiveData(),
    );

    expect(live.get('31365')).toMatchObject({id: '31365', status: 'OPERATING'});
  });
});

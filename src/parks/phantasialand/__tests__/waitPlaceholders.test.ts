import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {Phantasialand} from '../phantasialand.js';

/**
 * The signage feed occasionally sends `waitTime` values that cannot be
 * minutes: 110110, 13109, 808530737, 2535, 1520. Several of them are the
 * ASCII bytes of a short digit string read as one integer (13109 is 0x3335,
 * the bytes of "35"; 808530737 is 0x30313031, the bytes of "0101"), so the
 * corruption happens before the value reaches the JSON response. It arrives
 * here as an ordinary JSON number with nothing to say which encoding produced
 * it, so the reading is dropped rather than guessed at. Anything of 600
 * minutes or more is published as no wait reported.
 */
const NOW = new Date('2026-08-14T10:00:00Z');

function row(poiId: number, waitTime: unknown, open = true) {
  const stamp = new Date(NOW.getTime() - 2 * 60_000).toISOString();
  return {
    poiId: String(poiId),
    updatedAt: stamp,
    createdAt: stamp,
    updatedRow: stamp,
    waitTime,
    open,
    showTimes: null,
  };
}

async function liveFor(rows: any[]) {
  const park = new Phantasialand();
  vi.spyOn(park as any, 'getSignage').mockResolvedValue(rows);
  return park.getLiveData();
}

describe('Phantasialand implausible wait times', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([110110, 13109, 808530737, 2535, 1520, 600])('waitTime %i publishes no standby wait', async (value) => {
    const rows = await liveFor([row(60, value)]);
    const entry = rows.find(l => l.id === '60')!;

    expect(entry.status).toBe('OPERATING');
    expect(entry.queue?.STANDBY?.waitTime ?? null).toBeNull();
  });

  it('keeps real waits, including long ones', async () => {
    const rows = await liveFor([row(60, 25), row(61, 0), row(62, 150)]);

    expect(rows.find(l => l.id === '60')?.queue?.STANDBY?.waitTime).toBe(25);
    expect(rows.find(l => l.id === '61')?.queue?.STANDBY?.waitTime).toBe(0);
    expect(rows.find(l => l.id === '62')?.queue?.STANDBY?.waitTime).toBe(150);
  });

  it('leaves a closed ride closed with no queue', async () => {
    const rows = await liveFor([row(60, 13109, false)]);
    expect(rows[0]).toMatchObject({status: 'CLOSED'});
    expect(rows[0].queue).toBeUndefined();
  });
});

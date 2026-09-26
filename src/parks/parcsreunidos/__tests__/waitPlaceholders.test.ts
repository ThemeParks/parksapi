import {describe, test, expect, beforeEach, afterEach} from 'vitest';
import {ParqueWarnerMadrid} from '../parcsreunidos.js';
import {CacheLib} from '../../../cache.js';

/**
 * Parque Warner Madrid's attractions feed sometimes posts 666, 999 or 1000 in
 * `waitingTime`. These are placeholders, not minutes: a ride reads a normal
 * wait, jumps to one of these values, then drops back, often while it is not
 * running at all. Genuine waits at the park stay well under two hours.
 *
 * The status mapping is unchanged (any non-negative value still reads as
 * OPERATING); only the number is withheld.
 */

/** A row shaped like the Stay-App attractions response. */
function attraction(id: number, waitingTime: number | string) {
  return {
    id,
    translatableName: {es: `Atraccion ${id}`, en: `Attraction ${id}`},
    place: {point: {latitude: 40.2308, longitude: -3.5933}},
    waitingTime,
  };
}

async function liveFor(rows: any[]) {
  const park = new ParqueWarnerMadrid();
  park.getAttractions = async () => rows as any;
  return park.getLiveData();
}

describe('Parques Reunidos placeholder wait times', () => {
  beforeEach(() => CacheLib.clear());
  afterEach(() => CacheLib.clear());

  test.each([666, 999, 1000])('waitingTime %i publishes no standby wait', async (code) => {
    const live = await liveFor([attraction(101, code)]);
    const entry = live.find(l => l.id === '101')!;

    expect(entry.status).toBe('OPERATING');
    expect(entry.queue?.STANDBY?.waitTime ?? null).toBeNull();
  });

  test('a placeholder sent as a string is withheld too', async () => {
    const live = await liveFor([attraction(101, '999')]);
    expect(live[0].queue?.STANDBY?.waitTime ?? null).toBeNull();
  });

  test('a normal reading either side of a placeholder is untouched', async () => {
    const live = await liveFor([
      attraction(101, 15),
      attraction(102, 666),
      attraction(103, 120),
    ]);

    expect(live.find(l => l.id === '101')?.queue?.STANDBY?.waitTime).toBe(15);
    expect(live.find(l => l.id === '102')?.queue?.STANDBY?.waitTime ?? null).toBeNull();
    expect(live.find(l => l.id === '103')?.queue?.STANDBY?.waitTime).toBe(120);
  });

  test('negative sentinels still map to CLOSED', async () => {
    const live = await liveFor([attraction(101, -1)]);
    expect(live[0].status).toBe('CLOSED');
  });
});

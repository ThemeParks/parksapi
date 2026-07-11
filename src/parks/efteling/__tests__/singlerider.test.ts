/**
 * Single-rider queue lifecycle. The WIS feed lists each single rider as its own
 * entry with its OWN State, independent of the parent. These pin:
 *
 *   - the SINGLE_RIDER key stays present for every capable ride (no flapping);
 *   - waitTime holds a number only when the rider's own state is OPERATING,
 *     else null;
 *   - a closed/down rider under an OPEN parent keeps the key, and a ride with
 *     no single-rider alternate never grows the key.
 *
 * Fetch methods are stubbed; full integration runs via `npm run dev -- efteling`.
 */

import {describe, test, expect} from 'vitest';
import {Efteling} from '../efteling.js';

/** A single-rider-capable attraction POI: parent id + its single-rider alternate. */
function srPoi(id: string) {
  return {
    fields: {
      id,
      category: 'attraction',
      latlon: '51.65,5.05',
      alternatetype: 'singlerider',
      alternateid: `${id}singlerider`,
    },
  };
}

/** A plain attraction POI with no single-rider alternate. */
function plainPoi(id: string) {
  return {fields: {id, category: 'attraction', latlon: '51.65,5.05'}};
}

const POI_HITS = [
  srPoi('python'), // open single rider with a posted wait
  srPoi('joris'), // open single rider, no posted wait
  srPoi('baron'), // single rider gesloten under an OPEN parent
  srPoi('max'), // single rider mechanical fault (storing -> DOWN)
  plainPoi('carnaval'), // no single-rider alternate at all
];

const WAIT_TIMES = [
  // Parents — all open, so the single rider's own state is the only variable.
  {Id: 'python', Type: 'Attracties', State: 'open', WaitingTime: 25},
  {Id: 'joris', Type: 'Attracties', State: 'open', WaitingTime: 15},
  {Id: 'baron', Type: 'Attracties', State: 'open', WaitingTime: 20},
  {Id: 'max', Type: 'Attracties', State: 'open', WaitingTime: 10},
  {Id: 'carnaval', Type: 'Attracties', State: 'open', WaitingTime: 30},
  // Single-rider rows — their Id is the alternate, not a POI id.
  {Id: 'pythonsinglerider', Type: 'Attracties', State: 'open', WaitingTime: 5},
  {Id: 'jorissinglerider', Type: 'Attracties', State: 'open'},
  {Id: 'baronsinglerider', Type: 'Attracties', State: 'gesloten'},
  {Id: 'maxsinglerider', Type: 'Attracties', State: 'storing'},
];

function mockedEfteling(poiHits: any[], waitTimes: any[]): Efteling {
  const park = new Efteling();
  (park as any).getPOIData = async () => poiHits;
  (park as any).getWaitTimes = async () => waitTimes;
  return park;
}

async function liveById(poiHits = POI_HITS, waitTimes = WAIT_TIMES) {
  const live = await (mockedEfteling(poiHits, waitTimes) as any).buildLiveData();
  return (id: string) => live.find((l: any) => l.id === id);
}

describe('Efteling buildLiveData — single rider queue', () => {
  test('surfaces the posted single-rider wait when the single rider is open', async () => {
    const get = await liveById();
    expect(get('python').queue.SINGLE_RIDER).toEqual({waitTime: 5});
  });

  test('keeps the key present with waitTime: null when open without a posted wait', async () => {
    const get = await liveById();
    const joris = get('joris');
    expect(joris.queue).toHaveProperty('SINGLE_RIDER');
    expect(joris.queue.SINGLE_RIDER).toEqual({waitTime: null});
  });

  test('keeps the key present when the single rider is closed — no flapping', async () => {
    const get = await liveById();
    const baron = get('baron');
    // Parent is open; only the single rider is gesloten. The key must NOT
    // disappear across polls.
    expect(baron.queue).toHaveProperty('SINGLE_RIDER');
    expect(baron.queue.SINGLE_RIDER).toEqual({waitTime: null});
    // The parent's own STANDBY queue is unaffected.
    expect(baron.queue.STANDBY).toEqual({waitTime: 20});
  });

  test('a single-rider mechanical fault (storing/DOWN) keeps the key, not omitted', async () => {
    const get = await liveById();
    const max = get('max');
    // DOWN/REFURBISHMENT must not be conflated with CLOSED by dropping the key.
    expect(max.queue).toHaveProperty('SINGLE_RIDER');
    expect(max.queue.SINGLE_RIDER).toEqual({waitTime: null});
  });

  test('never grows a SINGLE_RIDER key for a ride with no single-rider alternate', async () => {
    const get = await liveById();
    const carnaval = get('carnaval');
    expect(carnaval.queue).not.toHaveProperty('SINGLE_RIDER');
    expect(carnaval.queue.STANDBY).toEqual({waitTime: 30});
  });
});

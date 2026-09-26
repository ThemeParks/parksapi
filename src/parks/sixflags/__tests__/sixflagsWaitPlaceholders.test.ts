import {describe, test, expect, beforeEach} from 'vitest';
import {SixFlags} from '../sixflags.js';
import {CacheLib} from '../../../cache.js';
import type {LiveData} from '@themeparks/typelib';

/**
 * Park staff can type any number into the wait-times board, and the feed
 * passes it straight through in `regularWaittime.waitTime`. Values like 666,
 * 777, 900 and 999 appear as a single reading between two zeros, usually on a
 * ride that venue-status says is closed, and one-off values in the thousands
 * (1201, 2510, 7335) turn up the same way. None of them are minutes: real
 * waits at these parks stay far below ten hours.
 *
 * A reading of 600 or more is treated as no wait reported.
 */

const PARK_ID = 40;

class Probe extends SixFlags {
  public venueStatus: any;
  public waitTimes: any;

  override async getParkData(): Promise<any> {
    return [{parkId: PARK_ID, code: 'CW', name: "Canada's Wonderland", waterParks: []}];
  }

  override async getVenueStatus(): Promise<any> {
    return this.venueStatus;
  }

  override async getWaitTimes(): Promise<any> {
    return this.waitTimes;
  }

  public buildLiveDataForTest(): Promise<LiveData[]> {
    return (this as any).buildLiveData();
  }
}

function probe(rides: Array<{fimsId: string; status?: string; wait?: number}>): Probe {
  const p = new Probe();
  p.venueStatus = {
    parkName: "Canada's Wonderland",
    lat: '43.843',
    lng: '-79.539',
    venues: [{
      venueId: 1,
      details: rides
        .filter(r => r.status !== undefined)
        .map(r => ({fimsId: r.fimsId, name: r.fimsId, status: r.status})),
    }],
  };
  p.waitTimes = {
    venues: [{
      venueId: 1,
      details: rides
        .filter(r => r.wait !== undefined)
        .map(r => ({fimsId: r.fimsId, name: r.fimsId, isFastLane: false, regularWaittime: {waitTime: r.wait}})),
    }],
  };
  return p;
}

describe('SixFlags placeholder wait times', () => {
  beforeEach(() => {
    CacheLib.clearByClassName('Probe');
  });

  test.each([666, 777, 900, 999, 1201, 2510, 7335])('an open ride posting %i has no standby wait', async (code) => {
    const live = await probe([{fimsId: 'RIDE-040-00199', status: 'Opened', wait: code}]).buildLiveDataForTest();
    const ride = live.find(l => l.id === 'RIDE-040-00199')!;

    expect(ride.status).toBe('OPERATING');
    expect(ride.queue?.STANDBY?.waitTime ?? null).toBeNull();
  });

  test('a placeholder on a ride missing from venue-status does not make it look open', async () => {
    // Wait-times-only rides take their status from the wait alone, so a
    // placeholder here used to report a closed ride as OPERATING.
    const live = await probe([{fimsId: 'RIDE-040-00072', wait: 999}]).buildLiveDataForTest();
    const ride = live.find(l => l.id === 'RIDE-040-00072')!;

    expect(ride.status).toBe('CLOSED');
    expect(ride.queue?.STANDBY?.waitTime ?? null).toBeNull();
  });

  test('real waits either side of the cut-off pass through', async () => {
    const live = await probe([
      {fimsId: 'RIDE-040-00001', status: 'Opened', wait: 0},
      {fimsId: 'RIDE-040-00002', status: 'Opened', wait: 45},
      {fimsId: 'RIDE-040-00003', status: 'Opened', wait: 180},
      {fimsId: 'RIDE-040-00004', wait: 60},
    ]).buildLiveDataForTest();

    expect(live.find(l => l.id === 'RIDE-040-00001')?.queue?.STANDBY?.waitTime).toBe(0);
    expect(live.find(l => l.id === 'RIDE-040-00002')?.queue?.STANDBY?.waitTime).toBe(45);
    expect(live.find(l => l.id === 'RIDE-040-00003')?.queue?.STANDBY?.waitTime).toBe(180);
    const walkIn = live.find(l => l.id === 'RIDE-040-00004')!;
    expect(walkIn.status).toBe('OPERATING');
    expect(walkIn.queue?.STANDBY?.waitTime).toBe(60);
  });
});

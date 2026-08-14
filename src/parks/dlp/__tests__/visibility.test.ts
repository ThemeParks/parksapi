import {describe, it, expect, vi, afterEach} from 'vitest';
import {DisneylandParis} from '../disneylandparis.js';

/**
 * A hidden POI is normally dropped by filterPOIEntities (HIDE_RULES); entities
 * in VISIBILITY_EXCEPTIONS bypass that. Mickey's PhilharMagic exists twice in
 * POI — published Entertainment record P1G103 and hidden Attraction twin
 * P1DA13 — and must surface exactly once, as P1G103, with the twin's live
 * and schedule data folded onto it.
 */
function stubbedPark(): DisneylandParis {
  const park = new DisneylandParis();
  vi.spyOn(park as any, 'getPOIData').mockResolvedValue({
    ThemePark: [{id: 'P1', name: 'Disneyland Park', type: 'ThemePark'}],
    Attraction: [
      {
        id: 'P1DA10',
        name: 'Disneyland Railroad Discoveryland Station',
        type: 'Attraction',
        location: {id: 'P1'},
        hideFunctionality: 'Hide from Web List + Mobile App',
      },
      {
        id: 'P1NA16',
        name: 'Disneyland Railroad Fantasyland Station',
        type: 'Attraction',
        location: {id: 'P1'},
        hideFunctionality: 'Hide from Web List + Mobile App',
      },
      {
        // Control: retirement-flagged record not in VISIBILITY_EXCEPTIONS — must stay dropped.
        id: 'P1DA14-OLD',
        name: 'Retired Attraction',
        type: 'Attraction',
        location: {id: 'P1'},
        hideFunctionality: 'Hide from Web List + Mobile App',
      },
      {
        // The hidden PhilharMagic twin: stays filtered, its data is aliased.
        id: 'P1DA13',
        name: 'Mickey’s PhilharMagic',
        type: 'Attraction',
        location: {id: 'P1'},
        hideFunctionality: 'Hide from the Service',
      },
      {
        // Control: the only other attraction carrying "Hide from the Service",
        // and it appears in no live feed — must stay dropped.
        id: 'P1JF00',
        name: 'Gardens of Wonder',
        type: 'Attraction',
        location: {id: 'P1'},
        hideFunctionality: 'Hide from the Service',
      },
    ],
    Entertainment: [
      {
        id: 'P1GS93',
        name: 'Live Your Story – a Disney Princess Celebration',
        type: 'Entertainment',
        subType: 'Stage Show',
        location: {id: 'P1'},
        hideFunctionality: 'Hide from the Service',
      },
      {
        // Control: hidden Stage Show NOT in VISIBILITY_EXCEPTIONS — must stay dropped.
        id: 'P1G107',
        name: 'Disney Music Hits Concert',
        type: 'Entertainment',
        subType: 'Stage Show',
        location: {id: 'P1'},
        hideFunctionality: 'Hide from Web List + Mobile App',
      },
      {
        // "Hide from the Mobile App" marks content pages, not venues, so it is
        // not a hide rule. Correcting it into one would drop this show.
        id: 'P1G108',
        name: 'The Lion King: Rhythms of the Pride Lands',
        type: 'Entertainment',
        subType: 'Stage Show',
        location: {id: 'P1'},
        hideFunctionality: 'Hide from the Mobile App',
      },
      {
        // The published PhilharMagic record.
        id: 'P1G103',
        name: 'Mickey’s PhilharMagic',
        type: 'Entertainment',
        subType: 'Stage Show',
        location: {id: 'P1'},
      },
    ],
  });
  return park;
}

function stubLiveFeeds(park: DisneylandParis, waitTimes: unknown[] = []): void {
  vi.spyOn(park as any, 'getWaitTimes').mockResolvedValue(waitTimes);
  vi.spyOn(park as any, 'getPremierAccess').mockResolvedValue([]);
  vi.spyOn(park as any, 'getVirtualQueueData').mockResolvedValue([]);
}

describe('DLP visibility exceptions', () => {
  afterEach(() => vi.restoreAllMocks());

  it('surfaces railroad stations flagged Hide from Web List + Mobile App', async () => {
    const entities = await stubbedPark().getEntities();
    const discovery = entities.find((e) => e.id === 'P1DA10');
    const fantasy = entities.find((e) => e.id === 'P1NA16');
    expect(discovery).toBeDefined();
    expect(discovery?.entityType).toBe('ATTRACTION');
    expect((discovery as any)?.parkId).toBe('P1');
    expect(fantasy).toBeDefined();
    expect(fantasy?.entityType).toBe('ATTRACTION');
    expect((fantasy as any)?.parkId).toBe('P1');
  });

  it('surfaces P1GS93 (Live Your Story) despite its "Hide from the Service" flag', async () => {
    const entities = await stubbedPark().getEntities();
    const lys = entities.find((e) => e.id === 'P1GS93');
    expect(lys).toBeDefined();
    expect(lys?.entityType).toBe('SHOW');
    expect((lys as any)?.parkId).toBe('P1');
  });

  it('publishes exactly one PhilharMagic: P1G103 as a show-type attraction', async () => {
    const entities = await stubbedPark().getEntities();
    const matches = entities.filter((e) => /philharmagic/i.test(String(e.name)));
    expect(matches).toHaveLength(1);
    expect(matches[0].id).toBe('P1G103');
    expect(matches[0].entityType).toBe('ATTRACTION');
    expect((matches[0] as any).attractionType).toBe('SHOW');
    expect((matches[0] as any).parkId).toBe('P1');
  });

  it('folds the hidden twin\'s wait time onto P1G103 and keeps its showtimes', async () => {
    const park = stubbedPark();
    stubLiveFeeds(park, [
      {entityId: 'P1DA13', type: 'Attraction', status: 'OPERATING', postedWaitMinutes: 15},
    ]);
    vi.spyOn(park as any, 'getScheduleForDate').mockImplementation(async (date) => [
      {id: 'P1G103', schedules: [
        {date, startTime: '12:30:00', endTime: '12:30:00', status: 'PERFORMANCE_TIME'},
      ]},
    ]);

    const live = await park.getLiveData();
    expect(live.find((l) => l.id === 'P1DA13')).toBeUndefined();
    const row = live.find((l) => l.id === 'P1G103');
    expect(row?.queue?.STANDBY).toEqual({waitTime: 15});
    expect(row?.showtimes).toHaveLength(1);
  });

  it('attaches the twin\'s schedule rows to P1G103 instead of orphaning them', async () => {
    const park = stubbedPark();
    vi.spyOn(park as any, 'getScheduleForDate').mockImplementation(async (date) => [
      {id: 'P1DA13', schedules: [
        {date, startTime: '12:30:00', endTime: '17:30:00', status: 'OPERATING'},
      ]},
    ]);

    const schedules = await park.getSchedules();
    expect(schedules.find((s) => s.id === 'P1DA13')).toBeUndefined();
    expect(schedules.find((s) => s.id === 'P1G103')?.schedule).toHaveLength(60);
  });

  it('still drops other retirement-flagged POIs not in the exception set', async () => {
    const entities = await stubbedPark().getEntities();
    expect(entities.find((e) => e.id === 'P1G107')).toBeUndefined();
    expect(entities.find((e) => e.id === 'P1DA14-OLD')).toBeUndefined();
    expect(entities.find((e) => e.id === 'P1JF00')).toBeUndefined();
  });

  it('publishes a show flagged "Hide from the Mobile App"', async () => {
    const entities = await stubbedPark().getEntities();
    expect(entities.find((e) => e.id === 'P1G108')?.entityType).toBe('SHOW');
  });
});

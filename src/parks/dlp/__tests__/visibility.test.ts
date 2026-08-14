import {describe, it, expect, vi, afterEach} from 'vitest';
import {DisneylandParis} from '../disneylandparis.js';

/**
 * A hidden POI is normally dropped by filterPOIEntities (HIDE_RULES). Entities
 * listed in VISIBILITY_EXCEPTIONS bypass that: P1GS93 ("Live Your Story"), the
 * two railroad stations, three schedule-backed meet & greets and the two
 * Heroic Encounters are all live despite their flags, so each must be
 * force-surfaced while flagged records outside the set stay filtered.
 *
 * Mickey's PhilharMagic exists twice in POI — published Entertainment record
 * P1G103 and hidden Attraction twin P1DA13 — and must surface exactly once, as
 * P1G103, with the twin's live and schedule data folded onto it.
 */
function stubbedPark(): DisneylandParis {
  const park = new DisneylandParis();
  vi.spyOn(park as any, 'getPOIData').mockResolvedValue({
    ThemePark: [
      {id: 'P1', name: 'Disneyland Park', type: 'ThemePark'},
      {id: 'P2', name: 'Disney Adventure World', type: 'ThemePark'},
    ],
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
      {
        id: 'P2MG33',
        name: 'Spider-Man Heroic Encounter',
        type: 'Entertainment',
        subType: 'Character Experience - Meet & Greet',
        location: {id: 'P2'},
        hideFunctionality: 'Hide from the Service',
      },
      {
        id: 'P2MG43',
        name: 'MARVEL Super Hero Heroic Encounter',
        type: 'Entertainment',
        subType: 'Character Experience - Meet & Greet',
        location: {id: 'P2'},
        hideFunctionality: 'Hide from the Service',
      },
      {
        // Control: the retired twin of a published meet & greet, carrying the
        // same flag but no virtual queue — must stay dropped.
        id: 'P2MG59',
        name: 'Meet a Toy Story Character',
        type: 'Entertainment',
        subType: 'Character Experience - Meet & Greet',
        location: {id: 'P2'},
        hideFunctionality: 'Hide from the Service',
      },
      {
        id: 'P2MG31',
        name: 'Meet Goofy, the Movie Director',
        type: 'Entertainment',
        subType: 'Character Experience - Meet & Greet',
        location: {id: 'P2'},
        hideFunctionality: 'Hide from Web List + Mobile App',
      },
      {
        id: 'P1MG21',
        name: 'An Encounter with Captain Hook',
        type: 'Entertainment',
        subType: 'Character Experience - Meet & Greet',
        location: {id: 'P1'},
        hideFunctionality: 'Hide from Web List + Mobile App',
      },
      {
        id: 'P1MG05',
        name: 'Meet Donald Duck or his friends',
        type: 'Entertainment',
        subType: 'Character Experience - Meet & Greet',
        location: {id: 'P1'},
        hideFunctionality: 'Hide from Web List + Mobile App',
      },
      {
        // Unflagged meet & greet — the common case this branch turns on.
        id: 'P1MG10',
        name: 'Meet Mickey Mouse',
        type: 'Entertainment',
        subType: 'Character Experience - Meet & Greet',
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

  it('publishes an unflagged meet & greet as a SHOW entity', async () => {
    const entities = await stubbedPark().getEntities();
    const meet = entities.find((e) => e.id === 'P1MG10');
    expect(meet).toBeDefined();
    expect(meet?.entityType).toBe('SHOW');
    expect((meet as any)?.parkId).toBe('P1');
  });

  it('surfaces the three schedule-backed meet & greets despite their retirement flag', async () => {
    const entities = await stubbedPark().getEntities();
    for (const [id, parkId] of [['P2MG31', 'P2'], ['P1MG21', 'P1'], ['P1MG05', 'P1']]) {
      const meet = entities.find((e) => e.id === id);
      expect(meet, id).toBeDefined();
      expect(meet?.entityType).toBe('SHOW');
      expect((meet as any)?.parkId).toBe(parkId);
    }
  });

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

  it('surfaces the two Heroic Encounters despite their "Hide from the Service" flag', async () => {
    const entities = await stubbedPark().getEntities();
    for (const id of ['P2MG33', 'P2MG43']) {
      const meet = entities.find((e) => e.id === id);
      expect(meet, id).toBeDefined();
      expect(meet?.entityType).toBe('SHOW');
      expect((meet as any)?.parkId).toBe('P2');
    }
  });

  it('still drops a retired meet & greet carrying the same flag', async () => {
    const entities = await stubbedPark().getEntities();
    expect(entities.find((e) => e.id === 'P2MG59')).toBeUndefined();
  });
});

import {describe, it, expect, vi, beforeEach} from 'vitest';
import {DisneylandParis} from '../disneylandparis.js';

/**
 * A hidden POI is normally dropped by filterPOIEntities (HIDE_RULES). Entities
 * listed in VISIBILITY_EXCEPTIONS bypass that. P1GS93 ("Live Your Story") is a
 * real Castle Stage show Disney flags "Hide from the Service", so it must be
 * force-surfaced while other hidden shows stay filtered.
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
    ],
  });
  return park;
}

describe('DLP visibility exceptions', () => {
  beforeEach(() => vi.restoreAllMocks());

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

  it('still drops other retirement-flagged POIs not in the exception set', async () => {
    const entities = await stubbedPark().getEntities();
    expect(entities.find((e) => e.id === 'P1G107')).toBeUndefined();
    expect(entities.find((e) => e.id === 'P1DA14-OLD')).toBeUndefined();
  });

  it('publishes a show flagged "Hide from the Mobile App"', async () => {
    const entities = await stubbedPark().getEntities();
    expect(entities.find((e) => e.id === 'P1G108')?.entityType).toBe('SHOW');
  });
});

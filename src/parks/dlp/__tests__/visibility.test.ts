import {describe, it, expect, vi, beforeEach} from 'vitest';
import {DisneylandParis} from '../disneylandparis.js';

/**
 * Disney POI visibility: app-hidden attractions surface via policy; service-hidden
 * shows need SERVICE_HIDE_EXCEPTIONS (e.g. P1GS93 Live Your Story).
 */
function stubbedPark(): DisneylandParis {
  const park = new DisneylandParis();
  vi.spyOn(park as any, 'getPOIData').mockResolvedValue({
    ThemePark: [{id: 'P1', name: 'Disneyland Park', type: 'ThemePark'}],
    Attraction: [
      {
        id: 'P1DA13',
        name: "Mickey's PhilharMagic",
        type: 'Attraction',
        location: {id: 'P1'},
        hideFunctionality: 'Hide from Mobile App',
      },
      {
        // Service-hidden attraction — policy drops it (no per-ride exception list).
        id: 'P1TEST01',
        name: 'Service Hidden Attraction',
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
        // Control: service-hidden Stage Show not in SERVICE_HIDE_EXCEPTIONS — must stay dropped.
        id: 'P1G107',
        name: 'Disney Music Hits Concert',
        type: 'Entertainment',
        subType: 'Stage Show',
        location: {id: 'P1'},
        hideFunctionality: 'Hide from Web List + Mobile App',
      },
    ],
  });
  return park;
}

describe('DLP POI visibility policy', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('surfaces app-hidden attractions (e.g. Mickey\'s PhilharMagic)', async () => {
    const entities = await stubbedPark().getEntities();
    const phil = entities.find((e) => e.id === 'P1DA13');
    expect(phil).toBeDefined();
    expect(phil?.entityType).toBe('ATTRACTION');
    expect((phil as any)?.parkId).toBe('P1');
  });

  it('surfaces app-hidden attractions with either app-only hide flag', async () => {
    const park = new DisneylandParis();
    vi.spyOn(park as any, 'getPOIData').mockResolvedValue({
      ThemePark: [{id: 'P1', name: 'Disneyland Park', type: 'ThemePark'}],
      Attraction: [
        {
          id: 'P2EA00',
          name: 'Frozen Ever After',
          type: 'Attraction',
          location: {id: 'P2'},
          hideFunctionality: 'Hide from Web List + Mobile App',
        },
      ],
    });
    const entities = await park.getEntities();
    const frozen = entities.find((e) => e.id === 'P2EA00');
    expect(frozen).toBeDefined();
    expect(frozen?.entityType).toBe('ATTRACTION');
    expect((frozen as any)?.parkId).toBe('P2');
  });

  it('surfaces P1GS93 (Live Your Story) despite its "Hide from the Service" flag', async () => {
    const entities = await stubbedPark().getEntities();
    const lys = entities.find((e) => e.id === 'P1GS93');
    expect(lys).toBeDefined();
    expect(lys?.entityType).toBe('SHOW');
    expect((lys as any)?.parkId).toBe('P1');
  });

  it('still drops service-hidden attractions not in the exception set', async () => {
    const entities = await stubbedPark().getEntities();
    expect(entities.find((e) => e.id === 'P1TEST01')).toBeUndefined();
  });

  it('still drops other hidden shows not in the exception set', async () => {
    const entities = await stubbedPark().getEntities();
    expect(entities.find((e) => e.id === 'P1G107')).toBeUndefined();
  });
});

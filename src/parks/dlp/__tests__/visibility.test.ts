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
    ],
  });
  return park;
}

describe('DLP visibility exceptions', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('surfaces P1GS93 (Live Your Story) despite its "Hide from the Service" flag', async () => {
    const entities = await stubbedPark().getEntities();
    const lys = entities.find((e) => e.id === 'P1GS93');
    expect(lys).toBeDefined();
    expect(lys?.entityType).toBe('SHOW');
    expect((lys as any)?.parkId).toBe('P1');
  });

  it('still drops other hidden shows not in the exception set', async () => {
    const entities = await stubbedPark().getEntities();
    expect(entities.find((e) => e.id === 'P1G107')).toBeUndefined();
  });
});

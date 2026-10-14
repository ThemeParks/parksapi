import {describe, test, expect, beforeEach, afterEach} from 'vitest';
import {SeaWorldGoldCoast} from '../te2.js';
import {CacheLib} from '../../../cache.js';

/**
 * Sea World Gold Coast writes a status banner into the name of a show that is
 * on: "ONE Dolphin Presentation – NOW SHOWING". Names reach the entity list
 * from two places, the point-of-interest list and the event calendar, and both
 * go through the shared name sanitiser, which removes the banner. The ids stay
 * as the park gives them.
 *
 * The banner name and the other names are the live ones. The ids and the venue
 * are made up.
 */

const BANNERED = 'ONE Dolphin Presentation – NOW SHOWING';

function park(): SeaWorldGoldCoast {
  const p: any = new SeaWorldGoldCoast();
  p.getVenue = async () => ({name: 'Sea World', location: {center: {lat: -27.9, lon: 153.4}}});
  p.getPOIAll = async () => [
    {id: 'poi-one-dolphin', name: BANNERED, type: 'Shows'},
    {id: 'poi-dolphin-stadium', name: 'Dolphin Beach Stadium', type: 'Shows'},
    {id: 'poi-seal-guardians', name: 'Seal Guardians Presentation', type: 'Shows'},
    {id: 'poi-jet-rescue', name: 'Jet Rescue', type: 'Ride'},
  ];
  p.getDisplayCategories = async () => ({ridePoiIds: {}, showPoiIds: {}, diningPoiIds: {}});
  p.getLiveStatus = async () => [];
  p.getEventCalendar = async () => ({
    events: [{id: 'event-one-dolphin', title: BANNERED, associatedPois: []}],
    schedules: [],
  });
  return p;
}

describe('TE2 Sea World Gold Coast "NOW SHOWING" banner', () => {
  beforeEach(() => CacheLib.clear());
  afterEach(() => CacheLib.clear());

  test('is removed from the point of interest and from the calendar event', async () => {
    const entities = await park().getEntities();
    expect(entities.find(e => e.id === 'poi-one-dolphin')?.name).toBe('ONE Dolphin Presentation');
    expect(entities.find(e => e.id === 'event-one-dolphin')?.name).toBe('ONE Dolphin Presentation');
  });

  test('leaves ids and types as the park gives them', async () => {
    const entities = await park().getEntities();
    expect(entities.find(e => e.id === 'poi-one-dolphin')).toMatchObject({entityType: 'SHOW', parentId: 'vrtp_sw_te2'});
    expect(entities.find(e => e.id === 'event-one-dolphin')).toMatchObject({entityType: 'SHOW', parentId: 'vrtp_sw_te2'});
  });

  test('leaves every other name exactly as it was', async () => {
    const entities = await park().getEntities();
    const names = Object.fromEntries(entities.map(e => [e.id, e.name]));
    expect(names).toMatchObject({
      'poi-dolphin-stadium': 'Dolphin Beach Stadium',
      'poi-seal-guardians': 'Seal Guardians Presentation',
      'poi-jet-rescue': 'Jet Rescue',
    });
    expect(entities.some(e => /now showing/i.test(String(e.name)))).toBe(false);
  });
});

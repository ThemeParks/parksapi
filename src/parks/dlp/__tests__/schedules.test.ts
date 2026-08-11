import {describe, it, expect, vi, beforeEach} from 'vitest';
import {DisneylandParis} from '../disneylandparis.js';

/**
 * The schedule feed covers far more than the POI set the park publishes —
 * hotel and Disney Village restaurants, character meets, and records the
 * visibility filter drops. Only entities that actually get emitted may carry
 * schedules.
 */
const OPERATING = {startTime: '09:30:00', endTime: '22:00:00', status: 'OPERATING'};

function stubbedPark(activities: unknown): DisneylandParis {
  const park = new DisneylandParis();

  vi.spyOn(park as any, 'getPOIData').mockResolvedValue({
    ThemePark: [{id: 'P1', name: 'Disneyland Park', type: 'ThemePark'}],
    Attraction: [
      {id: 'P1RA00', name: 'Big Thunder Mountain', type: 'Attraction', location: {id: 'P1'}},
      {
        id: 'P1DA13',
        name: 'Mickey’s PhilharMagic',
        type: 'Attraction',
        location: {id: 'P1'},
        hideFunctionality: 'Hide from the Service',
      },
      {id: 'P2AC00', name: 'Ignored', type: 'Attraction', location: {id: 'P2'}},
    ],
    Entertainment: [
      {id: 'P1MG03', name: 'Meet Goofy', type: 'Entertainment', subType: 'Meet', location: {id: 'P1'}},
    ],
    Restaurant: [
      {id: 'H01R01', name: 'La Table de Lumière', type: 'Restaurant', location: {id: 'H01'}},
    ],
  });
  vi.spyOn(park as any, 'getScheduleForDate').mockResolvedValue(activities);

  return park;
}

/** Ids that end up with a schedule, given what the schedule feed returned. */
async function scheduledIds(activities: unknown): Promise<string[]> {
  const schedules = await stubbedPark(activities).getSchedules();
  return schedules.map((s) => s.id).sort();
}

const feedFor = (ids: string[], hours: unknown = OPERATING) =>
  ids.map((id) => ({id, name: id, schedules: [hours]}));

describe('DLP schedules', () => {
  beforeEach(() => vi.restoreAllMocks());

  // === Only published entities ===

  it('keeps a schedule for a published attraction', async () => {
    expect(await scheduledIds(feedFor(['P1RA00']))).toEqual(['P1RA00']);
  });

  it('keeps park schedules', async () => {
    expect(await scheduledIds(feedFor(['P1']))).toEqual(['P1']);
  });

  it.each([
    ['a hotel restaurant outside the parks', 'H01R01'],
    ['an attraction the visibility filter drops', 'P1DA13'],
    ['an entity on the ignore list', 'P2AC00'],
    ['entertainment that is not a show subtype', 'P1MG03'],
    ['an id absent from the POI feed entirely', 'D01R02'],
  ])('drops the schedule for %s', async (_label, id) => {
    expect(await scheduledIds(feedFor([id]))).toEqual([]);
  });

  it('keeps only the published ids when the feed mixes them', async () => {
    expect(await scheduledIds(feedFor(['P1', 'P1RA00', 'H01R01', 'P1DA13', 'D01R02'])))
      .toEqual(['P1', 'P1RA00']);
  });

  // === Schedule contents ===

  it('publishes one entry per day of the 60-day window', async () => {
    const schedules = await stubbedPark(feedFor(['P1RA00'])).getSchedules();
    expect(schedules[0].schedule).toHaveLength(60);
  });

  it('maps EXTRA_MAGIC_HOURS and PERFORMANCE_TIME to their own types', async () => {
    const magic = await stubbedPark(feedFor(['P1'], {
      startTime: '08:30:00', endTime: '09:30:00', status: 'EXTRA_MAGIC_HOURS',
    })).getSchedules();
    expect(magic[0].schedule[0]).toMatchObject({type: 'EXTRA_HOURS', description: 'Extra Magic Hours'});

    const show = await stubbedPark(feedFor(['P1RA00'], {
      startTime: '21:00:00', endTime: '21:30:00', status: 'PERFORMANCE_TIME',
    })).getSchedules();
    expect(show[0].schedule[0]).toMatchObject({type: 'INFO', description: 'Performance Time'});
  });

  it.each(['REFURBISHMENT', 'CLOSED'])('skips %s days', async (status) => {
    expect(await scheduledIds(feedFor(['P1RA00'], {...OPERATING, status}))).toEqual([]);
  });

  it('keeps the seconds the feed publishes', async () => {
    const schedules = await stubbedPark(feedFor(['P1RA00'], {
      startTime: '00:00:00', endTime: '23:59:00', status: 'OPERATING',
    })).getSchedules();
    expect(schedules[0].schedule[0].closingTime).toMatch(/T23:59:00/);
  });

  it('survives a schedule fetch that rejects', async () => {
    const park = stubbedPark(null);
    vi.spyOn(park as any, 'getScheduleForDate').mockRejectedValue(new Error('upstream down'));
    await expect(park.getSchedules()).resolves.toEqual([]);
  });
});

import {describe, it, expect, vi, beforeEach} from 'vitest';
import {DisneylandParis} from '../disneylandparis.js';

/**
 * The schedule feed covers far more than the POI set the park publishes —
 * hotel and Disney Village restaurants, character meets, and records the
 * visibility filter drops. Only entities that actually get emitted may carry
 * schedules, and one unusable row may not cost the other sixty days.
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

  // === Malformed input ===

  it.each([
    ['the feed returns null', null],
    ['the feed returns a string', 'text'],
    ['the feed returns a null entry', [null]],
    ['an entry has no id or schedules', [{}]],
    ['schedules is null', [{id: 'P1RA00', schedules: null}]],
    ['schedules is a string', [{id: 'P1RA00', schedules: 'text'}]],
    ['schedules is a number', [{id: 'P1RA00', schedules: 42}]],
    ['schedules is an object', [{id: 'P1RA00', schedules: {}}]],
    ['a row is null', [{id: 'P1RA00', schedules: [null]}]],
    ['a row has no times', [{id: 'P1RA00', schedules: [{status: 'OPERATING'}]}]],
  ])('survives when %s', async (_label, activities) => {
    expect(await scheduledIds(activities)).toEqual([]);
  });

  it.each([
    'abc',
    '9:30:00',
    '25:00:00',
    '09:99:00',
    '09:30:99',
    '0930',
    '',
  ])('skips a row whose time reads "%s"', async (startTime) => {
    expect(await scheduledIds(feedFor(['P1RA00'], {...OPERATING, startTime}))).toEqual([]);
  });

  it('drops only the unusable row, not the whole build', async () => {
    const schedules = await stubbedPark([{
      id: 'P1RA00',
      name: 'Big Thunder Mountain',
      schedules: [OPERATING, {...OPERATING, startTime: 'abc'}],
    }]).getSchedules();

    expect(schedules).toHaveLength(1);
    expect(schedules[0].schedule).toHaveLength(60);
  });

  it('survives a schedule fetch that rejects', async () => {
    const park = stubbedPark(null);
    vi.spyOn(park as any, 'getScheduleForDate').mockRejectedValue(new Error('upstream down'));
    await expect(park.getSchedules()).resolves.toEqual([]);
  });
});

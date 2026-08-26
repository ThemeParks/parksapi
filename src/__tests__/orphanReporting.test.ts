import {describe, it, expect, vi, afterEach} from 'vitest';
import {testPark} from '../testRunner.js';
import {Destination} from '../destination.js';

/**
 * The orphan warning itself: truncation to five ids, the "+N more" tail, and
 * the affected-day sum. Driven through the real `testPark` rather than a
 * replica, so the shipped strings are what gets asserted.
 */
function stubPark(opts: {
  entities?: string[];
  liveIds?: string[];
  schedules?: Array<{id: string; days: number}>;
}): Destination {
  const park = new (class extends Destination {})({} as any);

  vi.spyOn(park, 'getDestinations').mockResolvedValue([
    {id: 'dest', name: 'Dest', entityType: 'DESTINATION', location: {latitude: 1, longitude: 1}} as any,
  ]);
  vi.spyOn(park, 'getEntities').mockResolvedValue([
    {id: 'dest', name: 'Dest', entityType: 'DESTINATION', location: {latitude: 1, longitude: 1}},
    ...(opts.entities ?? []).map((id) => ({id, name: id, entityType: 'ATTRACTION'})),
  ] as any);
  vi.spyOn(park, 'getLiveData').mockResolvedValue(
    (opts.liveIds ?? []).map((id) => ({id, status: 'OPERATING'})) as any,
  );
  vi.spyOn(park, 'getSchedules').mockResolvedValue(
    (opts.schedules ?? []).map((s) => ({
      id: s.id,
      schedule: Array.from({length: s.days}, () => ({
        date: '2026-08-14', type: 'OPERATING', openingTime: '', closingTime: '',
      })),
    })) as any,
  );

  return park;
}

async function warnings(park: Destination): Promise<string[]> {
  const lines: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...args) => {
    lines.push(args.join(' '));
  });
  await testPark('stub', 'Stub Park', park, {verbose: true});
  log.mockRestore();
  return lines.filter((l) => l.includes('unpublished entities') || l.includes('days affected'));
}

describe('orphan reporting', () => {
  afterEach(() => vi.restoreAllMocks());

  it('says nothing when every row resolves', async () => {
    const park = stubPark({entities: ['A', 'B'], liveIds: ['A', 'B']});
    expect(await warnings(park)).toEqual([]);
  });

  it('lists every orphan up to five without a tail', async () => {
    const park = stubPark({entities: ['A'], liveIds: ['O1', 'O2', 'O3', 'O4', 'O5']});
    const [line] = await warnings(park);
    expect(line).toContain('Live data for unpublished entities: 5');
    expect(line).toContain('O1, O2, O3, O4, O5');
    expect(line).not.toContain('more');
  });

  it('truncates at five and counts the rest', async () => {
    const park = stubPark({entities: ['A'], liveIds: ['O1', 'O2', 'O3', 'O4', 'O5', 'O6']});
    const [line] = await warnings(park);
    expect(line).toContain('unpublished entities: 6');
    expect(line).toContain('+1 more');
    expect(line).not.toContain('O6');
  });

  it('keeps shown plus remainder equal to the total', async () => {
    const ids = Array.from({length: 12}, (_, i) => `O${i + 1}`);
    const park = stubPark({entities: ['A'], liveIds: ids});
    const [line] = await warnings(park);
    expect(line).toContain('unpublished entities: 12');
    expect(line).toContain('+7 more');
    // 5 shown + 7 more = 12
    expect(line.match(/O\d+/g)?.length).toBe(5);
  });

  it('reports one orphan without a tail', async () => {
    const park = stubPark({entities: ['A'], liveIds: ['A', 'GHOST']});
    const [line] = await warnings(park);
    expect(line).toContain('unpublished entities: 1 (GHOST)');
    expect(line).not.toContain('more');
  });

  it('sums the days of every orphaned schedule row, not the ids', async () => {
    // Two rows can carry the same orphan id; the day count follows rows.
    const park = stubPark({
      entities: ['A'],
      schedules: [{id: 'A', days: 10}, {id: 'GHOST', days: 3}, {id: 'GHOST', days: 2}],
    });
    const lines = await warnings(park);
    expect(lines.join('\n')).toContain('Schedules for unpublished entities: 1');
    expect(lines.join('\n')).toContain('(5 of 15 days affected)');
  });

  it('stays silent when the entity list could not be built', async () => {
    const park = stubPark({liveIds: ['GHOST']});
    vi.spyOn(park, 'getEntities').mockRejectedValue(new Error('upstream down'));
    expect(await warnings(park)).toEqual([]);
  });
});

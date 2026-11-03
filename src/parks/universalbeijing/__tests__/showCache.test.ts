import {describe, it, expect, vi, afterEach, beforeEach} from 'vitest';
import {CacheLib} from '../../../cache.js';
import {UniversalStudiosBeijing} from '../universalbeijing.js';

/**
 * The perform list carries each show's live state (is_closed, gems_status)
 * and its show_time_arr for today. Cached for 3 hours, a show that closed or
 * changed its times kept its old state for up to 3 hours, and two instances
 * that fetched at different moments disagreed for that long. The attraction
 * list is already cached for 60 s; the perform list must be as fresh.
 */
const LIVE_TTL_SECONDS = 60;

beforeEach(() => CacheLib.clearByClassName('UniversalStudiosBeijing', {includePersistent: true}));
afterEach(() => vi.restoreAllMocks());

function respondWith(list: unknown[]) {
  return {json: async () => ({data: {list}})} as any;
}

describe('Universal Beijing show data freshness', () => {
  it('queues the perform list request with the same 60 s HTTP cache as the attraction list', async () => {
    const park = new UniversalStudiosBeijing();
    park.baseURL = 'https://feed.example.test';
    const ttls = new Map<string, number | undefined>();
    vi.spyOn(park.httpQueue, 'push').mockImplementation((entry: any) => {
      ttls.set(entry.methodName, entry.request.cacheTtlSeconds);
    });

    // The queued request never settles (the queue is stubbed); only the
    // queued entry is inspected.
    void park.fetchShowData();
    void park.fetchAttractionData();
    await vi.waitFor(() => expect(ttls.size).toBe(2));

    expect(ttls.get('fetchShowData')).toBe(LIVE_TTL_SECONDS);
    expect(ttls.get('fetchShowData')).toBe(ttls.get('fetchAttractionData'));
  });

  it('re-reads the perform list once the 60 s method cache has expired', async () => {
    const park = new UniversalStudiosBeijing();
    const fetch = vi.spyOn(park, 'fetchShowData')
      .mockResolvedValueOnce(respondWith([{id: 'a', is_closed: 0}]))
      .mockResolvedValueOnce(respondWith([{id: 'a', is_closed: 1}]));

    const start = Date.parse('2026-11-03T06:00:00Z');
    const now = vi.spyOn(Date, 'now').mockReturnValue(start);
    const first = await park.getShowData();

    now.mockReturnValue(start + (LIVE_TTL_SECONDS + 1) * 1000);
    const second = await park.getShowData();

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(first[0].is_closed).toBe(0);
    expect(second[0].is_closed).toBe(1);
  });

  it('still answers from the method cache inside the 60 s window', async () => {
    const park = new UniversalStudiosBeijing();
    const fetch = vi.spyOn(park, 'fetchShowData').mockResolvedValue(respondWith([{id: 'b'}]));

    const start = Date.parse('2026-11-03T06:00:00Z');
    const now = vi.spyOn(Date, 'now').mockReturnValue(start);
    await park.getShowData();
    now.mockReturnValue(start + 30 * 1000);
    await park.getShowData();

    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

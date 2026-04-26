import {describe, expect, it} from 'vitest';
import {
  DLP_NON_QUEUE_STANDALONE_ATTRACTION_IDS,
  dlpPoiEmitsQueueLiveData,
} from '../disneylandparis.js';

const DISCOVERY_ARCADE = '7d90d4e6-8c15-44ee-9e94-feb07788f02f';

describe('DLP queue live data gating', () => {
  it('exports five map-only standalone attraction ids', () => {
    expect(DLP_NON_QUEUE_STANDALONE_ATTRACTION_IDS.size).toBe(5);
    for (const id of DLP_NON_QUEUE_STANDALONE_ATTRACTION_IDS) {
      expect(
        dlpPoiEmitsQueueLiveData({category: 'Attraction', id}),
      ).toBe(false);
    }
  });

  it('matches discovery arcade case-insensitively', () => {
    const variants = [
      DISCOVERY_ARCADE.toUpperCase(),
      '7D90D4E6-8C15-44EE-9E94-FEB07788F02F',
      '7d90D4E6-8C15-44Ee-9E94-feb07788F02f',
    ];
    for (const id of variants) {
      expect(dlpPoiEmitsQueueLiveData({category: 'Attraction', id})).toBe(
        false,
      );
    }
  });

  it('does not block an arbitrary other attraction id', () => {
    const other = 'a0000000-0000-4000-8000-000000000001';
    expect(
      dlpPoiEmitsQueueLiveData({category: 'Attraction', id: other}),
    ).toBe(true);
  });

  it('only excludes when category is Attraction; same uuid as Entertainment or Restaurant is allowed', () => {
    for (const id of DLP_NON_QUEUE_STANDALONE_ATTRACTION_IDS) {
      expect(
        dlpPoiEmitsQueueLiveData({category: 'Entertainment', id}),
      ).toBe(true);
      expect(
        dlpPoiEmitsQueueLiveData({category: 'Restaurant', id}),
      ).toBe(true);
    }
  });
});

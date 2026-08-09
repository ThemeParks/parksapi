import {describe, test, expect} from 'vitest';
import {mapQueueStatus} from '../universalstudiosjapan.js';

// USJ shows and attractions share one status vocabulary. The show path used to
// map with a naive `status === 'OPEN' ? 'OPERATING' : 'CLOSED'`, which reported
// a merely-delayed show as CLOSED while it still listed a full day of ENABLED
// performances. It now reuses mapQueueStatus, so a delayed show reads DOWN.
describe('USJ mapQueueStatus (shared by attractions and shows)', () => {
  test('OPEN → OPERATING', () => {
    expect(mapQueueStatus('OPEN')).toBe('OPERATING');
  });

  // Regression: the reported Universal bug class — delayed ≠ closed.
  test('BRIEF_DELAY / WEATHER_DELAY → DOWN (delayed, not closed)', () => {
    expect(mapQueueStatus('BRIEF_DELAY')).toBe('DOWN');
    expect(mapQueueStatus('WEATHER_DELAY')).toBe('DOWN');
  });

  test('CLOSED / N/A → CLOSED', () => {
    expect(mapQueueStatus('CLOSED')).toBe('CLOSED');
    expect(mapQueueStatus('N/A')).toBe('CLOSED');
  });

  test('unknown status → CLOSED (safe default)', () => {
    expect(mapQueueStatus('SOMETHING_NEW')).toBe('CLOSED');
  });
});

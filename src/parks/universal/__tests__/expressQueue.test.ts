/**
 * Test Universal EXPRESS queue type handling.
 *
 * Universal's API returns EXPRESS queue entries for Express Pass (paid skip-the-line).
 * - queue.status is unreliable (always CLOSED even when available)
 * - display_wait_time !== 995 means Express is available
 * - 995 is the sentinel for "unavailable"
 * - Wait time values are unreliable, report null
 */

import { describe, test, expect } from 'vitest';

/**
 * Simulate the queue processing logic from Universal's buildLiveData.
 * This mirrors the switch statement at universal.ts ~line 674.
 */
function processQueue(queue: { queue_type: string; status: string; display_wait_time?: number }, hasRider?: boolean) {
  const result: Record<string, any> = {};

  switch (queue.queue_type) {
    case 'STANDBY':
      if (queue.status === 'OPEN' || queue.status === 'RIDE_NOW') {
        result.STANDBY = { waitTime: queue.display_wait_time ?? (queue.status === 'RIDE_NOW' ? 0 : undefined) };
      }
      break;

    case 'SINGLE':
      if (hasRider && queue.status === 'OPEN') {
        result.SINGLE_RIDER = { waitTime: null };
      }
      break;

    case 'EXPRESS':
      // Express Pass — status field unreliable (always CLOSED).
      // display_wait_time !== 995 means Express is available.
      // Wait time values are unreliable, report null.
      if (queue.display_wait_time !== undefined && queue.display_wait_time !== 995) {
        result.PAID_STANDBY = { waitTime: null };
      }
      break;
  }

  return result;
}

describe('Universal EXPRESS queue handling', () => {
  test('EXPRESS with valid display_wait_time produces PAID_STANDBY with null waitTime', () => {
    const result = processQueue({
      queue_type: 'EXPRESS',
      status: 'CLOSED', // status is unreliable, always CLOSED
      display_wait_time: 45,
    });

    expect(result.PAID_STANDBY).toBeDefined();
    expect(result.PAID_STANDBY.waitTime).toBeNull();
  });

  test('EXPRESS with 995 sentinel does NOT produce PAID_STANDBY', () => {
    const result = processQueue({
      queue_type: 'EXPRESS',
      status: 'CLOSED',
      display_wait_time: 995,
    });

    expect(result.PAID_STANDBY).toBeUndefined();
  });

  test('EXPRESS with undefined display_wait_time does NOT produce PAID_STANDBY', () => {
    const result = processQueue({
      queue_type: 'EXPRESS',
      status: 'OPEN', // even with OPEN status, no wait time = not available
      display_wait_time: undefined,
    });

    expect(result.PAID_STANDBY).toBeUndefined();
  });

  test('EXPRESS with 0 wait time produces PAID_STANDBY (0 is valid, not sentinel)', () => {
    const result = processQueue({
      queue_type: 'EXPRESS',
      status: 'CLOSED',
      display_wait_time: 0,
    });

    expect(result.PAID_STANDBY).toBeDefined();
    expect(result.PAID_STANDBY.waitTime).toBeNull();
  });
});

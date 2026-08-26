import {describe, it, expect} from 'vitest';
import {buildCaptureRows} from '../capture.js';

/**
 * Pure formatting logic for the retirement-gate calibration capture
 * (parksapi #74 / #83). One JSONL row per live-data entity per poll, so a
 * gap analysis can later ask "how long was id X actually missing before it
 * either came back or got force-closed".
 */
describe('buildCaptureRows', () => {
  it('emits one row per live entity with id, status and showtime count', () => {
    const rows = buildCaptureRows(
      'disneylandparis',
      [
        {id: 'P1GS42', status: 'OPERATING', showtimes: [{startTime: 'a', endTime: 'b', type: 'Performance Time'}]},
        {id: 'P1RA00', status: 'CLOSED'},
      ] as any,
      '2026-08-19T09:00:00.000Z',
    );

    expect(rows).toEqual([
      {ts: '2026-08-19T09:00:00.000Z', parksApiId: 'disneylandparis', id: 'P1GS42', status: 'OPERATING', showtimeCount: 1},
      {ts: '2026-08-19T09:00:00.000Z', parksApiId: 'disneylandparis', id: 'P1RA00', status: 'CLOSED', showtimeCount: 0},
    ]);
  });

  it('treats a missing status as null rather than omitting the field', () => {
    const rows = buildCaptureRows('shanghaidisneylandresort', [{id: 'x'}] as any, '2026-08-19T09:00:00.000Z');
    expect(rows[0].status).toBeNull();
  });
});

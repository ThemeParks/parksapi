/**
 * Test createStatusMap helper
 */
import { describe, test, expect, vi } from 'vitest';
import { createStatusMap } from '../statusMap.js';

describe('createStatusMap', () => {
  test('maps known status strings to standard statuses', () => {
    const mapStatus = createStatusMap({
      OPERATING: ['open', 'opened'],
      DOWN: ['temp closed'],
      CLOSED: ['closed', ''],
      REFURBISHMENT: ['maintenance'],
    });

    expect(mapStatus('open')).toBe('OPERATING');
    expect(mapStatus('opened')).toBe('OPERATING');
    expect(mapStatus('temp closed')).toBe('DOWN');
    expect(mapStatus('closed')).toBe('CLOSED');
    expect(mapStatus('')).toBe('CLOSED');
    expect(mapStatus('maintenance')).toBe('REFURBISHMENT');
  });

  test('is case-insensitive', () => {
    const mapStatus = createStatusMap({
      OPERATING: ['Open'],
      CLOSED: ['Closed'],
    });

    expect(mapStatus('OPEN')).toBe('OPERATING');
    expect(mapStatus('open')).toBe('OPERATING');
    expect(mapStatus('Open')).toBe('OPERATING');
    expect(mapStatus('CLOSED')).toBe('CLOSED');
  });

  test('returns default for unknown status', () => {
    const mapStatus = createStatusMap({
      OPERATING: ['open'],
    });

    expect(mapStatus('something_new')).toBe('CLOSED');
  });

  test('custom default status', () => {
    const mapStatus = createStatusMap({
      OPERATING: ['open'],
    }, { defaultStatus: 'OPERATING' });

    expect(mapStatus('unknown')).toBe('OPERATING');
  });

  test('logs warning for unknown status by default', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const mapStatus = createStatusMap({
      OPERATING: ['open'],
    }, { parkName: 'TestPark' });

    mapStatus('weird_state');

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('TestPark'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('weird_state'));
    warnSpy.mockRestore();
  });

  test('suppresses warning when logUnknown is false', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const mapStatus = createStatusMap({
      OPERATING: ['open'],
    }, { logUnknown: false });

    mapStatus('weird_state');

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test('handles null/undefined input', () => {
    const mapStatus = createStatusMap({
      OPERATING: ['open'],
    });

    expect(mapStatus(null as any)).toBe('CLOSED');
    expect(mapStatus(undefined as any)).toBe('CLOSED');
  });
});

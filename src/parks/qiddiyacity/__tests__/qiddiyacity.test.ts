/**
 * Unit tests for Qiddiya City's dashboard-derived schedule fallback.
 *
 * The website scrape that normally supplies the weekly hours pattern
 * (getWebsiteSchedule) can be WAF-blocked independently of the API
 * subdomain that supplies activities/live data. These tests cover the
 * pure fallback logic that derives a single-day schedule from the
 * (separately-sourced, unaffected) dashboard endpoint when that happens.
 */
import {describe, test, expect} from 'vitest';
import {parseDashboardHours, buildTodayScheduleFromDashboard} from '../qiddiyacity.js';

const TZ = 'Asia/Riyadh';

describe('parseDashboardHours', () => {
  test('parses a standard AM/PM range with a trailing timezone abbreviation', () => {
    expect(parseDashboardHours('4:00 PM - 12:00 AM KSA')).toEqual({open: '16:00', close: '00:00'});
  });

  test('parses a range entirely within one half of the day', () => {
    expect(parseDashboardHours('10:30 AM - 6:00 PM')).toEqual({open: '10:30', close: '18:00'});
  });

  test('returns null for non-matching strings like "Closed"', () => {
    expect(parseDashboardHours('Closed')).toBeNull();
  });

  test('returns null for empty or missing input', () => {
    expect(parseDashboardHours('')).toBeNull();
    expect(parseDashboardHours(undefined as unknown as string)).toBeNull();
  });
});

describe('buildTodayScheduleFromDashboard', () => {
  const today = new Date('2026-07-19T12:00:00Z');

  test('builds a single OPERATING entry for today from openingHours', () => {
    const dashboard = {parkInfo: {isOpen: true, openingHours: '4:00 PM - 12:00 AM KSA'}};
    const schedule = buildTodayScheduleFromDashboard(dashboard, today, TZ);
    expect(schedule).toHaveLength(1);
    expect(schedule[0].date).toBe('2026-07-19');
    expect(schedule[0].type).toBe('OPERATING');
  });

  test('rolls a midnight closing time over to the next calendar day', () => {
    const dashboard = {parkInfo: {isOpen: true, openingHours: '4:00 PM - 12:00 AM KSA'}};
    const schedule = buildTodayScheduleFromDashboard(dashboard, today, TZ);
    expect(schedule[0].closingTime).toContain('2026-07-20');
  });

  test('returns no schedule when the dashboard reports the park closed', () => {
    const dashboard = {parkInfo: {isOpen: false, openingHours: '4:00 PM - 12:00 AM KSA'}};
    expect(buildTodayScheduleFromDashboard(dashboard, today, TZ)).toEqual([]);
  });

  test('returns no schedule when openingHours is missing or unparseable', () => {
    expect(buildTodayScheduleFromDashboard({parkInfo: {}}, today, TZ)).toEqual([]);
    expect(buildTodayScheduleFromDashboard(undefined, today, TZ)).toEqual([]);
  });
});

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
import {
  parseDashboardHours,
  buildTodayScheduleFromDashboard,
  closesNextDay,
  buildWeeklyScheduleFromMegaMenu,
} from '../qiddiyacity.js';

describe('buildWeeklyScheduleFromMegaMenu', () => {
  const OPEN = {open: '16:00', close: '00:00'};

  test('parses the "Weekdays/Weekends" wording the live site emits (Saudi week)', () => {
    // Weekdays = Sun–Thu, Weekends = Fri–Sat; Mon & Tue closed.
    const schedule = buildWeeklyScheduleFromMegaMenu({
      weekdaysSchedule: 'Weekdays: 4 PM - 12 AM',
      weekendsSchedule: 'Weekends: 4 PM - 12 AM',
      currentWeatherProTips: [{relatedWeather: 'all', proTipText: 'Mondays & Tuesdays'}],
    });
    expect(schedule).toEqual({
      0: OPEN, // Sunday
      3: OPEN, // Wednesday
      4: OPEN, // Thursday
      5: OPEN, // Friday
      6: OPEN, // Saturday
    });
    // Mon (1) and Tue (2) are closed → absent
    expect(schedule[1]).toBeUndefined();
    expect(schedule[2]).toBeUndefined();
  });

  test('still parses legacy day-range wording ("Wed to Fri & Sun", "Saturdays")', () => {
    const schedule = buildWeeklyScheduleFromMegaMenu({
      weekdaysSchedule: 'Wed to Fri & Sun 3 PM - 11 PM',
      weekendsSchedule: 'Saturdays 12 PM - 12 AM',
      currentWeatherProTips: [{relatedWeather: 'all', proTipText: 'Mondays & Tuesdays'}],
    });
    expect(schedule).toEqual({
      0: {open: '15:00', close: '23:00'}, // Sunday
      3: {open: '15:00', close: '23:00'}, // Wednesday
      4: {open: '15:00', close: '23:00'}, // Thursday
      5: {open: '15:00', close: '23:00'}, // Friday
      6: {open: '12:00', close: '00:00'}, // Saturday
    });
  });

  test('returns an empty map for null/empty input', () => {
    expect(buildWeeklyScheduleFromMegaMenu(null)).toEqual({});
    expect(buildWeeklyScheduleFromMegaMenu({})).toEqual({});
  });

  test('does not apply closed days it was not told about', () => {
    const schedule = buildWeeklyScheduleFromMegaMenu({
      weekdaysSchedule: 'Weekdays: 4 PM - 12 AM',
      weekendsSchedule: 'Weekends: 4 PM - 12 AM',
    });
    // No proTip → all 7 days open
    expect(Object.keys(schedule).sort()).toEqual(['0', '1', '2', '3', '4', '5', '6']);
  });
});

const TZ = 'Asia/Riyadh';

describe('closesNextDay', () => {
  test('rolls over for an exact midnight close', () => {
    expect(closesNextDay('16:00', '00:00')).toBe(true);
  });

  test('rolls over for a post-midnight close that is not exactly 00:00', () => {
    // e.g. a Fright Fest night running 4pm-1am — this used to be missed by
    // a check that only fired on an exact "00:00" close.
    expect(closesNextDay('16:00', '01:00')).toBe(true);
  });

  test('does not roll over for a same-day close', () => {
    expect(closesNextDay('10:00', '18:00')).toBe(false);
  });
});

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

  test('rolls a past-midnight closing time (not exactly 00:00) over to the next calendar day', () => {
    const dashboard = {parkInfo: {isOpen: true, openingHours: '4:00 PM - 1:00 AM KSA'}};
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

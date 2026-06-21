import {describe, test, expect} from 'vitest';
import {
  parseBusinessTime,
  stripFantawildStars,
  isFantawildShow,
  type FantawildBusinessTimeResponse,
  type FantawildItem,
} from '../fantawild.js';

const TZ = 'Asia/Shanghai';

describe('parseBusinessTime', () => {
  test('maps a single activated day to an OPERATING entry', () => {
    const json: FantawildBusinessTimeResponse = {
      key: 'k', value: [{
        currentDate: '2026-06-21 00:00:00',
        startTime: '09:30',
        endTime: '18:00',
        isNight: false, isMorrow: false,
        nightStartTime: '', nightEndTime: '',
        activated: true, statusTips: '',
        parkCloseDesc: null, closeRemarkUrl: null, remarkUrl: null,
        stopIntoPark: '',
      }],
    };
    const out = parseBusinessTime(json, TZ);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({date: '2026-06-21', type: 'OPERATING'});
    expect(out[0].openingTime).toBe('2026-06-21T09:30:00+08:00');
    expect(out[0].closingTime).toBe('2026-06-21T18:00:00+08:00');
  });

  test('emits an EXTRA_HOURS entry alongside OPERATING when a night event is configured', () => {
    const json: FantawildBusinessTimeResponse = {
      key: 'k', value: [{
        currentDate: '2026-06-21 00:00:00',
        startTime: '09:30',
        endTime: '21:00',
        isNight: true, isMorrow: false,
        nightStartTime: '15:00', nightEndTime: '21:00',
        activated: true, statusTips: '',
        parkCloseDesc: null, closeRemarkUrl: null, remarkUrl: null,
        stopIntoPark: '20:30',
      }],
    };
    const out = parseBusinessTime(json, TZ);
    expect(out).toHaveLength(2);
    expect(out[0].type).toBe('OPERATING');
    expect(out[1].type).toBe('EXTRA_HOURS');
    expect(out[1].openingTime).toBe('2026-06-21T15:00:00+08:00');
    expect(out[1].closingTime).toBe('2026-06-21T21:00:00+08:00');
  });

  test('skips deactivated entries', () => {
    const json: FantawildBusinessTimeResponse = {
      key: 'k', value: [{
        currentDate: '2026-06-22 00:00:00',
        startTime: '09:30', endTime: '18:00',
        isNight: false, isMorrow: false,
        nightStartTime: '', nightEndTime: '',
        activated: false, statusTips: '',
        parkCloseDesc: null, closeRemarkUrl: null, remarkUrl: null,
        stopIntoPark: '',
      }],
    };
    expect(parseBusinessTime(json, TZ)).toEqual([]);
  });

  test('skips entries with no start/end time even if activated (closed days)', () => {
    const json: FantawildBusinessTimeResponse = {
      key: 'k', value: [{
        currentDate: '2026-06-23 00:00:00',
        startTime: '', endTime: '',
        isNight: false, isMorrow: false,
        nightStartTime: '', nightEndTime: '',
        activated: true, statusTips: '休园',
        parkCloseDesc: null, closeRemarkUrl: null, remarkUrl: null,
        stopIntoPark: '',
      }],
    };
    expect(parseBusinessTime(json, TZ)).toEqual([]);
  });

  test('skips entries with malformed currentDate', () => {
    const json: FantawildBusinessTimeResponse = {
      key: 'k', value: [
        {
          currentDate: 'tomorrow',
          startTime: '09:30', endTime: '18:00',
          isNight: false, isMorrow: false, nightStartTime: '', nightEndTime: '',
          activated: true, statusTips: '',
          parkCloseDesc: null, closeRemarkUrl: null, remarkUrl: null, stopIntoPark: '',
        },
        {
          currentDate: '',
          startTime: '09:30', endTime: '18:00',
          isNight: false, isMorrow: false, nightStartTime: '', nightEndTime: '',
          activated: true, statusTips: '',
          parkCloseDesc: null, closeRemarkUrl: null, remarkUrl: null, stopIntoPark: '',
        },
      ],
    };
    expect(parseBusinessTime(json, TZ)).toEqual([]);
  });

  test('does NOT emit EXTRA_HOURS when isNight is true but night times are empty', () => {
    // Real fixture: API sometimes flips `isNight` flag on days without
    // populating night times. Treat as a normal-hours day.
    const json: FantawildBusinessTimeResponse = {
      key: 'k', value: [{
        currentDate: '2026-06-24 00:00:00',
        startTime: '09:30', endTime: '18:00',
        isNight: true, isMorrow: false,
        nightStartTime: '', nightEndTime: '',
        activated: true, statusTips: '',
        parkCloseDesc: null, closeRemarkUrl: null, remarkUrl: null, stopIntoPark: '',
      }],
    };
    const out = parseBusinessTime(json, TZ);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('OPERATING');
  });

  test('returns [] for null / undefined / empty payloads', () => {
    expect(parseBusinessTime(null, TZ)).toEqual([]);
    expect(parseBusinessTime(undefined, TZ)).toEqual([]);
    expect(parseBusinessTime({key: 'k', value: []}, TZ)).toEqual([]);
  });

  test('rolls closing time onto the next day when it crosses midnight', () => {
    const json: FantawildBusinessTimeResponse = {
      key: 'k', value: [{
        currentDate: '2026-06-21 00:00:00',
        startTime: '18:00', endTime: '00:30',
        isNight: false, isMorrow: false,
        nightStartTime: '', nightEndTime: '',
        activated: true, statusTips: '',
        parkCloseDesc: null, closeRemarkUrl: null, remarkUrl: null, stopIntoPark: '',
      }],
    };
    const out = parseBusinessTime(json, TZ);
    expect(out).toHaveLength(1);
    expect(out[0].openingTime).toBe('2026-06-21T18:00:00+08:00');
    // close should be 2026-06-22, NOT 2026-06-21 (which would be before opening).
    expect(out[0].closingTime).toBe('2026-06-22T00:30:00+08:00');
  });

  test('rolls EXTRA_HOURS closing onto the next day when night event crosses midnight', () => {
    const json: FantawildBusinessTimeResponse = {
      key: 'k', value: [{
        currentDate: '2026-06-21 00:00:00',
        startTime: '09:30', endTime: '21:00',
        isNight: true, isMorrow: false,
        nightStartTime: '22:00', nightEndTime: '01:00',
        activated: true, statusTips: '',
        parkCloseDesc: null, closeRemarkUrl: null, remarkUrl: null, stopIntoPark: '',
      }],
    };
    const out = parseBusinessTime(json, TZ);
    expect(out).toHaveLength(2);
    expect(out[0].type).toBe('OPERATING');
    expect(out[0].closingTime).toBe('2026-06-21T21:00:00+08:00');
    expect(out[1].type).toBe('EXTRA_HOURS');
    expect(out[1].openingTime).toBe('2026-06-21T22:00:00+08:00');
    expect(out[1].closingTime).toBe('2026-06-22T01:00:00+08:00');
  });

  test('rolls past month boundary correctly', () => {
    // 2026-06-30 → 2026-07-01 (month rollover).
    const json: FantawildBusinessTimeResponse = {
      key: 'k', value: [{
        currentDate: '2026-06-30 00:00:00',
        startTime: '20:00', endTime: '02:00',
        isNight: false, isMorrow: false,
        nightStartTime: '', nightEndTime: '',
        activated: true, statusTips: '',
        parkCloseDesc: null, closeRemarkUrl: null, remarkUrl: null, stopIntoPark: '',
      }],
    };
    const out = parseBusinessTime(json, TZ);
    expect(out[0].closingTime).toBe('2026-07-01T02:00:00+08:00');
  });

  test('does NOT roll when closing time is strictly after opening', () => {
    const json: FantawildBusinessTimeResponse = {
      key: 'k', value: [{
        currentDate: '2026-06-21 00:00:00',
        startTime: '09:30', endTime: '23:59',
        isNight: false, isMorrow: false,
        nightStartTime: '', nightEndTime: '',
        activated: true, statusTips: '',
        parkCloseDesc: null, closeRemarkUrl: null, remarkUrl: null, stopIntoPark: '',
      }],
    };
    const out = parseBusinessTime(json, TZ);
    expect(out[0].closingTime).toBe('2026-06-21T23:59:00+08:00');
  });

  test('processes a multi-day fixture in the order the API returns it', () => {
    // The API doesn't sort by date — entries arrive in app-storage order.
    // The parser should NOT re-sort; the destination's schedule renderer
    // handles ordering downstream.
    const json: FantawildBusinessTimeResponse = {
      key: 'k', value: [
        {currentDate: '2026-06-21 00:00:00', startTime: '09:30', endTime: '18:00', isNight: false, isMorrow: false, nightStartTime: '', nightEndTime: '', activated: true, statusTips: '', parkCloseDesc: null, closeRemarkUrl: null, remarkUrl: null, stopIntoPark: ''},
        {currentDate: '2026-06-27 00:00:00', startTime: '09:30', endTime: '18:00', isNight: false, isMorrow: false, nightStartTime: '', nightEndTime: '', activated: true, statusTips: '', parkCloseDesc: null, closeRemarkUrl: null, remarkUrl: null, stopIntoPark: ''},
        {currentDate: '2026-06-22 00:00:00', startTime: '09:30', endTime: '17:30', isNight: false, isMorrow: false, nightStartTime: '', nightEndTime: '', activated: true, statusTips: '', parkCloseDesc: null, closeRemarkUrl: null, remarkUrl: null, stopIntoPark: ''},
      ],
    };
    const out = parseBusinessTime(json, TZ);
    expect(out.map(s => s.date)).toEqual(['2026-06-21', '2026-06-27', '2026-06-22']);
  });
});

describe('stripFantawildStars', () => {
  test('strips trailing star glyphs from itemName', () => {
    expect(stripFantawildStars('孟姜女⭐⭐️⭐️⭐')).toBe('孟姜女');
    expect(stripFantawildStars('伴你飞翔⭐⭐️⭐️⭐⭐')).toBe('伴你飞翔');
    expect(stripFantawildStars('女娲补天 ⭐⭐⭐⭐⭐')).toBe('女娲补天');
  });

  test('returns name unchanged when there are no trailing stars', () => {
    expect(stripFantawildStars('魔法城堡')).toBe('魔法城堡');
    expect(stripFantawildStars('Magic Castle')).toBe('Magic Castle');
  });

  test('does NOT strip stars that appear mid-string', () => {
    // Stars only at the END are decorations; an embedded star is part of the name.
    expect(stripFantawildStars('Star⭐Show extra')).toBe('Star⭐Show extra');
  });

  test('handles empty string', () => {
    expect(stripFantawildStars('')).toBe('');
  });
});

const baseItem = (overrides: Partial<FantawildItem> = {}): FantawildItem => ({
  parkId: 19, id: 1, itemName: 'Test', waitTime: 0, itemOpened: true,
  statusStr: null, showTimeList: [], featureList: [], ...overrides,
});

describe('isFantawildShow', () => {
  test('treats single time-range as RIDE (operating hours)', () => {
    expect(isFantawildShow(baseItem({showTimeList: ['09:30-21:00']}))).toBe(false);
  });

  test('treats discrete-time list as SHOW', () => {
    expect(isFantawildShow(baseItem({showTimeList: ['14:00', '15:30']}))).toBe(true);
    expect(isFantawildShow(baseItem({showTimeList: ['10:30', '11:30', '12:30', '13:30']}))).toBe(true);
  });

  test('respects 真人表演 feature tag even with range-shaped times', () => {
    expect(isFantawildShow(baseItem({
      showTimeList: ['09:00-21:00'],
      featureList: ['真人表演', '观赏'],
    }))).toBe(true);
  });

  test('respects 巡游 (parade) feature tag', () => {
    expect(isFantawildShow(baseItem({
      showTimeList: [],
      featureList: ['巡游', '亲子'],
    }))).toBe(true);
  });

  test('returns false when showTimeList is empty and no explicit feature flag', () => {
    expect(isFantawildShow(baseItem({showTimeList: [], featureList: ['亲子']}))).toBe(false);
  });

  test('handles mixed list (range + discrete) by treating it as RIDE', () => {
    // If ANY entry is a range, lean toward attraction hours rather than show times.
    expect(isFantawildShow(baseItem({
      showTimeList: ['09:45-12:15', '13:45', '14:15'],
    }))).toBe(false);
  });
});


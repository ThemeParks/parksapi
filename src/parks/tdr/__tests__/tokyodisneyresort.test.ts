import {describe, test, expect} from 'vitest';
import {mapAttractionStatus} from '../tokyodisneyresort.js';

const NOON_JST_UTC = '2026-06-17T03:00:00.000Z'; // 12:00 JST = parks open

const windowAround = (status: string) => ({
  startAt: '2026-06-17T00:00:00.000Z', // 09:00 JST
  endAt:   '2026-06-17T12:00:00.000Z', // 21:00 JST
  operatingStatus: status,
});

describe('mapAttractionStatus (v7)', () => {
  const now = new Date(NOON_JST_UTC);

  test('top-level CANCEL → CLOSED', () => {
    expect(mapAttractionStatus(
      {facilityCode: '101', facilityStatus: 'CANCEL', operatings: []},
      now,
    )).toBe('CLOSED');
  });

  test('top-level CONFIRM_SCHEDULE → CLOSED', () => {
    expect(mapAttractionStatus(
      {facilityCode: '101', facilityStatus: 'CONFIRM_SCHEDULE'},
      now,
    )).toBe('CLOSED');
  });

  test('top-level CONFIRM_STATUS → DOWN', () => {
    expect(mapAttractionStatus(
      {facilityCode: '101', facilityStatus: 'CONFIRM_STATUS'},
      now,
    )).toBe('DOWN');
  });

  test('top-level CANCEL beats any operatings entry', () => {
    expect(mapAttractionStatus({
      facilityCode: '101',
      facilityStatus: 'CANCEL',
      operatings: [windowAround('OPEN_NOTICE')],
    }, now)).toBe('CLOSED');
  });

  test('OPEN_NOTICE window covering now → OPERATING', () => {
    expect(mapAttractionStatus({
      facilityCode: '101',
      operatings: [windowAround('OPEN_NOTICE')],
    }, now)).toBe('OPERATING');
  });

  test('CLOSE_NOTICE window covering now → DOWN', () => {
    expect(mapAttractionStatus({
      facilityCode: '101',
      operatings: [windowAround('CLOSE_NOTICE')],
    }, now)).toBe('DOWN');
  });

  test('PREPARATION window covering now → CLOSED', () => {
    expect(mapAttractionStatus({
      facilityCode: '101',
      operatings: [windowAround('PREPARATION')],
    }, now)).toBe('CLOSED');
  });

  test('no operatings and no facilityStatus → CLOSED', () => {
    expect(mapAttractionStatus({facilityCode: '101'}, now)).toBe('CLOSED');
  });

  test('now outside every window → CLOSED', () => {
    const beforeOpening = new Date('2026-06-16T22:00:00.000Z'); // 07:00 JST
    expect(mapAttractionStatus({
      facilityCode: '101',
      operatings: [windowAround('OPEN_NOTICE')],
    }, beforeOpening)).toBe('CLOSED');
  });

  test('malformed window dates are skipped, next valid one wins', () => {
    expect(mapAttractionStatus({
      facilityCode: '101',
      operatings: [
        {startAt: 'not-a-date', endAt: '2026-06-17T12:00:00.000Z', operatingStatus: 'OPEN_NOTICE'},
        windowAround('CLOSE_NOTICE'),
      ],
    }, now)).toBe('DOWN');
  });

  test('first matching window wins when multiple overlap', () => {
    expect(mapAttractionStatus({
      facilityCode: '101',
      operatings: [
        windowAround('OPEN_NOTICE'),
        windowAround('CLOSE_NOTICE'),
      ],
    }, now)).toBe('OPERATING');
  });

  test('unknown operatingStatus → CLOSED', () => {
    expect(mapAttractionStatus({
      facilityCode: '101',
      operatings: [{...windowAround('OPEN_NOTICE'), operatingStatus: 'SOMETHING_NEW'}],
    }, now)).toBe('CLOSED');
  });
});

/**
 * Fantawild's item list says what an item is partly through its showTimeList and partly through
 * its height requirement. A height limit written as a number of metres ("适合1.2米或以上",
 * "适合1.2米到2.0米", "适合1.2米或以下") is how a ride states who may board; "适合所有身高" ("suitable
 * for all heights") says nothing. Rides also list discrete dispatch times, so the shape of
 * showTimeList alone cannot tell them from shows.
 *
 * The item rows are real feed rows observed on 2026-10-16, except where a test says it is made up.
 */
import {describe, test, expect} from 'vitest';
import {hasHeightLimit, isFantawildShow, type FantawildItem} from '../fantawild.js';

const baseItem = (overrides: Partial<FantawildItem> = {}): FantawildItem => ({
  parkId: 19, id: 1, itemName: 'Test', waitTime: 0, itemOpened: true,
  statusStr: null, showTimeList: [], featureList: [], ...overrides,
});

describe('hasHeightLimit', () => {
  test.each([
    ['a minimum', '适合1.2米或以上'],
    ['a range', '适合1.2米到2.0米'],
    ['a maximum', '适合1.2米或以下'],
  ])('%s is a limit', (_shape, heightStr) => {
    expect(hasHeightLimit(baseItem({heightStr}))).toBe(true);
  });

  test.each([
    ['all heights', '适合所有身高'],
    ['all heights with a note about small children', '适合所有身高（1.2米以下需家长陪同）'],
    ['a digit that is not a height', '限乘2人'],
    ['an age, not a height', '适合3岁以上'],
    ['the unit without a number', '适合米或以上'],
    ['an empty string', ''],
    ['no value', undefined],
  ])('%s is not a limit', (_shape, heightStr) => {
    // The first two shapes are real; the rest are made up. Only "N米" shapes occur in the feed
    // today, and anything else must leave an item as it was: a missed limit changes nothing,
    // while a false one misclassifies.
    expect(hasHeightLimit(baseItem({heightStr}))).toBe(false);
  });
});

describe('isFantawildShow: height limit', () => {
  // A guest is measured before boarding a ride, so a numeric height limit is evidence of
  // an attraction. The feed also gives rides discrete "HH:MM" dispatch times, which look
  // exactly like show times, and it does so for one park and not another: 飓风飞椅 (a swing
  // ride) lists dispatch times at Tai'an and a single window at Datong.
  // The rows below are real feed rows, observed on 2026-10-16.
  const swingTaian = baseItem({
    parkId: 17, id: 555, itemName: '飓风飞椅【受天气影响】',
    showTimeList: ['10:00', '11:00', '13:00', '14:00', '14:30', '15:00', '15:30', '16:00', '17:00', '18:00', '19:00', '20:00', '20:30'],
    featureList: ['旋转', '惊吓'], heightStr: '适合1.2米或以上',
  });
  const flyingTheatreTaian = baseItem({
    parkId: 17, id: 107, itemName: '飞越极限【飞越中华】',
    showTimeList: ['10:00', '11:30', '12:00', '13:00', '14:00', '15:00', '15:30', '16:00', '16:30', '17:00', '18:00', '19:00', '20:00', '20:40'],
    featureList: ['刺激', 'VR/AR', '科普'], heightStr: '适合1.2米到2.0米',
  });
  // Same ride, published as a single window: already an ATTRACTION without the height.
  const swingDatong = baseItem({
    parkId: 47, id: 561, itemName: '飓风飞椅（室外项目）', showTimeList: ['10:00-20:30'],
    featureList: ['旋转', '刺激', '浪漫'], heightStr: '适合1.4米或以上',
  });

  test('a ride that lists dispatch times is not a SHOW when it has a height limit', () => {
    expect(isFantawildShow(swingTaian)).toBe(false);
    expect(isFantawildShow(flyingTheatreTaian)).toBe(false);
    expect(isFantawildShow(swingDatong)).toBe(false);
  });

  test('"suitable for all heights" is no evidence: discrete times are still a SHOW', () => {
    // Real row: 决战金山寺【水幕实景】 (Fantawild Dreamland Zhengzhou), a water-screen show.
    expect(isFantawildShow(baseItem({
      parkId: 51, id: 414, itemName: '决战金山寺【水幕实景】',
      showTimeList: ['13:30', '14:30', '16:00', '17:00', '18:00', '20:30'],
      featureList: ['观赏', '水花四溅'], heightStr: '适合所有身高',
    }))).toBe(true);
    expect(isFantawildShow(baseItem({showTimeList: ['14:00', '15:30']}))).toBe(true);
  });

  test('every shape of numeric limit counts: a minimum, a range and a maximum', () => {
    const times = ['11:00', '13:00', '15:00'];
    for (const heightStr of ['适合1.2米或以上', '适合1.2米到2.0米', '适合1.2米或以下']) {
      expect(isFantawildShow(baseItem({showTimeList: times, heightStr}))).toBe(false);
    }
  });

  test('a live performance with a 1.0 m minimum is still a SHOW', () => {
    // Real rows: stunt shows beside a splash zone carry a height limit.
    expect(isFantawildShow(baseItem({
      parkId: 21, id: 163, itemName: '水漫金山',
      showTimeList: ['11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '17:40', '18:40', '20:00', '20:30'],
      featureList: ['真人表演', '电影/动画', '水花四溅'], heightStr: '适合1.0米或以上',
    }))).toBe(true);
    expect(isFantawildShow(baseItem({
      parkId: 79, id: 722, itemName: '马六甲勇士',
      showTimeList: ['13:00', '14:00', '15:00', '16:00', '17:00', '18:00', '19:00', '20:00', '20:30', '21:00', '21:30'],
      featureList: ['真人表演', '观赏', '水花四溅'], heightStr: '适合1.0米或以上',
    }))).toBe(true);
  });

  test('a parade or a fireworks show is a SHOW whatever the height says', () => {
    // Made up: no parade or fireworks item in the feed carries a height limit.
    expect(isFantawildShow(baseItem({featureList: ['巡游'], heightStr: '适合1.2米或以上'}))).toBe(true);
    expect(isFantawildShow(baseItem({itemName: '烟花表演秀', showTimeList: ['19:30-20:00'], heightStr: '适合1.2米或以上'}))).toBe(true);
  });

  test('a walk-through with live actors in one all-day window stays an ATTRACTION', () => {
    // Real row: 怨灵诡校 (Dreamland Xiamen) has a 1.1 m minimum and the park's evening window.
    expect(isFantawildShow(baseItem({
      parkId: 31, id: 1429, itemName: '怨灵诡校', showTimeList: ['16:00-20:50'],
      featureList: ['刺激', '惊吓', '真人表演'], heightStr: '适合1.1米或以上',
    }))).toBe(false);
  });
});

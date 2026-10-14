/**
 * Fantawild's item list says what an item is only through the shape of its
 * showTimeList and its feature tags: a parade tag, a live-performance tag, or
 * discrete start times make a SHOW, and a single "HH:MM-HH:MM" window is how an
 * attraction publishes its operating hours.
 *
 * The Taizhou park's 烟花表演秀 (fireworks show) was published as an
 * ATTRACTION. That record is not in the park's item list at the moment, so its
 * tags and times could not be observed. A fireworks display is a show, so the
 * name decides: 烟花 or 焰火 ("fireworks") in it makes the item a SHOW whatever
 * its tags and times. The cases below therefore try several shapes (an evening
 * window, no times, discrete times, a live-performance tag) and expect SHOW for
 * all of them.
 *
 * The near-misses are real names from the parks' lists, except 人间烟火 and
 * 烟雾森林, which are made up. Several carry 焰 or 火 or 烟 without being
 * fireworks: three of the rides are 烈焰神龙, 赤焰小摆锤 and 穿越火焰山.
 *
 * The fireworks record in the entity-list tests, and every id there, is made
 * up.
 */
import {describe, test, expect} from 'vitest';
import {isFantawildShow, type FantawildItem} from '../fantawild.js';

const baseItem = (overrides: Partial<FantawildItem> = {}): FantawildItem => ({
  parkId: 83, id: 1, itemName: 'Test', waitTime: 0, itemOpened: true,
  statusStr: null, showTimeList: [], featureList: [], ...overrides,
});

describe('isFantawildShow: fireworks', () => {
  test('a fireworks show with one evening window is a SHOW', () => {
    expect(isFantawildShow(baseItem({itemName: '烟花表演秀', showTimeList: ['19:30-20:00']}))).toBe(true);
  });

  test('a fireworks show with no times at all is a SHOW', () => {
    expect(isFantawildShow(baseItem({itemName: '烟花表演秀', showTimeList: []}))).toBe(true);
    expect(isFantawildShow(baseItem({itemName: '烟花表演秀', showTimeList: undefined, featureList: undefined}))).toBe(true);
  });

  test('a fireworks show with discrete times is still a SHOW', () => {
    expect(isFantawildShow(baseItem({itemName: '烟花表演秀', showTimeList: ['20:00', '21:00']}))).toBe(true);
  });

  test('the name wins over the all-day-window rule for a live-performance item', () => {
    expect(isFantawildShow(baseItem({
      itemName: '烟花表演秀', showTimeList: ['09:30-21:00'], featureList: ['真人表演'],
    }))).toBe(true);
  });

  test.each([
    ['the live name', '烟花表演秀'],
    ['the formal word', '焰火晚会'],
    ['with a bracketed label', '【夜间】烟花秀'],
    ['with trailing stars', '烟花表演秀⭐⭐⭐'],
    ['with a trailing filler', '烟花表演秀\u3164'],
    ['inside a longer title', '梦幻之夜·焰火盛典'],
  ])('is recognised by name: %s', (_label, itemName) => {
    expect(isFantawildShow(baseItem({itemName, showTimeList: ['19:30-20:00']}))).toBe(true);
  });

  test.each([
    ['a thrill ride with 焰 in its name', '烈焰神龙【刺激惊险】'],
    ['a pendulum ride', '赤焰小摆锤'],
    ['a flame-mountain ride', '穿越火焰山'],
    ['a lantern ride', '华灯飞旋'],
    ['a flower ride', '转转花'],
    ['another flower ride', '花儿跳跳'],
    ['a plain ride', '飞越狗熊岭'],
    ['a core ride', '森林时光（核心项目）'],
    ['the word for worldly life, not fireworks', '人间烟火'],
    ['smoke only', '烟雾森林'],
    ['an empty name', ''],
  ])('is not recognised by name: %s', (_label, itemName) => {
    expect(isFantawildShow(baseItem({itemName, showTimeList: ['09:30-17:00']}))).toBe(false);
    expect(isFantawildShow(baseItem({itemName, showTimeList: []}))).toBe(false);
  });

  test('a missing name does not throw', () => {
    expect(isFantawildShow(baseItem({itemName: undefined as unknown as string, showTimeList: ['09:30-17:00']}))).toBe(false);
  });
});

describe('Fantawild.buildEntityList: fireworks', () => {
  // Taizhou FT Wild Land (parkId 83). The fireworks record is made up; the
  // other two are live names with their usual shapes.
  const TAIZHOU = 83;
  const fireworks = {parkId: TAIZHOU, id: 99001, itemName: '烟花表演秀', waitTime: 0, itemOpened: true, statusStr: null,
    showTimeList: ['19:30-20:00'], featureList: ['观赏'], latitude: 28.6, longitude: 121.4};
  const teacups = {parkId: TAIZHOU, id: 1374, itemName: '转转杯', waitTime: 0, itemOpened: true, statusStr: null,
    showTimeList: ['09:30-17:00'], featureList: ['旋转', '亲子']};
  const lifeLight = {parkId: TAIZHOU, id: 1354, itemName: '生命之光（座满截止）', waitTime: 0, itemOpened: true, statusStr: null,
    showTimeList: ['10:30', '13:30', '15:30'], featureList: ['3D/4D', '观赏']};

  async function entities(roster: any[]) {
    const {Fantawild} = await import('../fantawild.js');
    const d = new Fantawild({config: {
      baseUrl: 'https://image.fangte.com',
      apiBaseUrl: 'https://leyou.fangte.com',
    }});
    (d as any).getStableRoster = async (parkId: number) => (parkId === TAIZHOU ? roster : []);
    return await (d as any).buildEntityList() as any[];
  }

  test('the fireworks show is a SHOW under its existing id, with no ride subtype', async () => {
    const e = (await entities([fireworks, teacups, lifeLight])).find(x => x.id === 'fantawild_attraction_83_99001');
    expect(e).toMatchObject({
      id: 'fantawild_attraction_83_99001',
      name: '烟花表演秀',
      entityType: 'SHOW',
      parentId: 'fantawild_park_83',
      parkId: 'fantawild_park_83',
    });
    expect(e.attractionType).toBeUndefined();
    expect(e.location).toEqual({latitude: 28.6, longitude: 121.4});
  });

  test('stays a SHOW on a day the feed lists no times, or a different window', async () => {
    for (const showTimeList of [[], ['19:30-20:00'], ['09:30-21:00'], ['20:00']]) {
      const e = (await entities([{...fireworks, showTimeList}])).find(x => x.id === 'fantawild_attraction_83_99001');
      expect(e.entityType).toBe('SHOW');
    }
  });

  test('the rides and the theatre next to it keep their types, and nothing is added or dropped', async () => {
    const all = await entities([fireworks, teacups, lifeLight]);
    const own = all.filter(x => x.parkId === 'fantawild_park_83');
    expect(own.map(x => [x.id, x.entityType, x.attractionType]).sort()).toEqual([
      ['fantawild_attraction_83_1354', 'SHOW', undefined],
      ['fantawild_attraction_83_1374', 'ATTRACTION', 'RIDE'],
      ['fantawild_attraction_83_99001', 'SHOW', undefined],
    ]);
  });
});

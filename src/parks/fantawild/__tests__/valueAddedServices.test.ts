/**
 * Fantawild's item list carries the park's paid add-ons among its rides. The
 * park labels them itself, in the item name, in whichever bracket style the
 * editor used that day:
 *
 *   VR大空间【增值服务】   冰雪城堡(增值服务）   萌宠乐园（增值服务）
 *   冰雪世界[增值服务]     卡丁车【增值服务】<tab>
 *
 * 增值服务 is "value-added service". Dreamland Wuhu (parkId 19) listed five of
 * them in August 2026, among them the boat dock; Oriental Heritage Wuhu
 * (parkId 49) four. They are sold products, not rides, so they are not
 * published.
 *
 * The feed has a sibling label, 增值体验 ("value-added experience"), on real
 * attractions with their own staff and queue: the scare maze 南洋诡校 is one,
 * and is already published as an attraction. It is a different label and stays.
 * So do the other paid-add-on wordings (付费, 商业项目); only the label that
 * names a service is matched.
 *
 * Fixture rows are the live ones, trimmed to the fields the module reads.
 */
import {describe, test, expect, beforeEach} from 'vitest';
import {FANTAWILD_PARKS, Fantawild, isValueAddedService, type FantawildItem} from '../fantawild.js';
import {CacheLib} from '../../../cache.js';

const WUHU = 19;

function row(id: number, itemName: string, extra: Partial<FantawildItem> = {}): FantawildItem {
  return {
    parkId: WUHU, id, itemName, waitTime: 0, itemOpened: true, statusStr: null,
    showTimeList: ['09:00-21:00'], featureList: ['亲子'], latitude: 31.3605, longitude: 118.4575,
    ...extra,
  };
}

// Dreamland Wuhu on 2026-08-29: five value-added services among the rides.
const ROSTER: FantawildItem[] = [
  row(2300, 'VR大空间【增值服务】', {featureList: ['适合儿童', '亲子', 'VR/AR']}),
  row(2200, '冰雪城堡(增值服务）', {featureList: ['适合儿童', '亲子', '浪漫']}),
  row(2199, '萌宠乐园（增值服务）', {featureList: ['舒缓']}),
  row(52, '游船码头（增值服务）', {featureList: ['舒缓', '亲子', '漂流']}),
  row(2296, '卡丁车【增值服务】', {featureList: ['高科技体验', '不受天气影响']}),
  // Rides and a show from the same payload.
  row(42, '极速飞车（三环过山车）', {featureList: ['旋转', '刺激', '急速升降']}),
  row(1235, '小漂流', {featureList: ['舒缓', '漂流']}),
  row(47, '生命之光', {showTimeList: ['10:30', '13:30', '16:00'], featureList: ['电影/动画', '观赏', '科普']}),
  // Sibling labels from other parks, which must stay published.
  row(2016, '南洋诡校（增值体验）', {featureList: ['刺激', '惊吓', '真人表演']}),
  row(1927, '【增值体验】末日危机', {featureList: ['亲子', '黑暗', '不受天气影响']}),
  row(1877, '风火轮卡丁车【增值体验', {featureList: ['刺激']}),
  row(1965, '奇幻之旅【付费】', {featureList: ['VR/AR']}),
  row(1409, '极速卡丁车（商业项目）', {featureList: ['刺激']}),
];

const PUBLISHED_IDS = [42, 1235, 47, 2016, 1927, 1877, 1965, 1409].map(id => `fantawild_attraction_${WUHU}_${id}`).sort();
const DROPPED_IDS = [2300, 2200, 2199, 52, 2296].map(id => `fantawild_attraction_${WUHU}_${id}`).sort();

describe('isValueAddedService', () => {
  test.each([
    ['VR大空间【增值服务】'],
    ['冰雪城堡(增值服务）'],           // ASCII bracket opens, full-width closes
    ['萌宠乐园（增值服务）'],
    ['冰雪世界[增值服务]'],
    ['高空蹦极【增值服务】\t'],         // trailing tab, as published
    ['卡丁车【增值服务】\t\t'],
    ['【增值服务】卡丁车'],             // label in front
    ['探洞秘境 增值服务'],              // no brackets at all
  ])('%j is a value-added service', name => {
    expect(isValueAddedService(name)).toBe(true);
  });

  test.each([
    ['南洋诡校（增值体验）'],           // value-added EXPERIENCE: a real attraction
    ['【增值体验】水上游船'],
    ['风火轮卡丁车【增值体验'],         // unclosed bracket, as published
    ['奇幻之旅【付费】'],               // "paid"
    ['极速卡丁车（商业项目）'],         // "commercial project"
    ['游客服务中心'],                   // a service centre, not the label
    ['游船码头'],                       // the same dock without the label
    ['极速飞车（三环过山车）'],
    ['生命之光'],
    [''],
  ])('%j is not', name => {
    expect(isValueAddedService(name)).toBe(false);
  });

  test('tolerates a missing name', () => {
    expect(isValueAddedService(undefined as unknown as string)).toBe(false);
    expect(isValueAddedService(null as unknown as string)).toBe(false);
  });
});

describe('Fantawild publishes no value-added services', () => {
  beforeEach(() => {
    CacheLib.clearAll();
  });

  function park(roster: FantawildItem[]): any {
    const d: any = new Fantawild({config: {
      baseUrl: 'https://image.fangte.com',
      apiBaseUrl: 'https://leyou.fangte.com',
    }});
    d.getStableRoster = async (parkId: number) => (parkId === WUHU ? roster : []);
    d.getItems = async (parkId: number) => (parkId === WUHU ? roster : []);
    d.getSchedule = async () => [];
    return d;
  }

  const wuhuAttractions = (entities: any[]) =>
    entities.filter(e => e.parkId === `fantawild_park_${WUHU}`).map(e => e.id).sort();

  test('the five services are absent from the entity list', async () => {
    const ids = wuhuAttractions(await park(ROSTER).buildEntityList());
    for (const id of DROPPED_IDS) expect(ids).not.toContain(id);
  });

  test('every other item keeps its id, name and type', async () => {
    const entities: any[] = await park(ROSTER).buildEntityList();
    expect(wuhuAttractions(entities)).toEqual(PUBLISHED_IDS);

    const byId = (id: number) => entities.find(e => e.id === `fantawild_attraction_${WUHU}_${id}`);
    expect(byId(42)).toMatchObject({name: '极速飞车（三环过山车）', entityType: 'ATTRACTION', attractionType: 'RIDE'});
    expect(byId(47)).toMatchObject({name: '生命之光', entityType: 'SHOW'});
    // The value-added EXPERIENCE label is a different label.
    expect(byId(2016)).toMatchObject({name: '南洋诡校（增值体验）', entityType: 'ATTRACTION'});
    expect(byId(1927)?.name).toBe('【增值体验】末日危机');
  });

  test('the park, the destination and the other parks are untouched', async () => {
    const entities: any[] = await park(ROSTER).buildEntityList();
    expect(entities.filter(e => e.entityType === 'DESTINATION')).toHaveLength(FANTAWILD_PARKS.length);
    expect(entities.filter(e => e.entityType === 'PARK')).toHaveLength(FANTAWILD_PARKS.length);
  });

  test('no live data is emitted for a service, and the rides keep theirs', async () => {
    const live: any[] = await park(ROSTER).buildLiveData();
    const ids = live.map(l => l.id).sort();
    for (const id of DROPPED_IDS) expect(ids).not.toContain(id);
    expect(ids).toEqual(PUBLISHED_IDS);
  });

  test('a service that later loses its label is published under its own id', async () => {
    // 卡丁车 (item 2296) was renamed to plain 卡丁车 in September.
    const renamed = ROSTER.map(r => (r.id === 2296 ? {...r, itemName: '卡丁车'} : r));
    const entities: any[] = await park(renamed).buildEntityList();
    expect(entities.find(e => e.id === `fantawild_attraction_${WUHU}_2296`)).toMatchObject({
      name: '卡丁车', entityType: 'ATTRACTION',
    });
  });
});

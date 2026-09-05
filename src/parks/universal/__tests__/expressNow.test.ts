/**
 * Express Now `/get-offers` parser regression tests.
 *
 * The reference payload is the literal first real sample observed on the
 * live endpoint (Spider-Man, Mardi Gras late-close window). The wire
 * format reports every numeric field as a string — drift here would
 * silently produce NaN / wrong-currency-amount, so pinning is worth it.
 */
import {describe, test, expect, beforeEach} from 'vitest';
import {parseExpressNowResponse, UniversalOrlando} from '../universal.js';
import {CacheLib} from '../../../cache.js';

const SAMPLE_PAYLOAD = {
  predictions: [{
    offer_id: 'udx.uor.expressnow.offer1',
    place_id: 'uor.ioa.rides.the_amazing_adventures_of_spider_man',
    inventory_time_slot: '2026-05-07T00:31:00',
    inventory_time_minutes: '28',
    return_time_detail_id: '445292',
    product_price: '39.99',
    max_quantity: '15',
    detail_content_id: '170110100027-ExpressNow-0000',
    vl_inventory: '1',
  }],
};

describe('parseExpressNowResponse', () => {
  test('parses the first observed real sample', () => {
    const out = parseExpressNowResponse(SAMPLE_PAYLOAD);
    const placeId = 'uor.ioa.rides.the_amazing_adventures_of_spider_man';

    expect(Object.keys(out)).toEqual([placeId]);
    expect(out[placeId]).toEqual({
      offer_id: 'udx.uor.expressnow.offer1',
      place_id: placeId,
      inventory_time_slot: '2026-05-07T00:31:00',
      inventory_time_minutes: 28,
      product_price: 39.99,
      vl_inventory: 1,
    });
  });

  test('product_price * 100 rounds cleanly to cents (no float drift)', () => {
    const out = parseExpressNowResponse(SAMPLE_PAYLOAD);
    const placeId = 'uor.ioa.rides.the_amazing_adventures_of_spider_man';
    // 39.99 * 100 = 3998.9999999999995 in IEEE-754 — Math.round saves us.
    expect(Math.round(out[placeId].product_price * 100)).toBe(3999);
  });

  test('empty / non-array predictions → empty object', () => {
    expect(parseExpressNowResponse({})).toEqual({});
    expect(parseExpressNowResponse({predictions: null})).toEqual({});
    expect(parseExpressNowResponse({predictions: 'not-an-array'})).toEqual({});
    expect(parseExpressNowResponse(null)).toEqual({});
  });

  test('skips entries without place_id or offer_id', () => {
    const ok = {offer_id: 'ok', inventory_time_slot: '2026-05-07T10:00:00', inventory_time_minutes: '5', product_price: '1.00', vl_inventory: '1'};
    const out = parseExpressNowResponse({
      predictions: [
        {...ok, place_id: null},
        {...ok}, // no place_id
        {...ok, place_id: 'uor.no.offer', offer_id: undefined},
        {...ok, place_id: 'uor.empty.offer', offer_id: ''},
        {...ok, place_id: 'uor.ride.one'},
      ],
    });
    expect(Object.keys(out)).toEqual(['uor.ride.one']);
  });

  test('skips entries with NaN price or minutes (malformed strings)', () => {
    const base = {offer_id: 'x', inventory_time_slot: '2026-05-07T10:00:00'};
    const out = parseExpressNowResponse({
      predictions: [
        {...base, place_id: 'uor.bad.price', inventory_time_minutes: '5', product_price: 'not-a-number', vl_inventory: '1'},
        {...base, place_id: 'uor.bad.mins', inventory_time_minutes: '', product_price: '5.00', vl_inventory: '1'},
        {...base, place_id: 'uor.bad.inv', inventory_time_minutes: '5', product_price: '5.00', vl_inventory: 'NaN'},
      ],
    });
    expect(out).toEqual({});
  });

  test('skips entries with missing or malformed inventory_time_slot', () => {
    const base = {
      offer_id: 'x',
      inventory_time_minutes: '5',
      product_price: '5.00',
      vl_inventory: '1',
    };
    const out = parseExpressNowResponse({
      predictions: [
        {...base, place_id: 'uor.no.slot'},
        {...base, place_id: 'uor.null.slot', inventory_time_slot: null},
        {...base, place_id: 'uor.empty.slot', inventory_time_slot: ''},
        {...base, place_id: 'uor.garbage.slot', inventory_time_slot: 'not-a-timestamp'},
        {...base, place_id: 'uor.with.tz', inventory_time_slot: '2026-05-07T10:00:00Z'}, // we want naive form only
        {...base, place_id: 'uor.ok', inventory_time_slot: '2026-05-07T10:00:00'},
      ],
    });
    expect(Object.keys(out)).toEqual(['uor.ok']);
  });

  test('keeps earliest slot when multiple offers share a place_id', () => {
    const out = parseExpressNowResponse({
      predictions: [
        {place_id: 'uor.ride.x', offer_id: 'late', inventory_time_slot: '2026-05-07T18:00:00', inventory_time_minutes: '30', product_price: '20.00', vl_inventory: '5'},
        {place_id: 'uor.ride.x', offer_id: 'early', inventory_time_slot: '2026-05-07T11:00:00', inventory_time_minutes: '30', product_price: '15.00', vl_inventory: '5'},
        {place_id: 'uor.ride.x', offer_id: 'mid', inventory_time_slot: '2026-05-07T14:00:00', inventory_time_minutes: '30', product_price: '17.00', vl_inventory: '5'},
      ],
    });
    expect(out['uor.ride.x'].offer_id).toBe('early');
    expect(out['uor.ride.x'].product_price).toBe(15);
  });
});

describe('getExpressNowOffers cache discipline', () => {
  beforeEach(async () => {
    await CacheLib.clearByClassName('UniversalOrlando');
  });

  test('an unconfigured instance does not cache {} over a configured one', async () => {
    // The "not configured" guard used to sit inside @cache, so a single
    // unconfigured construction wrote {} under the key a configured instance
    // reads back — blinding it for the full 600s empty-result TTL. Same
    // defect, and the same fix, as getEventNights.
    const unconfigured: any = new UniversalOrlando({config: {udxBase: ''}} as any);
    let unconfiguredFetched = 0;
    unconfigured.fetchExpressNowOffers = async () => {
      unconfiguredFetched++;
      return {json: async () => SAMPLE_PAYLOAD};
    };
    await expect(unconfigured.getExpressNowOffers()).resolves.toEqual({});
    expect(unconfiguredFetched).toBe(0);

    const configured: any = new UniversalOrlando({
      config: {udxBase: 'https://example.invalid', parkLatitude: '28.4', parkLongitude: '-81.4'},
    } as any);
    configured.fetchExpressNowOffers = async () => ({json: async () => SAMPLE_PAYLOAD});
    const offers = await configured.getExpressNowOffers();
    expect(Object.keys(offers)).toHaveLength(1);
  });

  test('a configured instance still caches its result', async () => {
    const configured: any = new UniversalOrlando({
      config: {udxBase: 'https://example.invalid', parkLatitude: '28.4', parkLongitude: '-81.4'},
    } as any);
    let fetched = 0;
    configured.fetchExpressNowOffers = async () => {
      fetched++;
      return {json: async () => SAMPLE_PAYLOAD};
    };
    await configured.getExpressNowOffers();
    await configured.getExpressNowOffers();
    expect(fetched).toBe(1);
  });
});

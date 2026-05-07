/**
 * Express Now `/get-offers` parser regression tests.
 *
 * The reference payload is the literal first real sample observed on the
 * live endpoint (Spider-Man, Mardi Gras late-close window). The wire
 * format reports every numeric field as a string — drift here would
 * silently produce NaN / wrong-currency-amount, so pinning is worth it.
 */
import {describe, test, expect} from 'vitest';
import {parseExpressNowResponse} from '../universal.js';

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

  test('skips entries without place_id', () => {
    const out = parseExpressNowResponse({
      predictions: [
        {place_id: null, inventory_time_minutes: '5', product_price: '1.00', vl_inventory: '1'},
        {inventory_time_minutes: '5', product_price: '1.00', vl_inventory: '1'},
        {place_id: 'uor.ride.one', inventory_time_slot: '2026-05-07T10:00:00', inventory_time_minutes: '5', product_price: '1.00', vl_inventory: '1'},
      ],
    });
    expect(Object.keys(out)).toEqual(['uor.ride.one']);
  });

  test('skips entries with NaN price or minutes (malformed strings)', () => {
    const out = parseExpressNowResponse({
      predictions: [
        {place_id: 'uor.bad.price', inventory_time_slot: '2026-05-07T10:00:00', inventory_time_minutes: '5', product_price: 'not-a-number', vl_inventory: '1'},
        {place_id: 'uor.bad.mins', inventory_time_slot: '2026-05-07T10:00:00', inventory_time_minutes: '', product_price: '5.00', vl_inventory: '1'},
      ],
    });
    expect(out).toEqual({});
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

import {describe, test, expect} from 'vitest';
import {validateQueueEntry} from '../live.js';

/**
 * `npm run audit:live` is the only thing that actually checks queue output —
 * the virtualQueue validators it replaced were never wired into anything.
 *
 * They were also wrong. They required `returnStart`/`returnEnd` whenever a
 * queue was AVAILABLE, which Tokyo Disney Resort violates on every single
 * poll: its return windows are gated behind a login upstream, so they are
 * legitimately null while the queue is genuinely available. Universal
 * frequently publishes a start with no end. Enforcing presence would have
 * meant a permanent wall of false alarms, which is the likeliest reason
 * nobody ever connected them.
 *
 * So these tests pin the distinction that matters: a value that is ABSENT is
 * fine, a value that is IMPOSSIBLE is not.
 */

const errorsOf = (type: string, queue: unknown) =>
  validateQueueEntry(type, queue, 'q').filter((i) => i.level === 'error').map((i) => i.message);

describe('validateQueueEntry — shapes parks really emit', () => {
  test.each([
    ['Tokyo Priority Pass, ticketing', 'RETURN_TIME',
      {state: 'AVAILABLE', returnStart: null, returnEnd: null}],
    ['Tokyo Premier Access, selling', 'PAID_RETURN_TIME',
      {state: 'AVAILABLE', returnStart: null, returnEnd: null, price: {currency: 'JPY', amount: null}}],
    ['Universal Express, start but no end', 'PAID_RETURN_TIME',
      {state: 'AVAILABLE', returnStart: '2026-09-01T14:00:00-04:00', returnEnd: null, price: {currency: 'USD', amount: 2500}}],
    ['Disneyland Paris, full window and price', 'PAID_RETURN_TIME',
      {state: 'AVAILABLE', returnStart: '2026-09-01T14:00:00+02:00', returnEnd: '2026-09-01T15:00:00+02:00', price: {currency: 'EUR', amount: 1200}}],
    ['a boarding group with no numbers yet', 'BOARDING_GROUP',
      {allocationStatus: 'AVAILABLE', currentGroupStart: null, currentGroupEnd: null, estimatedWait: null}],
  ])('%s is not an error', (_label, type, queue) => {
    expect(errorsOf(type, queue)).toEqual([]);
  });
});

describe('validateQueueEntry — shapes that cannot be true', () => {
  test('a return window that ends before it starts', () => {
    expect(errorsOf('PAID_RETURN_TIME', {
      state: 'AVAILABLE',
      returnStart: '2026-09-01T15:00:00+02:00',
      returnEnd: '2026-09-01T14:00:00+02:00',
      price: {currency: 'EUR', amount: 1200},
    })).toContain('returnEnd must be after returnStart');
  });

  test('a zero-length return window', () => {
    expect(errorsOf('RETURN_TIME', {
      state: 'AVAILABLE',
      returnStart: '2026-09-01T14:00:00+02:00',
      returnEnd: '2026-09-01T14:00:00+02:00',
    })).toContain('returnEnd must be after returnStart');
  });

  test('a currency that is not a 3-letter code', () => {
    expect(errorsOf('PAID_RETURN_TIME', {
      state: 'AVAILABLE', returnStart: null, returnEnd: null,
      price: {currency: 'Euros', amount: 100},
    })).toContain('currency "Euros" must be a 3-letter ISO 4217 code');
  });

  test('a boarding range that counts backwards', () => {
    expect(errorsOf('BOARDING_GROUP', {
      allocationStatus: 'AVAILABLE', currentGroupStart: 80, currentGroupEnd: 40,
    })).toContain('currentGroupEnd must be >= currentGroupStart');
  });

  test('a negative estimated wait', () => {
    expect(errorsOf('BOARDING_GROUP', {
      allocationStatus: 'AVAILABLE', currentGroupStart: 10, currentGroupEnd: 20, estimatedWait: -5,
    })).toContain('estimatedWait must not be negative');
  });

  /** A single boarding group is a range of one, not backwards. */
  test('an equal boarding range is allowed', () => {
    expect(errorsOf('BOARDING_GROUP', {
      allocationStatus: 'AVAILABLE', currentGroupStart: 42, currentGroupEnd: 42,
    })).toEqual([]);
  });
});

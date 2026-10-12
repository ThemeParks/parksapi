import {describe, test, expect} from 'vitest';
import {mapStatus} from '../everland.js';

// DOWN means "meant to be running and is not": a weather hold, an inspection.
// CLOSED means "not meant to be running": a seasonal suspension, a private hire.
// A ride the park has suspended for the whole season is not interrupted, so it
// must never read DOWN.
describe('Everland operStatusCd mapping', () => {
  test.each([
    ['OPEN', 'OPERATING'],
    ['RSVP', 'OPERATING'],
  ])('%s is %s', (code, expected) => {
    expect(mapStatus(code)).toBe(expected);
  });

  test.each([
    ['RAIN', 'heavy rain'],
    ['SNOW', 'snow'],
    ['THUN', 'thunderstorm'],
    ['WIND', 'heavy wind'],
    ['LTMP', 'low temperature'],
    ['HTMP', 'high temperature'],
    ['PMCH', 'PM inspection'],
  ])('%s (%s) is DOWN', (code) => {
    expect(mapStatus(code)).toBe('DOWN');
  });

  test.each([
    ['SMMR', 'summer suspension'],
    ['WNTR', 'winter suspension'],
    ['RNTR', 'suspension by renting (private event)'],
    ['CLOS', 'closed'],
    ['OVER', 'over'],
    ['STND', 'standby'],
    ['PEND', 'pending'],
  ])('%s (%s) is CLOSED', (code) => {
    expect(mapStatus(code)).toBe('CLOSED');
  });

  test('CONR is REFURBISHMENT', () => {
    expect(mapStatus('CONR')).toBe('REFURBISHMENT');
  });

  test.each(['', 'ZZZZ', 'open'])('an unknown or malformed code %j is CLOSED, never a guess at open', (code) => {
    expect(mapStatus(code)).toBe('CLOSED');
  });
});

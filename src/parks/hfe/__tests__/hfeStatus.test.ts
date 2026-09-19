import {describe, test, expect} from 'vitest';
import {mapHfeRideStatus} from '../hfe.js';

/**
 * The ride status mapping, asserted against the real mapper.
 *
 * This park had no test directory at all, and the mapping lived as an
 * if/else chain inside buildLiveData, so the only coverage anywhere was a
 * table in src/__tests__/parkEdgeCases.test.ts that asserted its own values
 * against a regex and never called this module.
 *
 * That table was WRONG, and wrong in the direction that matters. It claimed:
 *
 *   'TEMPORARILY CLOSED': 'DOWN'
 *   'TEMPORARILY DELAYED': 'DOWN'
 *
 * unconditionally. Both are gated on `parkIsOpen`. A reader of that table
 * would conclude this park reports DOWN overnight; it reports CLOSED, and
 * should, because DOWN claims something is wrong with the attraction and
 * outside operating hours nothing is wrong, it is shut.
 */
describe('mapHfeRideStatus', () => {
  const OPEN = true;
  const SHUT = false;

  describe('explicit closures', () => {
    test.each(['CLOSED', 'CLOSED FOR THE DAY', 'UNKNOWN'])(
      '%s is CLOSED whether the park is open or not',
      (status) => {
        expect(mapHfeRideStatus(status, '', null, OPEN).status).toBe('CLOSED');
        expect(mapHfeRideStatus(status, '', null, SHUT).status).toBe('CLOSED');
      },
    );

    test('matching is case-insensitive', () => {
      expect(mapHfeRideStatus('closed for the day', '', null, OPEN).status).toBe('CLOSED');
      // The discriminating case. A lowercase closure still lands on CLOSED
      // via the final fallthrough even with toUpperCase() removed, so it
      // proves nothing on its own; a lowercase DELAY does.
      expect(mapHfeRideStatus('temporarily closed', '', null, OPEN).status).toBe('DOWN');
    });

    test.each(['CLOSED', 'CLOSED FOR THE DAY', 'UNKNOWN'])(
      '%s beats a posted wait time',
      (status) => {
        // The feed can serve both. The stated closure wins, and no queue is
        // published alongside it. All three are covered rather than just
        // CLOSED: with a wait present, dropping any one of them from this
        // branch turns a shut ride into OPERATING with a queue.
        const v = mapHfeRideStatus(status, '', 25, OPEN);
        expect(v.status).toBe('CLOSED');
        expect(v.waitTime).toBeUndefined();
      },
    );
  });

  describe('THE CASE THE OLD TABLE GOT WRONG: delays are clock-gated', () => {
    test.each(['TEMPORARILY CLOSED', 'TEMPORARILY DELAYED'])(
      '%s is DOWN while the park is open',
      (status) => {
        expect(mapHfeRideStatus(status, '', null, OPEN).status).toBe('DOWN');
      },
    );

    test.each(['TEMPORARILY CLOSED', 'TEMPORARILY DELAYED'])(
      '%s is CLOSED once the park has shut, NOT DOWN',
      (status) => {
        expect(mapHfeRideStatus(status, '', null, SHUT).status).toBe('CLOSED');
      },
    );

    test('neither publishes a queue', () => {
      expect(mapHfeRideStatus('TEMPORARILY CLOSED', '', 30, OPEN).waitTime).toBeUndefined();
    });
  });

  describe('the "Under XX minutes" display', () => {
    test('reads OPERATING and takes the wait from the text', () => {
      const v = mapHfeRideStatus('', 'UNDER 15 MINUTES', null, OPEN);
      expect(v.status).toBe('OPERATING');
      expect(v.waitTime).toBe(15);
    });

    test('is matched case-insensitively', () => {
      expect(mapHfeRideStatus('', 'Under 30 minutes', null, OPEN).waitTime).toBe(30);
    });

    test('an "under" with no number still opens the ride, with no queue', () => {
      const v = mapHfeRideStatus('', 'UNDER AN HOUR', null, OPEN);
      expect(v.status).toBe('OPERATING');
      expect(v.waitTime).toBeUndefined();
    });

    test('an explicit closure is checked FIRST, so it is not overridden', () => {
      expect(mapHfeRideStatus('CLOSED', 'UNDER 15 MINUTES', null, OPEN).status).toBe('CLOSED');
    });
  });

  describe('OPEN and bare wait times', () => {
    test('OPEN with no wait is OPERATING and publishes no queue', () => {
      const v = mapHfeRideStatus('OPEN', '', null, OPEN);
      expect(v.status).toBe('OPERATING');
      expect(v.waitTime).toBeUndefined();
    });

    test('OPEN with a positive wait publishes it', () => {
      expect(mapHfeRideStatus('OPEN', '', 45, OPEN).waitTime).toBe(45);
    });

    test('a zero wait IS a real reading here, and opens the ride', () => {
      // Unlike the Six Flags feed, which serves a roster of zeros around the
      // clock, a 0 here arrives with an explicit status. It opens the ride
      // but is not worth a queue entry.
      const v = mapHfeRideStatus('OPEN', '', 0, OPEN);
      expect(v.status).toBe('OPERATING');
      expect(v.waitTime).toBeUndefined();
    });

    test('a bare non-negative wait with no status at all opens the ride', () => {
      expect(mapHfeRideStatus('', '', 20, OPEN).status).toBe('OPERATING');
      expect(mapHfeRideStatus('', '', 0, OPEN).status).toBe('OPERATING');
    });

    test('a negative wait with no status falls through to CLOSED', () => {
      expect(mapHfeRideStatus('', '', -1, OPEN).status).toBe('CLOSED');
    });
  });

  test('nothing at all is CLOSED', () => {
    expect(mapHfeRideStatus(undefined, undefined, null, OPEN).status).toBe('CLOSED');
    expect(mapHfeRideStatus('', '', null, OPEN).status).toBe('CLOSED');
  });

  describe('sharp edges, pinned because they are load bearing', () => {
    test('the status is NOT trimmed, so a stray space falls through everything', () => {
      // 'CLOSED ' matches no closure branch and lands on the wait-time branch,
      // turning a shut ride into OPERATING with a published queue. Preserved
      // from the original chain rather than fixed here, because changing it is
      // a behaviour change and this extraction is code motion. Pinned so the
      // next person sees it rather than discovering it from a wrong row.
      const v = mapHfeRideStatus('CLOSED ', '', 10, OPEN);
      expect(v.status).toBe('OPERATING');
      expect(v.waitTime).toBe(10);
    });

    test('"UNDER" is a SUBSTRING match, so a name containing it opens the ride', () => {
      // Dollywood has a coaster called Thunderhead. No live waitTimeDisplay
      // carries a ride name today, so this is latent — but the substring test
      // is exactly the kind of thing a later reader tidies into equality.
      expect(mapHfeRideStatus('', 'Thunderhead', null, OPEN).status).toBe('OPERATING');
    });

    test('a delay outranks the UNDER display, not the other way round', () => {
      // Branch ORDER, which no other test pins: the delay check sits above
      // the display check, so a delayed ride still advertising "Under 15
      // minutes" reads DOWN rather than OPERATING with a 15-minute queue.
      const open = mapHfeRideStatus('TEMPORARILY CLOSED', 'UNDER 15 MINUTES', null, OPEN);
      expect(open.status).toBe('DOWN');
      expect(open.waitTime).toBeUndefined();
      expect(mapHfeRideStatus('TEMPORARILY CLOSED', 'UNDER 15 MINUTES', null, SHUT).status)
        .toBe('CLOSED');
    });

    test('a non-finite wait is passed through, and the base class nulls it', () => {
      // The declared return type says number; the branch passes the feed's
      // value straight out. Left alone deliberately — getLiveData() in
      // destination.ts sanitises a non-finite waitTime on the way out, which
      // is the documented safety net, and changing it here would make this
      // extraction more than code motion.
      expect(mapHfeRideStatus('OPEN', '', '15' as any, OPEN).waitTime).toBe('15' as any);
    });
  });
});

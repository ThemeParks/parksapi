import assert from 'assert';
import moment from 'moment-timezone';

import {getLiveDataErrors} from '../lib/parks/livedata.js';
import {queueType, returnTimeState} from '../lib/parks/parkTypes.js';

describe('Live Data Validators', function () {
  it('attraction standby integer', function () {
    // validate basic standby queue time
    assert(getLiveDataErrors(
      {
        queue: {
          [queueType.standBy]: {
            waitTime: 15,
          },
        }
      }) === null,
      'Standby livedata type fails to validate'
    );
  });

  it('attraction standby fails negative wait', function () {
    assert(getLiveDataErrors(
      {
        queue: {
          [queueType.standBy]: {
            // fail if time is < 0
            waitTime: -1,
          },
        }
      }),
      'Standby livedata should not accept negative wait times'
    );
  });

  it('attraction standby fails string', function () {
    // fail if waittime is a string
    assert(getLiveDataErrors(
      {
        queue: {
          [queueType.standBy]: {
            waitTime: '15', // string
          },
        }
      }),
      'Standby livedata should not validate with a string waitTime'
    );
  });

  it('attraction standby fails missing waitTime', function () {
    // fail if waittime is a string
    assert(getLiveDataErrors(
      {
        queue: {
          [queueType.standBy]: {},
        }
      }),
      'Standby livedata should not validate with a missing waitTime'
    );
  });

  it('return time validation', function () {
    assert(getLiveDataErrors(
      {
        queue: {
          [queueType.returnTime]: {
            returnStart: '10:00',
            returnEnd: '11:00',
            state: returnTimeState.available,
          },
        }
      }) === null,
      'Validation should succeed for return time example'
    );
  });

  it('return time missing state', function () {
    assert(getLiveDataErrors(
      {
        queue: {
          [queueType.returnTime]: {
            returnStart: '10:00',
            returnEnd: '11:00',
          },
        }
      }),
      'Validation should fail is state is missing'
    );
  });

  it('return time invalid state', function () {
    assert(getLiveDataErrors(
      {
        queue: {
          [queueType.returnTime]: {
            returnStart: '10:00',
            returnEnd: '11:00',
            state: '__invalidstate'
          },
        }
      }),
      'Validation should fail is state is an invalid value'
    );
  });

  it('showtimes valid data', function () {
    assert(getLiveDataErrors(
      {
        showtimes: [
          {
            startTime: moment().format(),
            endTime: moment().format(),
            type: 'Performance Time',
          }
        ],
      }) === null,
      'Validation should pass for valid showtimes data'
    );
  });

  it('showtimes invalid startTime', function () {
    assert(getLiveDataErrors(
      {
        showtimes: [
          {
            startTime: 'notadate',
            endTime: moment().format(),
            type: 'Performance Time',
          }
        ],
      }).length > 0,
      'Validation should fail for invalid startTime'
    );
  });
});

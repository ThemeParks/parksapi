import assert from 'assert';

import {getLiveDataErrors} from '../lib/parks/livedata.js';
import {entityType, queueType, returnTimeState} from '../lib/parks/parkTypes.js';

describe('Live Data Validators', function () {
  it('attraction standby integer', function () {
    // validate basic standby queue time
    assert(getLiveDataErrors(
      {
        entityType: entityType.attraction,
      },
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

  it('attraction standby fails string', function () {
    // fail if waittime is a string
    assert(getLiveDataErrors(
      {
        entityType: entityType.attraction,
      },
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
        entityType: entityType.attraction,
      },
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
        entityType: entityType.attraction,
      },
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
        entityType: entityType.attraction,
      },
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
        entityType: entityType.attraction,
      },
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

  it('fail with invalid entity type', function () {
    assert(getLiveDataErrors(
      {
        entityType: 'nan',
      },
      {
        queue: {
          [queueType.standBy]: {
            waitTime: 0,
          },
        }
      }),
      'Validation should fail with invalid entity type'
    );
  });
});

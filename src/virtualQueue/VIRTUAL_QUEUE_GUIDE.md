# Virtual Queue Framework - Developer Guide

Complete guide to implementing virtual queues (return times, boarding groups, paid skip-the-line systems) in ParksAPI using the Virtual Queue Framework.

## Table of Contents
- [Quick Start](#quick-start)
- [Core Concepts](#core-concepts)
- [VQueueBuilder API](#vqueuebuilder-api)
- [Implementation Patterns](#implementation-patterns)
- [Helper Methods](#helper-methods)
- [Validation](#validation)
- [Real-World Examples](#real-world-examples)
- [Testing](#testing)

## Quick Start

```typescript
import { VQueueBuilder } from './virtualQueue/index.js';

// Build a return time queue (free virtual queue)
const returnTimeQueue = VQueueBuilder.returnTime()
  .available()
  .withWindow('2024-10-15T14:30:00-04:00', '2024-10-15T14:45:00-04:00')
  .build();

// Build a boarding group queue
const boardingGroupQueue = VQueueBuilder.boardingGroup()
  .available()
  .currentGroups(45, 60)
  .estimatedWait(30)
  .build();

// Build a paid return time queue (Lightning Lane, Express Pass)
const paidQueue = VQueueBuilder.paidReturnTime()
  .available()
  .withWindow('2024-10-15T14:30:00-04:00', null)
  .withPrice('USD', 1500) // $15.00
  .build();
```

## Core Concepts

###  Virtual Queue Types

ParksAPI supports three types of virtual queues:

1. **RETURN_TIME** - Free virtual queue (Disney Genie, Universal Virtual Line)
   - Get a return window to come back later
   - No additional cost
   - Three states: AVAILABLE, TEMP_FULL, FINISHED

2. **PAID_RETURN_TIME** - Paid virtual queue (Lightning Lane, Express Pass)
   - Pay to get priority access
   - Includes price information
   - Same states as RETURN_TIME

3. **BOARDING_GROUP** - Boarding group system (Rise of the Resistance)
   - Get a group number, wait until called
   - Three states: AVAILABLE, PAUSED, CLOSED

### Queue States

#### Return Time States

- `AVAILABLE` - Slots available now, can join immediately
- `TEMP_FULL` - Currently full, but more slots coming later
- `FINISHED` - All slots reserved for the day

#### Boarding Group States

- `AVAILABLE` - Accepting new boarding group reservations
- `PAUSED` - Temporarily paused, will resume (has next allocation time)
- `CLOSED` - Not accepting reservations (system inactive or ride closed)

## VQueueBuilder API

### Return Time Queues

```typescript
VQueueBuilder.returnTime()
  .available()           // Set state to AVAILABLE
  .temporarilyFull()     // Set state to TEMP_FULL
  .finished()            // Set state to FINISHED
  .state(state)          // Set state directly
  .withWindow(start, end) // Set return time window
  .build()               // Build queue object
```

### Paid Return Time Queues

```typescript
VQueueBuilder.paidReturnTime()
  .available()           // Set state to AVAILABLE
  .withWindow(start, end) // Set return time window
  .withPrice(currency, amountCents) // Set price
  .build()               // Build queue object
```

### Boarding Group Queues

```typescript
VQueueBuilder.boardingGroup()
  .available()           // Set status to AVAILABLE
  .paused()              // Set status to PAUSED
  .closed()              // Set status to CLOSED
  .status(status)        // Set status directly
  .currentGroups(start, end) // Set current group range
  .nextAllocationTime(time)  // Set next allocation time
  .estimatedWait(minutes)    // Set estimated wait
  .build()               // Build queue object
```

## Implementation Patterns

### Pattern 1: Explicit Time Slots (Universal)

API returns array of available time slots:

```typescript
protected async buildLiveData(): Promise<LiveData[]> {
  const vqData = await this.fetchVirtualQueueSlots();
  const liveData: LiveData[] = [];

  for (const attraction of vqData) {
    const slots = attraction.availableSlots || [];

    // Find earliest available slot
    const nextSlot = findNextAvailableSlot(slots, {
      currentTime: new Date(),
      filterAvailable: true
    });

    const data: LiveData = {
      id: attraction.id,
      status: 'OPERATING',
      queue: {
        STANDBY: { waitTime: attraction.waitTime }
      }
    };

    // Add return time queue
    if (nextSlot) {
      data.queue!.RETURN_TIME = VQueueBuilder.returnTime()
        .available()
        .withWindow(nextSlot.start, nextSlot.end)
        .build();
    } else {
      data.queue!.RETURN_TIME = VQueueBuilder.returnTime()
        .temporarilyFull()
        .build();
    }

    liveData.push(data);
  }

  return liveData;
}
```

### Pattern 2: Calculated Windows (Efteling)

Calculate virtual queue window from current wait time:

```typescript
protected async buildLiveData(): Promise<LiveData[]> {
  const attractions = await this.fetchAttractions();
  const liveData: LiveData[] = [];

  for (const attraction of attractions) {
    const data: LiveData = {
      id: attraction.id,
      status: attraction.isOpen ? 'OPERATING' : 'CLOSED',
      queue: {
        STANDBY: { waitTime: attraction.waitTime }
      }
    };

    // Check if virtual queue is enabled
    if (attraction.virtualQueue?.enabled) {
      const vqState = attraction.virtualQueue.state; // 'enabled', 'walkin', 'full'

      if (vqState === 'enabled') {
        // Calculate return window: now + waitTime to now + waitTime + 15 min
        const window = this.calculateReturnWindow(
          attraction.virtualQueue.waitTime,
          { windowMinutes: 15 }
        );

        data.queue!.RETURN_TIME = VQueueBuilder.returnTime()
          .available()
          .withWindow(window.start, window.end)
          .build();

      } else if (vqState === 'walkin') {
        // Park not open yet, no virtual queue needed
        data.queue!.RETURN_TIME = VQueueBuilder.returnTime()
          .temporarilyFull()
          .build();

      } else if (vqState === 'full') {
        // All slots reserved for the day
        data.queue!.RETURN_TIME = VQueueBuilder.returnTime()
          .finished()
          .build();
      }
    }

    liveData.push(data);
  }

  return liveData;
}
```

### Pattern 3: Boarding Groups (Disney)

Boarding group system with allocation times:

```typescript
protected async buildLiveData(): Promise<LiveData[]> {
  const boardingGroupData = await this.fetchBoardingGroups();
  const liveData: LiveData[] = [];

  for (const attraction of boardingGroupData) {
    const data: LiveData = {
      id: attraction.id,
      status: 'OPERATING',
      queue: {}
    };

    if (attraction.boardingGroups?.enabled) {
      const bg = attraction.boardingGroups;

      // Determine boarding group status
      let status: BoardingGroupState = 'AVAILABLE';
      if (bg.state === 'CLOSED' || !attraction.isOpen) {
        status = 'CLOSED';
      } else if (bg.state === 'PAUSED' && bg.nextOpenTime) {
        status = 'PAUSED';
      }

      // Build boarding group queue
      data.queue!.BOARDING_GROUP = this.buildBoardingGroupQueue(status, {
        currentGroupStart: bg.currentGroupStart,
        currentGroupEnd: bg.currentGroupEnd,
        nextAllocationTime: bg.nextOpenTime,
        estimatedWait: status === 'AVAILABLE' ? bg.estimatedWaitMinutes : null
      });
    }

    liveData.push(data);
  }

  return liveData;
}
```

### Pattern 4: Paid Virtual Queues (Disney Lightning Lane)

Paid return times with pricing:

```typescript
protected async buildLiveData(): Promise<LiveData[]> {
  const genieData = await this.fetchGenieData();
  const liveData: LiveData[] = [];

  for (const attraction of genieData) {
    const data: LiveData = {
      id: attraction.id,
      status: 'OPERATING',
      queue: {
        STANDBY: { waitTime: attraction.waitTime }
      }
    };

    // Individual Lightning Lane (paid, specific time)
    if (attraction.individualLightningLane?.available) {
      const ll = attraction.individualLightningLane;

      data.queue!.PAID_RETURN_TIME = this.buildPaidReturnTimeQueue(
        'AVAILABLE',
        ll.nextAvailableTime,
        null, // Open-ended window
        'USD',
        ll.priceCents
      );
    }

    // Genie+ (included with purchase, specific window)
    if (attraction.geniePlus?.available) {
      const genie = attraction.geniePlus;

      data.queue!.RETURN_TIME = this.buildReturnTimeQueue(
        'AVAILABLE',
        genie.returnStart,
        genie.returnEnd
      );
    }

    liveData.push(data);
  }

  return liveData;
}
```

## Helper Methods

The `Destination` base class provides helper methods for building virtual queues:

### buildReturnTimeQueue()

```typescript
protected buildReturnTimeQueue(
  state: ReturnTimeState,
  returnStart: string | Date | null,
  returnEnd: string | Date | null
): NonNullable<LiveQueue['RETURN_TIME']>
```

Example:
```typescript
liveData.queue!.RETURN_TIME = this.buildReturnTimeQueue(
  'AVAILABLE',
  new Date('2024-10-15T14:30:00'),
  new Date('2024-10-15T14:45:00')
);
```

### buildPaidReturnTimeQueue()

```typescript
protected buildPaidReturnTimeQueue(
  state: ReturnTimeState,
  returnStart: string | Date | null,
  returnEnd: string | Date | null,
  currency: string,
  amountCents: number | null
): NonNullable<LiveQueue['PAID_RETURN_TIME']>
```

Example:
```typescript
liveData.queue!.PAID_RETURN_TIME = this.buildPaidReturnTimeQueue(
  'AVAILABLE',
  apiData.returnTime,
  null, // No specific end time
  'USD',
  1500 // $15.00
);
```

### buildBoardingGroupQueue()

```typescript
protected buildBoardingGroupQueue(
  status: BoardingGroupState,
  options?: {
    currentGroupStart?: number | null;
    currentGroupEnd?: number | null;
    nextAllocationTime?: string | Date | null;
    estimatedWait?: number | null;
  }
): NonNullable<LiveQueue['BOARDING_GROUP']>
```

Example:
```typescript
liveData.queue!.BOARDING_GROUP = this.buildBoardingGroupQueue('AVAILABLE', {
  currentGroupStart: 45,
  currentGroupEnd: 60,
  estimatedWait: 30
});
```

### calculateReturnWindow()

```typescript
protected calculateReturnWindow(
  waitMinutes: number,
  options?: {
    baseTime?: Date;
    windowMinutes?: number;
  }
): { start: string; end: string }
```

Example:
```typescript
// Calculate window: now + 45 min to now + 45 min + 15 min
const window = this.calculateReturnWindow(45, { windowMinutes: 15 });

liveData.queue!.RETURN_TIME = this.buildReturnTimeQueue(
  'AVAILABLE',
  window.start,
  window.end
);
```

## Validation

Runtime validation helps catch common mistakes:

```typescript
import { validateReturnTimeQueue, validateBoardingGroupQueue } from './virtualQueue/index.js';

// Validate return time queue
const errors = validateReturnTimeQueue(queue);
if (errors.length > 0) {
  console.error('Invalid queue:', errors);
}

// Validate with suggestions
const result = validateReturnTimeQueue(queue, { suggest: true });
if (!result.valid) {
  console.error('Errors:', result.errors);
  console.log('Suggestions:', result.suggestions);
}
```

### Common Validation Rules

**Return Time Queues:**
- AVAILABLE state requires both `returnStart` and `returnEnd`
- TEMP_FULL and FINISHED states should have null times
- `returnEnd` must be after `returnStart`
- Times must be valid ISO 8601 datetime strings

**Paid Return Time Queues:**
- All return time rules apply
- Must have `price` object
- Currency must be 3-letter code (USD, EUR, GBP, JPY)
- Amount should be in cents (or 0)

**Boarding Group Queues:**
- PAUSED status should have `nextAllocationTime`
- AVAILABLE status should have `currentGroupStart` and `currentGroupEnd`
- `currentGroupEnd` must be >= `currentGroupStart`
- `estimatedWait` must be positive or null

## Real-World Examples

### Universal Studios Virtual Line

```typescript
import { findNextAvailableSlot } from './virtualQueue/index.js';

protected async buildLiveData(): Promise<LiveData[]> {
  const vqStates = await this.fetchVirtualQueueStates();
  const liveData: LiveData[] = [];

  for (const vQueue of vqStates) {
    if (vQueue.IsEnabled) {
      const vQueueDetails = await this.getVirtualQueueDetails(vQueue.Id);

      // Find earliest appointment time
      const slots = vQueueDetails.AppointmentTimes.map(appt => ({
        startTime: appt.StartTime,
        endTime: appt.EndTime
      }));

      const nextSlot = findNextAvailableSlot(slots, {
        currentTime: new Date()
      });

      const liveDataEntry = getOrCreateLiveData(vQueue.QueueEntityId);
      liveDataEntry.queue!.RETURN_TIME = nextSlot
        ? VQueueBuilder.returnTime()
            .available()
            .withWindow(nextSlot.start, nextSlot.end)
            .build()
        : VQueueBuilder.returnTime()
            .temporarilyFull()
            .build();

      liveData.push(liveDataEntry);
    }
  }

  return liveData;
}
```

### Disney Rise of the Resistance Boarding Groups

```typescript
import { determineBoardingGroupState } from './virtualQueue/index.js';

protected async buildLiveData(): Promise<LiveData[]> {
  const attractionData = await this.fetchAttractionData();
  const liveData: LiveData[] = [];

  for (const attraction of attractionData) {
    const data: LiveData = {
      id: attraction.id,
      status: 'OPERATING',
      queue: {}
    };

    if (attraction.virtualQueueData) {
      const vq = attraction.virtualQueueData;

      // Determine boarding group state
      const bgState = determineBoardingGroupState({
        isSystemActive: attraction.status === 'Virtual Queue',
        isPaused: vq.state === 'PAUSED',
        hasNextAllocationTime: !!vq.nextScheduledOpenTime,
        isRideOpen: attraction.isOpen
      });

      // Calculate next allocation time
      let nextAllocationTime: string | null = null;
      if (vq.nextScheduledOpenTime) {
        const nowDate = formatInTimezone(new Date(), this.timezone, 'date');
        nextAllocationTime = `${nowDate}T${vq.nextScheduledOpenTime}`;
      }

      data.queue!.BOARDING_GROUP = this.buildBoardingGroupQueue(bgState, {
        currentGroupStart: vq.currentArrivingGroupStart || null,
        currentGroupEnd: vq.currentArrivingGroupEnd || null,
        nextAllocationTime,
        estimatedWait: bgState === 'AVAILABLE' ? vq.waitTimeMin : null
      });
    }

    liveData.push(data);
  }

  return liveData;
}
```

### Efteling Virtual Queue with Calculated Windows

```typescript
import { determineReturnTimeState } from './virtualQueue/index.js';

protected async buildLiveData(): Promise<LiveData[]> {
  const poiData = await this.fetchPOI();
  const liveData: LiveData[] = [];

  for (const entry of poiData) {
    const data: LiveData = {
      id: entry.id,
      status: entry.isOpen ? 'OPERATING' : 'CLOSED',
      queue: {
        STANDBY: { waitTime: entry.waitTime }
      }
    };

    if (entry.VirtualQueue) {
      const vq = entry.VirtualQueue;

      // Determine state from API
      const state = determineReturnTimeState({
        hasSlots: vq.State !== 'full',
        slotsAvailableNow: vq.State === 'enabled',
        moreSlotsLater: vq.State === 'walkin',
        isRideOpen: entry.isOpen
      });

      if (state === 'AVAILABLE') {
        // Calculate return window (wait time + 15 min window)
        const window = this.calculateReturnWindow(vq.WaitingTime, {
          windowMinutes: 15
        });

        data.queue!.RETURN_TIME = this.buildReturnTimeQueue(
          'AVAILABLE',
          window.start,
          window.end
        );
      } else {
        data.queue!.RETURN_TIME = this.buildReturnTimeQueue(
          state,
          null,
          null
        );
      }
    }

    liveData.push(data);
  }

  return liveData;
}
```

## Testing

### Unit Tests

```typescript
import { VQueueBuilder } from './virtualQueue/index.js';

describe('Virtual Queue Implementation', () => {
  it('should build return time queue', () => {
    const queue = VQueueBuilder.returnTime()
      .available()
      .withWindow('2024-10-15T14:30:00-04:00', '2024-10-15T14:45:00-04:00')
      .build();

    expect(queue.state).toBe('AVAILABLE');
    expect(queue.returnStart).toBeTruthy();
    expect(queue.returnEnd).toBeTruthy();
  });

  it('should validate calculated return windows', () => {
    const window = calculateReturnWindow({
      baseTime: new Date('2024-10-15T10:00:00Z'),
      waitMinutes: 45,
      windowDurationMinutes: 15,
      timezone: 'Europe/Amsterdam'
    });

    expect(window.start).toBeTruthy();
    expect(window.end).toBeTruthy();

    const start = Date.parse(window.start);
    const end = Date.parse(window.end);
    const windowMinutes = (end - start) / 1000 / 60;
    expect(windowMinutes).toBeCloseTo(15, 0);
  });
});
```

### Integration Tests

```typescript
it('should fetch and parse virtual queue data', async () => {
  const park = new MyPark();
  const liveData = await park.getLiveData();

  const vqAttraction = liveData.find(ld => ld.queue?.RETURN_TIME);
  expect(vqAttraction).toBeTruthy();

  if (vqAttraction?.queue?.RETURN_TIME) {
    const queue = vqAttraction.queue.RETURN_TIME;
    expect(['AVAILABLE', 'TEMP_FULL', 'FINISHED']).toContain(queue.state);

    // Validate queue data
    const errors = validateReturnTimeQueue(queue);
    expect(errors).toEqual([]);
  }
});
```

## Best Practices

1. **Always validate queue data** - Use validation functions in tests to catch issues early

2. **Handle timezone correctly** - Use `formatInTimezone()` from datetime utilities

3. **Check for null/undefined** - Virtual queue systems can be disabled, handle gracefully

4. **Use state determination helpers** - Encapsulate complex state logic in reusable functions

5. **Test with real API data** - Virtual queue responses vary, test with actual data

6. **Document API quirks** - Note any unusual behavior in comments

7. **Handle errors gracefully** - Virtual queue APIs can be unreliable, add fallbacks

## Additional Resources

- Full API documentation: https://themeparks.github.io/parksapi/
- Type definitions: `@themeparks/typelib`
- Test examples: `src/virtualQueue/__tests__/`
- Real implementations: `src/parks/universal/universal.ts`

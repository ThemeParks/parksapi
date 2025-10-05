# ParksAPI Exports

This document lists all public exports available from `@themeparks/parksapi`.

## Installation

```bash
npm install @themeparks/parksapi
```

## Base Classes

```typescript
import { Destination } from '@themeparks/parksapi';

class MyPark extends Destination {
  // Your implementation
}
```

## Decorators

```typescript
import { config, http, cache, inject, trace } from '@themeparks/parksapi';

@config
class MyPark extends Destination {
  @config
  apiKey: string = 'default';

  @http({ cacheSeconds: 60 })
  async fetchData() {
    return { method: 'GET', url: 'https://api.example.com/data', tags: [] };
  }
}
```

## Core Libraries

### Tracing System

```typescript
import { tracing } from '@themeparks/parksapi';

// Trace an operation
const result = await tracing.trace(() => park.getLiveData());
console.log(`Trace ID: ${result.traceId}`);
console.log(`Duration: ${result.duration}ms`);
console.log(`HTTP Requests: ${result.events.length}`);

// Get trace by ID later
const trace = tracing.getTrace(result.traceId);
console.log(trace.events);
```

### Cache Library

```typescript
import { CacheLib } from '@themeparks/parksapi';

// Direct cache access
CacheLib.set('myKey', 'myValue', 3600);
const value = CacheLib.get('myKey');
```

### Event Broadcasting

```typescript
import { broadcast } from '@themeparks/parksapi';

// Broadcast events
await broadcast(instance, { eventName: 'myEvent', data: {} }, payload);
```

## Destination Registry

```typescript
import {
  destinationController,
  getAllDestinations,
  getDestinationById,
  getDestinationsByCategory,
  getAllCategories,
  listDestinationIds,
} from '@themeparks/parksapi';

// Register a destination
@destinationController({ category: 'Theme Parks' })
export class MyPark extends Destination {
  // ...
}

// Query destinations
const all = await getAllDestinations();
const park = await getDestinationById('universalorlando');
const themeparks = await getDestinationsByCategory('Theme Parks');
const categories = await getAllCategories();
const ids = await listDestinationIds();
```

## HTTP Library Utilities

```typescript
import {
  getQueueLength,
  getHttpRequesters,
  getHttpRequestersForClass,
  stopHttpQueue,
} from '@themeparks/parksapi';

// Monitor HTTP queue
const queueSize = getQueueLength();
const allRequesters = getHttpRequesters();
const parkRequesters = getHttpRequestersForClass(MyPark);

// Stop queue (for testing/shutdown)
stopHttpQueue();
```

## Date/Time Utilities

```typescript
import {
  formatInTimezone,
  parseTimeInTimezone,
  formatUTC,
  addDays,
  isBefore,
} from '@themeparks/parksapi';

const formatted = formatInTimezone(new Date(), 'America/New_York', 'YYYY-MM-DD');
const parsed = parseTimeInTimezone('14:30', new Date(), 'America/New_York');
const utc = formatUTC(new Date(), 'YYYY-MM-DD HH:mm:ss');
const tomorrow = addDays(new Date(), 1);
```

## TypeScript Types

### Entity Types

```typescript
import type {
  Entity,
  EntityType,
  EntityLocation,
  AttractionType,
  TagData,
} from '@themeparks/parksapi';

const entity: Entity = {
  id: '123',
  name: 'My Attraction',
  entityType: 'ATTRACTION',
  timezone: 'America/New_York',
};
```

### Live Data Types

```typescript
import type {
  LiveData,
  LiveStatusType,
  LiveQueue,
  QueueType,
} from '@themeparks/parksapi';

const liveData: LiveData = {
  id: '123',
  status: 'OPERATING',
  queue: {
    STANDBY: { waitTime: 45 }
  }
};
```

### Schedule Types

```typescript
import type {
  EntitySchedule,
  ScheduleType,
} from '@themeparks/parksapi';
```

### Tracing Types

```typescript
import type {
  TraceContext,
  HttpTraceEvent,
  TraceResult,
  TraceInfo,
} from '@themeparks/parksapi';
```

### HTTP Types

```typescript
import type {
  HTTPParameter,
  HTTPObj,
  HTTPRequestEntry,
} from '@themeparks/parksapi';
```

## Enums (Runtime Values)

```typescript
import {
  EntityTypeEnum,
  AttractionTypeEnum,
  LiveStatusTypeEnum,
  QueueTypeEnum,
  ScheduleTypeEnum,
} from '@themeparks/parksapi';

console.log(EntityTypeEnum.PARK); // 'PARK'
console.log(LiveStatusTypeEnum.OPERATING); // 'OPERATING'
```

## Complete Import Example

```typescript
// Import everything you need
import {
  // Classes
  Destination,

  // Decorators
  config,
  http,
  cache,
  inject,
  trace,

  // Libraries
  tracing,
  CacheLib,

  // Registry
  destinationController,
  getAllDestinations,

  // Types
  type Entity,
  type LiveData,
  type EntitySchedule,

  // Enums
  EntityTypeEnum,
  LiveStatusTypeEnum,
} from '@themeparks/parksapi';

@destinationController({ category: 'My Parks' })
@config
class MyPark extends Destination {
  @config
  apiKey: string;

  @http({ cacheSeconds: 300 })
  @cache({ ttlSeconds: 300 })
  async fetchData() {
    return {
      method: 'GET' as const,
      url: `https://api.example.com/data`,
      tags: ['data'],
    };
  }

  @trace()
  async getLiveData(): Promise<LiveData[]> {
    const data = await this.fetchData();
    // Process and return live data
    return [];
  }
}

// Use the park
const park = new MyPark();
const result = await tracing.trace(() => park.getLiveData());
console.log(`Completed in ${result.duration}ms with ${result.events.length} HTTP requests`);
```

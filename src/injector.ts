// Injector decorator
//  Functions can subscribe using sift.js syntax to events

import sift from "sift";

// Global registry of instances for 'global' broadcasts
const globalInstances = new Set<any>();

// Global registry of functions for 'global' broadcasts
const globalFunctions = new Map<any, Function>();

/**
 * Register an instance to be included in 'global' broadcasts.
 * Call this for each instance that should participate in global injections.
 */
export function registerInstance(instance: any) {
  globalInstances.add(instance);
}

/**
 * Decorator to inject a function based on a sift filter.
 * Can be applied to functions or class methods.
 * The decorated function/method will be called when an event matches the filter.
 *
 * @param filter Sift query filter with optional 'priority' field for execution ordering
 */
export function inject(filter: any) {
  return function(target: any, propertyKey?: string, descriptor?: PropertyDescriptor) {
    if (typeof target === 'function' && !propertyKey) {
      // Applied to a function
      globalFunctions.set(filter, target);
    } else if (propertyKey && descriptor) {
      // Applied to a method
      if (!target.__injectFilters) {
        target.__injectFilters = new Map<string, any>();
      }

      // Separate priority from filter (priority is metadata, not part of the event match)
      const {priority, ...eventFilter} = filter;

      target.__injectFilters.set(propertyKey, {
        filter: Object.keys(eventFilter).length > 0 ? eventFilter : filter, // Use original if no other fields
        priority: priority ?? 0,
      });
    }
  };
}

/**
 * Resolve any functions in the filter object to their values.
 * Walks the filter object and replaces functions with their resolved values.
 * Functions are called with the instance context.
 */
async function resolveFilterFunctions(filter: any, instance: any): Promise<any> {
  if (typeof filter === 'function') {
    // Call the function with the instance context
    const result = filter.call(instance);
    // Handle async functions
    return result instanceof Promise ? await result : result;
  }

  if (Array.isArray(filter)) {
    // Resolve each element in the array
    return Promise.all(filter.map(item => resolveFilterFunctions(item, instance)));
  }

  if (filter !== null && typeof filter === 'object' && !(filter instanceof RegExp)) {
    // Resolve each property in the object (but skip RegExp objects)
    const resolved: any = {};
    for (const [key, value] of Object.entries(filter)) {
      resolved[key] = await resolveFilterFunctions(value, instance);
    }
    return resolved;
  }

  // Primitive value or RegExp, return as-is
  return filter;
}

/**
 * Broadcast an event to matching injected functions.
 * @param scope 'global' to broadcast to all registered instances and global functions, or an array/single instance to broadcast to specific instances' methods.
 * @param event The event object to match against filters.
 * @param args Additional arguments to pass to the injected functions.
 */
export async function broadcast(scope: 'global' | any[] | any, event: any, ...args: any[]) {
  // Collect all matching calls with their priorities
  type PrioritizedCall = {
    priority: number;
    fn: () => Promise<any>;
  };
  const prioritizedCalls: PrioritizedCall[] = [];

  if (scope === 'global') {
    // Call global functions (no priority support for global functions yet)
    for (const [filter, fn] of globalFunctions) {
      if (sift(filter)(event)) {
        prioritizedCalls.push({
          priority: 0,
          fn: () => fn(...args),
        });
      }
    }
    // Call methods on registered instances
    for (const instance of globalInstances) {
      const proto = Object.getPrototypeOf(instance);
      const filters = proto.__injectFilters;
      if (filters) {
        for (const [methodName, filterData] of filters) {
          // filterData is now { filter, priority }
          const filter = filterData.filter || filterData; // Backwards compat
          const priority = filterData.priority ?? 0;

          const resolvedFilter = await resolveFilterFunctions(filter, instance);
          if (sift(resolvedFilter)(event)) {
            prioritizedCalls.push({
              priority,
              fn: () => instance[methodName](...args),
            });
          }
        }
      }
    }
  } else {
    // Specific instances
    let instances: any[];
    if (Array.isArray(scope)) {
      instances = scope;
    } else {
      instances = [scope];
    }

    for (const instance of instances) {
      const proto = Object.getPrototypeOf(instance);
      const filters = proto.__injectFilters;
      if (filters) {
        for (const [methodName, filterData] of filters) {
          // filterData is now { filter, priority }
          const filter = filterData.filter || filterData; // Backwards compat
          const priority = filterData.priority ?? 0;

          const resolvedFilter = await resolveFilterFunctions(filter, instance);
          if (sift(resolvedFilter)(event)) {
            prioritizedCalls.push({
              priority,
              fn: () => instance[methodName](...args),
            });
          }
        }
      }
    }
  }

  // Sort by priority (lower number = higher priority, runs first)
  prioritizedCalls.sort((a, b) => a.priority - b.priority);

  // Execute in priority order
  // Group by priority to run same-priority calls in parallel, different priorities in sequence
  const priorityGroups = new Map<number, Array<() => Promise<any>>>();

  for (const call of prioritizedCalls) {
    if (!priorityGroups.has(call.priority)) {
      priorityGroups.set(call.priority, []);
    }
    priorityGroups.get(call.priority)!.push(call.fn);
  }

  // Execute each priority group in sequence, but calls within a group in parallel
  for (const [_priority, fns] of Array.from(priorityGroups.entries()).sort((a, b) => a[0] - b[0])) {
    await Promise.all(fns.map(fn => fn()));
  }
}


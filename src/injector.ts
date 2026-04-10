// Injector decorator
//  Functions can subscribe using sift.js syntax to events

import siftImport from "sift";
const sift = siftImport.default || siftImport;

// Global registry of instances for 'global' broadcasts
const globalInstances = new Set<any>();

// Global registry of standalone functions for 'global' broadcasts.
// Stored as a list of {filter, fn} pairs because each @inject call should
// register independently — using a Map keyed by filter object would still
// iterate the whole collection (filter is matched by sift, not by identity).
const globalFunctions: Array<{filter: any; fn: Function}> = [];

/**
 * Register an instance to be included in 'global' broadcasts.
 * Call this for each instance that should participate in global injections.
 */
export function registerInstance(instance: any) {
  globalInstances.add(instance);
}

/**
 * Remove an instance from the global broadcast registry.
 * Call this when tearing down an instance that was registered via registerInstance().
 */
export function deregisterInstance(instance: any) {
  globalInstances.delete(instance);
}

/**
 * Clear all global injector state (instances and functions).
 * Intended for test isolation between suites.
 */
export function clearGlobalRegistry() {
  globalInstances.clear();
  globalFunctions.length = 0;
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
    // Separate priority from filter — priority is execution metadata, not part
    // of the event match. Always use the stripped filter, even if it's empty
    // (empty filter = match all events).
    const {priority, ...eventFilter} = filter ?? {};
    const priorityVal = priority ?? 0;

    if (typeof target === 'function' && !propertyKey) {
      // Applied to a standalone function
      globalFunctions.push({filter: eventFilter, fn: target});
    } else if (propertyKey && descriptor) {
      // Applied to a method.
      // Use hasOwnProperty so subclass decorators don't pollute the parent class's
      // __injectFilters via prototype chain lookup.
      if (!Object.prototype.hasOwnProperty.call(target, '__injectFilters')) {
        target.__injectFilters = new Map<string, any>();
      }

      target.__injectFilters.set(propertyKey, {
        filter: eventFilter,
        priority: priorityVal,
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
 * Walk an instance's prototype chain to collect any matching injectors and
 * push them onto the prioritized call list. Used by both global and
 * instance-scoped broadcasts.
 */
async function collectInjectorsFromPrototypeChain(
  instance: any,
  event: any,
  prioritizedCalls: Array<{priority: number; fn: () => Promise<any>}>,
  args: any[],
): Promise<void> {
  let proto = Object.getPrototypeOf(instance);
  while (proto) {
    if (Object.prototype.hasOwnProperty.call(proto, '__injectFilters')) {
      const filters = proto.__injectFilters as Map<string, {filter: any; priority: number}>;
      for (const [methodName, {filter, priority}] of filters) {
        const resolvedFilter = await resolveFilterFunctions(filter, instance);
        if (sift(resolvedFilter)(event)) {
          prioritizedCalls.push({
            priority,
            fn: () => instance[methodName](...args),
          });
        }
      }
    }
    proto = Object.getPrototypeOf(proto);
  }
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
    // Call global standalone functions (priority always 0)
    for (const {filter, fn} of globalFunctions) {
      if (sift(filter)(event)) {
        prioritizedCalls.push({
          priority: 0,
          fn: () => fn(...args),
        });
      }
    }
    // Call methods on registered instances
    for (const instance of globalInstances) {
      await collectInjectorsFromPrototypeChain(instance, event, prioritizedCalls, args);
    }
  } else {
    // Specific instances
    const instances: any[] = Array.isArray(scope) ? scope : [scope];
    for (const instance of instances) {
      await collectInjectorsFromPrototypeChain(instance, event, prioritizedCalls, args);
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


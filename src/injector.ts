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
      target.__injectFilters.set(propertyKey, filter);
    }
  };
}

/**
 * Broadcast an event to matching injected functions.
 * @param scope 'global' to broadcast to all registered instances and global functions, or an array/single instance to broadcast to specific instances' methods.
 * @param event The event object to match against filters.
 * @param args Additional arguments to pass to the injected functions.
 */
export async function broadcast(scope: 'global' | any[] | any, event: any, ...args: any[]) {
  const calls: Promise<any>[] = [];

  if (scope === 'global') {
    // Call global functions
    for (const [filter, fn] of globalFunctions) {
      if (sift(filter)(event)) {
        calls.push(fn(...args));
      }
    }
    // Call methods on registered instances
    for (const instance of globalInstances) {
      const proto = Object.getPrototypeOf(instance);
      const filters = proto.__injectFilters;
      if (filters) {
        for (const [methodName, filter] of filters) {
          if (sift(filter)(event)) {
            calls.push(instance[methodName](...args));
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
        for (const [methodName, filter] of filters) {
          if (sift(filter)(event)) {
            calls.push(instance[methodName](...args));
          }
        }
      }
    }
  }

  await Promise.all(calls);
}


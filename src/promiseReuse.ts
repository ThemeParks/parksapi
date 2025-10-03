/**
 * Promise reuse decorator
 *
 * Prevents duplicate execution of async methods by reusing the same promise
 * while it's pending, and optionally caching the result forever.
 *
 * Use cases:
 * - Init methods that should only run once
 * - Avoiding duplicate API calls when multiple callers request the same data
 * - Singleton pattern for data fetching
 */

type PromiseEntry = {
  instance: any;
  methodName: string;
  args: string; // Serialized arguments
  promise: Promise<any>;
  resolved: boolean;
  value?: any;
};

// Global registry of active promises
const activePromises: PromiseEntry[] = [];

/**
 * Find an active promise entry
 */
function findPromiseEntry(instance: any, methodName: string, args: string): PromiseEntry | undefined {
  return activePromises.find(
    (entry) => entry.instance === instance && entry.methodName === methodName && entry.args === args
  );
}

/**
 * Remove a promise entry from the registry
 */
function removePromiseEntry(instance: any, methodName: string, args: string): void {
  const index = activePromises.findIndex(
    (entry) => entry.instance === instance && entry.methodName === methodName && entry.args === args
  );
  if (index >= 0) {
    activePromises.splice(index, 1);
  }
}

/**
 * Options for the reusable decorator
 */
export interface ReusableOptions {
  /**
   * If true, the result will be cached forever (singleton pattern)
   * If false, the promise is only reused while pending
   */
  forever?: boolean;
}

/**
 * Decorator to reuse promises while they're pending, and optionally cache the result forever
 *
 * @example
 * ```typescript
 * class MyClass {
 *   // Reuse promise while pending (default behavior)
 *   @reusable()
 *   async fetchData() {
 *     return await fetch('...');
 *   }
 *
 *   // Cache result forever (singleton pattern)
 *   @reusable({forever: true})
 *   async init() {
 *     // This will only run once
 *     return await this.setup();
 *   }
 * }
 * ```
 */
export function reusable(options: ReusableOptions = {}): MethodDecorator {
  const {forever = false} = options;

  return function (target: any, propertyKey: string | symbol, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;
    const methodName = String(propertyKey);

    descriptor.value = function (...args: any[]) {
      // Serialize arguments for comparison
      const argsSerialised = args.length > 0 ? JSON.stringify(args) : '';

      // Check if we have an existing promise for this call
      const existingEntry = findPromiseEntry(this, methodName, argsSerialised);

      if (existingEntry) {
        // If already resolved and in forever mode, return cached value wrapped in promise
        if (existingEntry.resolved) {
          return Promise.resolve(existingEntry.value);
        }
        // If still pending, return the existing promise
        return existingEntry.promise;
      }

      // Create a new promise
      const newPromise = originalMethod.apply(this, args);

      // Store the promise entry
      const entry: PromiseEntry = {
        instance: this,
        methodName,
        args: argsSerialised,
        promise: newPromise,
        resolved: false,
      };

      activePromises.push(entry);

      // Handle resolution and cleanup
      // Don't change the promise chain, just observe it
      newPromise
        .then((value: any) => {
          if (forever) {
            // Store the result forever
            entry.resolved = true;
            entry.value = value;
          } else {
            // Clean up the entry
            removePromiseEntry(this, methodName, argsSerialised);
          }
        })
        .catch((error: any) => {
          // Always clean up on error (even in forever mode)
          // Don't rethrow - let the original promise handle rejection
          removePromiseEntry(this, methodName, argsSerialised);
        });

      return newPromise;
    };

    return descriptor;
  };
}

/**
 * Utility functions for testing and debugging
 */

/**
 * Get the number of active promise entries
 */
export function getActivePromiseCount(): number {
  return activePromises.length;
}

/**
 * Clear all active promise entries
 * Warning: This should only be used in tests
 */
export function clearActivePromises(): void {
  activePromises.length = 0;
}

/**
 * Get all active promise entries (for debugging)
 */
export function getActivePromises(): ReadonlyArray<Readonly<PromiseEntry>> {
  return activePromises;
}

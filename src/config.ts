// Decorator lib that allows class members to be loaded from config values or environment variables

/**
 * Example usage:
 *
 * @config
 * class MyClass {
 *   @config
 *   apiKey: string = "defaultKey";
 * }
 */


// Map of classes to their property keys and associated symbols
const classPropertyMap: Record<any, Record<string, Symbol>> = {};
// Track registered classes for prototype chain lookup
const registeredClasses: Set<any> = new Set();

// Symbol used to store the real class name on proxied instances
const REAL_CLASS_NAME = Symbol('configRealClassName');

function getConfigValue(target: any, propertyKey: string): any {
    // Find config property registration.
    // Check target.constructor first (direct match), then search all
    // registered classes for this property name (handles inheritance
    // through @config Proxy wrappers which break prototype chain identity).
    let privateSym: Symbol | undefined;
    privateSym = classPropertyMap[target.constructor]?.[String(propertyKey)];
    if (!privateSym) {
        for (const registeredClass of registeredClasses) {
            const sym = classPropertyMap[registeredClass]?.[String(propertyKey)];
            if (sym) {
                privateSym = sym;
                break;
            }
        }
    }
    if (privateSym) {
        // 1. check if there is a config value set on the instance
        if (target.config && target.config.hasOwnProperty(propertyKey)) {
            return target.config[propertyKey];
        }

        // 2. and 3. look up environment variables by class name, then by prefix
        const envValue = getEnvConfigValue(target, propertyKey);
        if (envValue !== undefined) {
            return envValue;
        }

        // otherwise fallback to object's value
    }
    return undefined;
}

/**
 * Look up `{CLASSNAME}_{KEY}` in the environment, then `{PREFIX}_{KEY}` for
 * each prefix in `instance.config.configPrefixes` (see addConfigPrefix()).
 * The class name is the real one stored by the @config Proxy when available,
 * falling back to instance.constructor.name, so a subclass of a @config-wrapped
 * base class resolves under its own name rather than the base class name.
 * @param instance Instance whose class name and prefixes to use
 * @param key Property or method name; upper-cased for the variable name
 * @returns The variable's value, or undefined when none is set
 */
export function getEnvConfigValue(instance: any, key: string): string | undefined {
    const className = (instance[REAL_CLASS_NAME] || instance.constructor.name).toUpperCase();
    const envKey = `${className}_${key.toUpperCase()}`;

    if (process.env.hasOwnProperty(envKey)) {
        return process.env[envKey];
    }

    const configObj = instance.config || {};
    if (configObj.configPrefixes) {
        const configPrefixes: string[] = Array.isArray(configObj.configPrefixes) ? configObj.configPrefixes : [configObj.configPrefixes];
        for (const prefix of configPrefixes) {
            if (prefix) {
                const prefixedEnvKey = `${prefix.toUpperCase()}_${key.toUpperCase()}`;
                if (process.env.hasOwnProperty(prefixedEnvKey)) {
                    return process.env[prefixedEnvKey];
                }
            }
        }
    }

    return undefined;
}

/**
 * Get all config keys and their resolved values for a class instance
 * @param instance Instance of a class decorated with @config
 * @returns Map of config key names to their resolved values
 */
export function getConfigKeys(instance: any): Map<string, any> {
    const result = new Map<string, any>();
    const seenKeys = new Set<string>();

    // Walk up the prototype chain to get config properties from all classes
    let currentProto = instance.constructor;
    while (currentProto) {
        const properties = classPropertyMap[currentProto];
        if (properties) {
            // Iterate through all config properties and resolve their values
            // Access through the instance to trigger the proxy getter and get the actual value
            for (const propertyKey of Object.keys(properties)) {
                // Only add if we haven't seen this key before (derived class takes precedence)
                if (!seenKeys.has(propertyKey)) {
                    seenKeys.add(propertyKey);
                    const value = instance[propertyKey];
                    // Include all values, even undefined, since they might be intentionally set
                    result.set(propertyKey, value);
                }
            }
        }

        // Move up the prototype chain
        currentProto = Object.getPrototypeOf(currentProto);

        // Stop at Object.prototype
        if (currentProto === Object || currentProto === Function.prototype) {
            break;
        }
    }

    return result;
}

export default function config(target: any, propertyKey?: string | symbol) {
    if (typeof propertyKey !== 'undefined') {
        // == Property decorator ==
        // create a unique symbol for this property
        const privateSym = Symbol("_" + propertyKey.toString() + "_config");

        // associate the symbol with the class and property key
        if (!classPropertyMap[target.constructor]) {
            classPropertyMap[target.constructor] = {};
        }
        classPropertyMap[target.constructor][propertyKey as string] = privateSym;
        registeredClasses.add(target.constructor);

        // delete the original property
        if (target.hasOwnProperty(propertyKey)) {
            delete target[propertyKey];
        }
    } else if (typeof target === 'function') {
        // == Class decorator ==

        // return proxy to log instance creation
        return new Proxy(target, {
            // override the construct method when creating new instances of the class
            // newTarget is the actual class being constructed (e.g., SubClass even
            // when the Proxy wraps BaseClass). This is critical for inheritance.
            construct: function (target, args, newTarget) {
                // Use Reflect.construct with newTarget to preserve the real
                // prototype chain. Without this, `new target(...args)` always
                // creates a BaseClass instance, losing the SubClass identity.
                const instance = Reflect.construct(target, args, newTarget);

                // Store the real class name so getConfigValue can use it
                // for env var lookup (SUBCLASSNAME_PROPERTY) instead of
                // the Proxy-wrapped base class name.
                instance[REAL_CLASS_NAME] = newTarget.name;

                // return a proxy of the instance
                return new Proxy(instance, {
                    // override getter for config property access
                    get(target, prop, receiver) {
                        const val = getConfigValue(target, String(prop));
                        if (typeof val !== 'undefined') {
                            // Coerce string env values to match the property's default type
                            if (typeof val === 'string') {
                                const defaultVal = target[prop];
                                if (typeof defaultVal === 'number') {
                                    const parsed = Number(val);
                                    return isNaN(parsed) ? defaultVal : parsed;
                                }
                                if (typeof defaultVal === 'boolean') {
                                    const lower = val.toLowerCase();
                                    return lower === 'true' || lower === '1';
                                }
                            }
                            return val;
                        }

                        // otherwise return the original property value
                        return Reflect.get(target, prop, receiver);
                    }
                });
            },
        });
    }
}

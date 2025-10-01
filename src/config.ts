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

function getConfigValue(target: any, propertyKey: string, configPrefixes: string[]): any {
    const privateSym = classPropertyMap[target.constructor]?.[String(propertyKey)];
    if (privateSym) {
        // 1. check if there is a config value set on the instance
        if (target.config && target.config.hasOwnProperty(propertyKey)) {
            return target.config[propertyKey];
        }

        // 2. look up environment variable based on class name and property key
        const className = target.constructor.name.toUpperCase();
        const envKey = `${className}_${propertyKey.toUpperCase()}`;

        if (process.env.hasOwnProperty(envKey)) {
            return process.env[envKey];
        }

        // 3. check configPrefixes as well as class name
        for (const prefix of configPrefixes) {
            if (prefix) {
                const prefixedEnvKey = `${prefix.toUpperCase()}_${propertyKey.toUpperCase()}`;
                if (process.env.hasOwnProperty(prefixedEnvKey)) {
                    return process.env[prefixedEnvKey];
                }
            }
        }

        // otherwise fallback to object's value
    }
    return undefined;
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

        // delete the original property
        if (target.hasOwnProperty(propertyKey)) {
            delete target[propertyKey];
        }
    } else if (typeof target === 'function') {
        // == Class decorator ==

        // return proxy to log instance creation
        return new Proxy(target, {
            // override the construct method when creating new instances of the class
            construct: function (target, args) {
                const configObj = args[0]?.config || {};
                // check for any configPrefixes (could be an array)
                const configPrefixes: string[] = Array.isArray(configObj.configPrefixes) ? configObj.configPrefixes : [configObj.configPrefixes];

                // return *another* proxy, this time of the instance itself
                return new Proxy(new target(...args), {
                    // override getter to log property access
                    get(target, prop, receiver) {
                        const val = getConfigValue(target, String(prop), configPrefixes);
                        if (typeof val !== 'undefined') {
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

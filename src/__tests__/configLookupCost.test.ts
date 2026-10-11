/**
 * The @config instance Proxy runs getConfigValue on EVERY property access,
 * methods included. Its registry used to be a plain object keyed by the class,
 * which coerces the class to a string key: the whole class source, rebuilt on
 * each lookup and again for every registered class when the direct lookup
 * missed. Profiling a long-running process with every park loaded put three
 * quarters of its CPU time here.
 *
 * A class whose static toString throws makes any such coercion fail loudly.
 */

import { describe, test, expect } from 'vitest';
import config, { getConfigKeys } from '../config.js';

describe('@config lookups never stringify a class', () => {
  @config
  class NoStringifyBase {
    static toString(): string {
      throw new Error('class was coerced to a string');
    }

    @config
    apiKey: string = 'default-key';

    plain: string = 'plain-value';

    greet(): string {
      return 'hello';
    }
  }

  test('registration, config reads, plain reads and method reads', () => {
    const instance: any = new NoStringifyBase();
    expect(instance.apiKey).toBe('default-key');
    expect(instance.plain).toBe('plain-value');
    expect(instance.greet()).toBe('hello');
    expect(instance.notAProperty).toBeUndefined();
  });

  test('config and env overrides still resolve', () => {
    const fromConfig: any = new (NoStringifyBase as any)();
    fromConfig.config = { apiKey: 'from-config' };
    expect(fromConfig.apiKey).toBe('from-config');

    process.env.NOSTRINGIFYBASE_APIKEY = 'from-env';
    try {
      const fromEnv: any = new NoStringifyBase();
      expect(fromEnv.apiKey).toBe('from-env');
    } finally {
      delete process.env.NOSTRINGIFYBASE_APIKEY;
    }
  });

  test('getConfigKeys', () => {
    const instance: any = new NoStringifyBase();
    expect(getConfigKeys(instance).get('apiKey')).toBe('default-key');
  });
});

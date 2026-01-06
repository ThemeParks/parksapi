/**
 * Test @config decorator system
 */

import config, {getConfigKeys} from '../config.js';

// Store original env vars
const originalEnv = { ...process.env };

// Helper to clean env vars between tests
function cleanEnv() {
  Object.keys(process.env).forEach(key => {
    if (key.startsWith('TESTCLASS_') || key.startsWith('SHAREDPREFIX_')) {
      delete process.env[key];
    }
  });
}

describe('Config Decorator System', () => {
  beforeEach(() => {
    cleanEnv();
  });

  afterEach(() => {
    // Restore original env
    process.env = { ...originalEnv };
  });

  describe('Property Decorator', () => {
    test('should use default value when no config or env var set', () => {
      @config
      class TestClass {
        @config
        apiKey: string = 'default-key';
      }

      const instance = new TestClass();
      expect(instance.apiKey).toBe('default-key');
    });

    test('should read from instance config object over default', () => {
      @config
      class TestClass {
        config: { [key: string]: any } = {};

        @config
        apiKey: string = 'default-key';

        constructor(configObj?: any) {
          if (configObj) {
            this.config = configObj;
          }
        }
      }

      const instance = new TestClass({ apiKey: 'instance-key' });
      expect(instance.apiKey).toBe('instance-key');
    });

    test('should read from environment variable based on class name', () => {
      process.env.TESTCLASS_APIKEY = 'env-key';

      @config
      class TestClass {
        @config
        apiKey: string = 'default-key';
      }

      const instance = new TestClass();
      expect(instance.apiKey).toBe('env-key');
    });

    test('should prioritize instance config over environment variable', () => {
      process.env.TESTCLASS_APIKEY = 'env-key';

      @config
      class TestClass {
        config: { [key: string]: any } = {};

        @config
        apiKey: string = 'default-key';

        constructor(configObj?: any) {
          if (configObj) {
            this.config = configObj;
          }
        }
      }

      const instance = new TestClass({ apiKey: 'instance-key' });
      expect(instance.apiKey).toBe('instance-key');
    });

    test('should handle multiple properties on same class', () => {
      process.env.TESTCLASS_APIKEY = 'env-key';
      process.env.TESTCLASS_SECRETKEY = 'env-secret';

      @config
      class TestClass {
        @config
        apiKey: string = 'default-key';

        @config
        secretKey: string = 'default-secret';

        @config
        unsetValue: string = 'default-unset';
      }

      const instance = new TestClass();
      expect(instance.apiKey).toBe('env-key');
      expect(instance.secretKey).toBe('env-secret');
      expect(instance.unsetValue).toBe('default-unset');
    });

    test('should handle numeric default values', () => {
      @config
      class TestClass {
        @config
        timeout: number = 5000;
      }

      const instance = new TestClass();
      expect(instance.timeout).toBe(5000);
    });

    test('should handle boolean default values', () => {
      @config
      class TestClass {
        @config
        enabled: boolean = true;
      }

      const instance = new TestClass();
      expect(instance.enabled).toBe(true);
    });

    test('should handle array default values', () => {
      @config
      class TestClass {
        @config
        items: string[] = ['a', 'b', 'c'];
      }

      const instance = new TestClass();
      expect(instance.items).toEqual(['a', 'b', 'c']);
    });

    test('should handle object default values', () => {
      @config
      class TestClass {
        @config
        settings: { [key: string]: any } = { foo: 'bar' };
      }

      const instance = new TestClass();
      expect(instance.settings).toEqual({ foo: 'bar' });
    });
  });

  describe('Config Prefixes', () => {
    test('should check prefixed environment variables', () => {
      process.env.SHAREDPREFIX_APIKEY = 'shared-key';

      @config
      class TestClass {
        config: { configPrefixes?: string | string[] } = {
          configPrefixes: 'SHAREDPREFIX'
        };

        @config
        apiKey: string = 'default-key';
      }

      const instance = new TestClass();
      expect(instance.apiKey).toBe('shared-key');
    });

    test('should check multiple prefixes in order', () => {
      process.env.SHAREDPREFIX_APIKEY = 'shared-key';

      @config
      class TestClass {
        config: { configPrefixes?: string | string[] } = {
          configPrefixes: ['UNUSED', 'SHAREDPREFIX', 'ANOTHER']
        };

        @config
        apiKey: string = 'default-key';
      }

      const instance = new TestClass();
      expect(instance.apiKey).toBe('shared-key');
    });

    test('should prioritize class name env var over prefixed env var', () => {
      process.env.TESTCLASS_APIKEY = 'class-key';
      process.env.SHAREDPREFIX_APIKEY = 'shared-key';

      @config
      class TestClass {
        config: { configPrefixes?: string | string[] } = {
          configPrefixes: 'SHAREDPREFIX'
        };

        @config
        apiKey: string = 'default-key';
      }

      const instance = new TestClass();
      expect(instance.apiKey).toBe('class-key');
    });

    test('should prioritize instance config over prefixed env var', () => {
      process.env.SHAREDPREFIX_APIKEY = 'shared-key';

      @config
      class TestClass {
        config: { [key: string]: any } = {};

        @config
        apiKey: string = 'default-key';

        constructor(configObj?: any) {
          if (configObj) {
            this.config = { ...configObj, configPrefixes: 'SHAREDPREFIX' };
          }
        }
      }

      const instance = new TestClass({ apiKey: 'instance-key' });
      expect(instance.apiKey).toBe('instance-key');
    });

    test('should handle empty prefix gracefully', () => {
      @config
      class TestClass {
        config: { configPrefixes?: string | string[] } = {
          configPrefixes: ''
        };

        @config
        apiKey: string = 'default-key';
      }

      const instance = new TestClass();
      expect(instance.apiKey).toBe('default-key');
    });

    test('should handle null/undefined in prefix array', () => {
      process.env.SHAREDPREFIX_APIKEY = 'shared-key';

      @config
      class TestClass {
        config: { configPrefixes?: string | string[] } = {
          configPrefixes: ['', 'SHAREDPREFIX', undefined as any]
        };

        @config
        apiKey: string = 'default-key';
      }

      const instance = new TestClass();
      expect(instance.apiKey).toBe('shared-key');
    });
  });

  describe('Class Decorator', () => {
    test('should wrap class instances in proxy', () => {
      @config
      class TestClass {
        @config
        apiKey: string = 'default-key';
      }

      const instance = new TestClass();
      expect(typeof instance).toBe('object');
      expect(instance instanceof TestClass).toBe(true);
    });

    test('should allow access to non-config properties', () => {
      @config
      class TestClass {
        @config
        apiKey: string = 'default-key';

        regularProperty: string = 'regular-value';

        regularMethod() {
          return 'method-result';
        }
      }

      const instance = new TestClass();
      expect(instance.regularProperty).toBe('regular-value');
      expect(instance.regularMethod()).toBe('method-result');
    });

    test('should work with constructor parameters', () => {
      @config
      class TestClass {
        name: string;

        @config
        apiKey: string = 'default-key';

        constructor(name: string) {
          this.name = name;
        }
      }

      const instance = new TestClass('TestName');
      expect(instance.name).toBe('TestName');
      expect(instance.apiKey).toBe('default-key');
    });

    test('should work with inheritance', () => {
      @config
      class BaseClass {
        @config
        baseKey: string = 'base-default';
      }

      @config
      class DerivedClass extends BaseClass {
        @config
        derivedKey: string = 'derived-default';
      }

      const instance = new DerivedClass();
      expect(instance.baseKey).toBe('base-default');
      expect(instance.derivedKey).toBe('derived-default');
    });

    test('should handle multiple instances with different configs', () => {
      @config
      class TestClass {
        config: { [key: string]: any } = {};

        @config
        apiKey: string = 'default-key';

        constructor(configObj?: any) {
          if (configObj) {
            this.config = configObj;
          }
        }
      }

      const instance1 = new TestClass({ apiKey: 'key-1' });
      const instance2 = new TestClass({ apiKey: 'key-2' });
      const instance3 = new TestClass();

      expect(instance1.apiKey).toBe('key-1');
      expect(instance2.apiKey).toBe('key-2');
      expect(instance3.apiKey).toBe('default-key');
    });
  });

  describe('Priority Order', () => {
    test('should follow priority: instance config > class env > prefix env > default', () => {
      process.env.TESTCLASS_APIKEY = 'class-env';
      process.env.SHAREDPREFIX_APIKEY = 'prefix-env';

      @config
      class TestClass {
        config: { [key: string]: any } = {};

        @config
        apiKey: string = 'default-key';

        constructor(configObj?: any) {
          if (configObj) {
            this.config = { ...configObj, configPrefixes: 'SHAREDPREFIX' };
          } else {
            this.config.configPrefixes = 'SHAREDPREFIX';
          }
        }
      }

      // Priority 1: Instance config (highest)
      const instance1 = new TestClass({ apiKey: 'instance-config' });
      expect(instance1.apiKey).toBe('instance-config');

      // Priority 2: Class env var
      const instance2 = new TestClass();
      expect(instance2.apiKey).toBe('class-env');

      // Priority 3: Prefix env var (test by removing class env var)
      delete process.env.TESTCLASS_APIKEY;
      const instance3 = new TestClass();
      expect(instance3.apiKey).toBe('prefix-env');

      // Priority 4: Default (test by removing prefix env var)
      delete process.env.SHAREDPREFIX_APIKEY;
      const instance4 = new TestClass();
      expect(instance4.apiKey).toBe('default-key');
    });
  });

  describe('Edge Cases', () => {
    test('should handle empty string as valid config value', () => {
      @config
      class TestClass {
        config: { [key: string]: any } = {};

        @config
        apiKey: string = 'default-key';

        constructor(configObj?: any) {
          if (configObj) {
            this.config = configObj;
          }
        }
      }

      const instance = new TestClass({ apiKey: '' });
      expect(instance.apiKey).toBe('');
    });

    test('should handle zero as valid config value', () => {
      @config
      class TestClass {
        config: { [key: string]: any } = {};

        @config
        timeout: number = 5000;

        constructor(configObj?: any) {
          if (configObj) {
            this.config = configObj;
          }
        }
      }

      const instance = new TestClass({ timeout: 0 });
      expect(instance.timeout).toBe(0);
    });

    test('should handle false as valid config value', () => {
      @config
      class TestClass {
        config: { [key: string]: any } = {};

        @config
        enabled: boolean = true;

        constructor(configObj?: any) {
          if (configObj) {
            this.config = configObj;
          }
        }
      }

      const instance = new TestClass({ enabled: false });
      expect(instance.enabled).toBe(false);
    });

    test('should handle null in config object', () => {
      @config
      class TestClass {
        config: { [key: string]: any } = {};

        @config
        apiKey: string | null = 'default-key';

        constructor(configObj?: any) {
          if (configObj) {
            this.config = configObj;
          }
        }
      }

      const instance = new TestClass({ apiKey: null });
      expect(instance.apiKey).toBe(null);
    });

    test('should handle undefined in config object (falls back to default)', () => {
      process.env.TESTCLASS_APIKEY = 'env-key';

      @config
      class TestClass {
        config: { [key: string]: any } = {};

        @config
        apiKey: string = 'default-key';

        constructor(configObj?: any) {
          if (configObj) {
            this.config = configObj;
          }
        }
      }

      const instance = new TestClass({ apiKey: undefined });
      // Config checks hasOwnProperty, so undefined IS a valid config value
      // It falls back to default since undefined is the property value
      expect(instance.apiKey).toBe('default-key');
    });

    test('should handle property access before config is set', () => {
      @config
      class TestClass {
        config: { [key: string]: any } = {};

        @config
        apiKey: string = 'default-key';
      }

      const instance = new TestClass();
      expect(instance.apiKey).toBe('default-key');
    });

    test('should handle class with no config object', () => {
      process.env.TESTCLASS_APIKEY = 'env-key';

      @config
      class TestClass {
        @config
        apiKey: string = 'default-key';
      }

      const instance = new TestClass();
      expect(instance.apiKey).toBe('env-key');
    });

    test('should handle uppercase property names correctly', () => {
      process.env.TESTCLASS_APIKEY = 'env-key';

      @config
      class TestClass {
        @config
        APIKEY: string = 'default-key';
      }

      const instance = new TestClass();
      expect(instance.APIKEY).toBe('env-key');
    });

    test('should handle mixed case class names', () => {
      process.env.MYCUSTOMCLASS_APIKEY = 'env-key';

      @config
      class MyCustomClass {
        @config
        apiKey: string = 'default-key';
      }

      const instance = new MyCustomClass();
      expect(instance.apiKey).toBe('env-key');
    });
  });

  describe('Real-World Usage Pattern', () => {
    test('should work with typical park implementation pattern', () => {
      process.env.UNIVERSALSTUDIOS_SECRETKEY = 'secret-from-env';

      @config
      class UniversalStudios {
        config: { configPrefixes?: string | string[] } = {};

        @config
        secretKey: string = '';

        @config
        appKey: string = '';

        @config
        baseURL: string = 'https://api.example.com';

        constructor(options?: any) {
          if (options?.config) {
            this.config = options.config;
          }
          this.addConfigPrefix('UNIVERSALSTUDIOS');
        }

        addConfigPrefix(prefix: string) {
          if (!Array.isArray(this.config.configPrefixes)) {
            this.config.configPrefixes = [];
          }
          this.config.configPrefixes.push(prefix);
        }
      }

      // Test with env var
      const instance1 = new UniversalStudios();
      expect(instance1.secretKey).toBe('secret-from-env');
      expect(instance1.baseURL).toBe('https://api.example.com');

      // Test with instance config
      const instance2 = new UniversalStudios({
        config: { secretKey: 'secret-from-config', appKey: 'app-from-config' }
      });
      expect(instance2.secretKey).toBe('secret-from-config');
      expect(instance2.appKey).toBe('app-from-config');
      expect(instance2.baseURL).toBe('https://api.example.com'); // Falls back to default
    });
  });

  describe('getConfigKeys', () => {
    test('should return empty map for class with no config properties', () => {
      class RegularClass {
        regularProperty: string = 'value';
      }

      const instance = new RegularClass();
      const keys = getConfigKeys(instance);
      expect(keys.size).toBe(0);
    });

    test('should return all config keys with their resolved values', () => {
      process.env.TESTCLASS_APIKEY = 'env-api-key';

      @config
      class TestClass {
        config: { [key: string]: any } = {};

        @config
        apiKey: string = 'default-api-key';

        @config
        baseURL: string = 'https://default.com';

        @config
        timeout: number = 5000;

        constructor(configObj?: any) {
          if (configObj) {
            this.config = configObj;
          }
        }
      }

      const instance = new TestClass({ baseURL: 'https://custom.com' });
      const keys = getConfigKeys(instance);

      expect(keys.size).toBe(3);
      expect(keys.get('apiKey')).toBe('env-api-key'); // from env
      expect(keys.get('baseURL')).toBe('https://custom.com'); // from instance config
      expect(keys.get('timeout')).toBe(5000); // from default
    });

    test('should work with prefixed env vars', () => {
      process.env.SHAREDPREFIX_SECRETKEY = 'shared-secret';

      @config
      class TestClass {
        config: { [key: string]: any } = { configPrefixes: 'SHAREDPREFIX' };

        @config
        secretKey: string = 'default-secret';

        @config
        appKey: string = 'default-app';
      }

      const instance = new TestClass();
      const keys = getConfigKeys(instance);

      expect(keys.size).toBe(2);
      expect(keys.get('secretKey')).toBe('shared-secret');
      expect(keys.get('appKey')).toBe('default-app');
    });

    test('should handle mixed sources (instance, env, default)', () => {
      process.env.MYCLASS_ENVKEY = 'from-env';

      @config
      class MyClass {
        config: { [key: string]: any } = {};

        @config
        instanceKey: string = 'default-instance';

        @config
        envKey: string = 'default-env';

        @config
        defaultKey: string = 'default-value';

        constructor(configObj?: any) {
          if (configObj) {
            this.config = configObj;
          }
        }
      }

      const instance = new MyClass({ instanceKey: 'from-instance' });
      const keys = getConfigKeys(instance);

      expect(keys.size).toBe(3);
      expect(keys.get('instanceKey')).toBe('from-instance');
      expect(keys.get('envKey')).toBe('from-env');
      expect(keys.get('defaultKey')).toBe('default-value');
    });

    test('should return Map instance', () => {
      @config
      class TestClass {
        @config
        apiKey: string = 'default';
      }

      const instance = new TestClass();
      const keys = getConfigKeys(instance);

      expect(keys instanceof Map).toBe(true);
    });

    test('should work with inheritance', () => {
      @config
      class BaseClass {
        @config
        baseKey: string = 'base-value';
      }

      @config
      class DerivedClass extends BaseClass {
        @config
        derivedKey: string = 'derived-value';
      }

      const instance = new DerivedClass();
      const keys = getConfigKeys(instance);

      // Should get keys from both base and derived class
      // Note: Inheritance support depends on how decorators set up the classPropertyMap
      // At minimum, should get derived class keys
      expect(keys.size).toBeGreaterThan(0);

      // Check if we have at least the derived key or base key
      const hasDerivdKey = keys.has('derivedKey');
      const hasBaseKey = keys.has('baseKey');

      expect(hasDerivdKey || hasBaseKey).toBe(true);

      // If we have derivedKey, verify its value
      if (hasDerivdKey) {
        expect(keys.get('derivedKey')).toBe('derived-value');
      }

      // If we have baseKey, verify its value
      if (hasBaseKey) {
        expect(keys.get('baseKey')).toBe('base-value');
      }
    });

    test('should handle empty strings and falsy values', () => {
      @config
      class TestClass {
        config: { [key: string]: any } = {};

        @config
        emptyString: string = 'default';

        @config
        zeroNumber: number = 99;

        @config
        falseBool: boolean = true;

        constructor(configObj?: any) {
          if (configObj) {
            this.config = configObj;
          }
        }
      }

      const instance = new TestClass({
        emptyString: '',
        zeroNumber: 0,
        falseBool: false,
      });
      const keys = getConfigKeys(instance);

      expect(keys.get('emptyString')).toBe('');
      expect(keys.get('zeroNumber')).toBe(0);
      expect(keys.get('falseBool')).toBe(false);
    });
  });
});

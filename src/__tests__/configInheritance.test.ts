/**
 * Test @config property resolution across class inheritance.
 *
 * The @config system wraps classes in Proxies. When a base class has @config
 * properties and a subclass extends it, the Proxy wrappers can break
 * prototype chain identity — causing property lookups to fail silently.
 *
 * These tests cover every combination of config property access patterns
 * that park implementations use.
 */

import { describe, test, expect, afterAll } from 'vitest';
import config from '../config.js';
import { Destination, DestinationConstructor } from '../destination.js';
import { Entity, LiveData, EntitySchedule } from '@themeparks/typelib';
import { stopHttpQueue } from '../http.js';

afterAll(() => {
  stopHttpQueue();
});

// ============================================================================
// Use Case 1: Direct class name resolution
// Base class has @config property, subclass inherits it.
// Env var matches SUBCLASS name, not base class name.
// ============================================================================

describe('Use Case 1: Subclass name resolves base class @config property', () => {
  test('env var SUBCLASS_PROP resolves when property is defined on base class', () => {
    process.env.UCCSUBCLASS_MYPROP = 'from-subclass-env';

    @config
    class UCCBase {
      @config
      myProp: string = 'default';
    }

    const UCCSubclass = config(class UCCSubclass extends UCCBase {}) as any;

    const instance = new UCCSubclass();
    expect(instance.myProp).toBe('from-subclass-env');

    delete process.env.UCCSUBCLASS_MYPROP;
  });

  test('falls back to base class default when no env var set', () => {
    @config
    class UCCBase2 {
      @config
      myProp: string = 'base-default';
    }

    const UCCSubclass2 = config(class UCCSubclass2 extends UCCBase2 {}) as any;

    const instance = new UCCSubclass2();
    expect(instance.myProp).toBe('base-default');
  });

  test('env var BASECLASS_PROP resolves when only base class env var is set', () => {
    process.env.UCCBASE3_MYPROP = 'from-base-env';

    @config
    class UCCBase3 {
      @config
      myProp: string = 'default';
    }

    const instance = new UCCBase3();
    expect(instance.myProp).toBe('from-base-env');

    delete process.env.UCCBASE3_MYPROP;
  });
});

// ============================================================================
// Use Case 2: Config prefix resolution
// Subclass adds a config prefix. Env var matches the PREFIX, not class name.
// This is the Parcs Reunidos / Cedar Fair pattern.
// ============================================================================

describe('Use Case 2: Config prefix resolves base class @config property', () => {
  test('prefix env var resolves when property is defined on base class', () => {
    process.env.MYPREFIX2_BASEPROP = 'from-prefix';

    @config
    class PrefixBase extends Destination {
      @config
      baseProp: string = '';

      constructor(options?: DestinationConstructor) {
        super(options);
        this.addConfigPrefix('SHARED');
      }

      protected async buildEntityList(): Promise<Entity[]> { return []; }
      protected async buildLiveData(): Promise<LiveData[]> { return []; }
      protected async buildSchedules(): Promise<EntitySchedule[]> { return []; }
      async getDestinations(): Promise<Entity[]> { return []; }
    }

    const PrefixSub = config(class PrefixSub extends PrefixBase {
      constructor(options?: DestinationConstructor) {
        super(options);
        this.addConfigPrefix('MYPREFIX2');
      }
    }) as any;

    const instance = new PrefixSub();
    expect(instance.baseProp).toBe('from-prefix');

    delete process.env.MYPREFIX2_BASEPROP;
  });
});

// ============================================================================
// Use Case 3: Multiple subclasses, independent env vars
// Two subclasses of the same base class resolve DIFFERENT env vars.
// This is the core Parcs Reunidos pattern.
// ============================================================================

describe('Use Case 3: Multiple subclasses resolve independently', () => {
  test('two subclasses get different values for same base class property', () => {
    process.env.PARKA3_SHAREDPROP = 'park-a-value';
    process.env.PARKB3_SHAREDPROP = 'park-b-value';

    @config
    class MultiBase extends Destination {
      @config
      sharedProp: string = '';

      constructor(options?: DestinationConstructor) {
        super(options);
      }

      protected async buildEntityList(): Promise<Entity[]> { return []; }
      protected async buildLiveData(): Promise<LiveData[]> { return []; }
      protected async buildSchedules(): Promise<EntitySchedule[]> { return []; }
      async getDestinations(): Promise<Entity[]> { return []; }
    }

    const ParkA3 = config(class ParkA3 extends MultiBase {
      constructor(options?: DestinationConstructor) {
        super(options);
        this.addConfigPrefix('PARKA3');
      }
    }) as any;

    const ParkB3 = config(class ParkB3 extends MultiBase {
      constructor(options?: DestinationConstructor) {
        super(options);
        this.addConfigPrefix('PARKB3');
      }
    }) as any;

    const a = new ParkA3();
    const b = new ParkB3();

    expect(a.sharedProp).toBe('park-a-value');
    expect(b.sharedProp).toBe('park-b-value');

    delete process.env.PARKA3_SHAREDPROP;
    delete process.env.PARKB3_SHAREDPROP;
  });
});

// ============================================================================
// Use Case 4: Subclass class name takes priority over prefix
// Env var matching CLASSNAME should be checked BEFORE prefix.
// ============================================================================

describe('Use Case 4: Class name takes priority over config prefix', () => {
  test('SUBCLASSNAME_PROP wins over PREFIX_PROP', () => {
    process.env.UC4SUB_MYPROP = 'from-classname';
    process.env.UC4PREFIX_MYPROP = 'from-prefix';

    @config
    class UC4Base extends Destination {
      @config
      myProp: string = '';

      constructor(options?: DestinationConstructor) {
        super(options);
      }

      protected async buildEntityList(): Promise<Entity[]> { return []; }
      protected async buildLiveData(): Promise<LiveData[]> { return []; }
      protected async buildSchedules(): Promise<EntitySchedule[]> { return []; }
      async getDestinations(): Promise<Entity[]> { return []; }
    }

    const UC4Sub = config(class UC4Sub extends UC4Base {
      constructor(options?: DestinationConstructor) {
        super(options);
        this.addConfigPrefix('UC4PREFIX');
      }
    }) as any;

    const instance = new UC4Sub();
    // Class name should win over prefix
    expect(instance.myProp).toBe('from-classname');

    delete process.env.UC4SUB_MYPROP;
    delete process.env.UC4PREFIX_MYPROP;
  });
});

// ============================================================================
// Use Case 5: Deep inheritance chain
// GrandChild extends Child extends Base, property on Base.
// ============================================================================

describe('Use Case 5: Deep inheritance chain', () => {
  test('grandchild resolves property defined on grandparent', () => {
    process.env.UC5GRANDCHILD_DEEPPROP = 'deep-value';

    @config
    class UC5Base {
      @config
      deepProp: string = '';
    }

    @config
    class UC5Child extends UC5Base {}

    const UC5GrandChild = config(class UC5GrandChild extends UC5Child {}) as any;

    const instance = new UC5GrandChild();
    expect(instance.deepProp).toBe('deep-value');

    delete process.env.UC5GRANDCHILD_DEEPPROP;
  });
});

// ============================================================================
// Use Case 6: Property on base class, accessed inside a method
// This is what @http methods do — access this.apiBase inside a method body.
// ============================================================================

describe('Use Case 6: Property accessed inside method body', () => {
  test('base class @config property resolves correctly inside subclass method', () => {
    process.env.UC6PREFIX_APIBASE = 'https://api.example.com';

    @config
    class UC6Base extends Destination {
      @config
      apiBase: string = '';

      constructor(options?: DestinationConstructor) {
        super(options);
      }

      getUrl(): string {
        return `${this.apiBase}/endpoint`;
      }

      protected async buildEntityList(): Promise<Entity[]> { return []; }
      protected async buildLiveData(): Promise<LiveData[]> { return []; }
      protected async buildSchedules(): Promise<EntitySchedule[]> { return []; }
      async getDestinations(): Promise<Entity[]> { return []; }
    }

    const UC6Sub = config(class UC6Sub extends UC6Base {
      constructor(options?: DestinationConstructor) {
        super(options);
        this.addConfigPrefix('UC6PREFIX');
      }
    }) as any;

    const instance = new UC6Sub();
    expect(instance.getUrl()).toBe('https://api.example.com/endpoint');

    delete process.env.UC6PREFIX_APIBASE;
  });
});

// ============================================================================
// Use Case 7: @destinationController auto-applies @config
// Matches the real-world pattern exactly.
// ============================================================================

describe('Use Case 7: @destinationController + base class @config properties', () => {
  test('destinationController subclass resolves base class properties via prefix', () => {
    process.env.UC7PARK_PARKID = '42';
    process.env.UC7SHARED_AUTHTOKEN = 'secret-token';

    // Note: can't use @destinationController in tests (would register
    // in the global registry). Instead, simulate what it does: apply config().
    @config
    class UC7Framework extends Destination {
      @config parkId: string = '';
      @config authToken: string = '';

      constructor(options?: DestinationConstructor) {
        super(options);
        this.addConfigPrefix('UC7SHARED');
      }

      protected async buildEntityList(): Promise<Entity[]> { return []; }
      protected async buildLiveData(): Promise<LiveData[]> { return []; }
      protected async buildSchedules(): Promise<EntitySchedule[]> { return []; }
      async getDestinations(): Promise<Entity[]> { return []; }
    }

    // Simulate @destinationController which calls config(target) internally
    const UC7Park = config(class UC7Park extends UC7Framework {
      constructor(options?: DestinationConstructor) {
        super(options);
        this.addConfigPrefix('UC7PARK');
      }
    }) as any;

    const instance = new UC7Park();
    expect(instance.parkId).toBe('42');           // From UC7PARK prefix
    expect(instance.authToken).toBe('secret-token'); // From UC7SHARED prefix

    delete process.env.UC7PARK_PARKID;
    delete process.env.UC7SHARED_AUTHTOKEN;
  });
});

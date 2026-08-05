/**
 * Guard for the build pipeline, not for any one library.
 *
 * Test files are excluded from tsconfig.json (they must not reach `dist/`),
 * and Vite's transformer resolves each file against that config to decide
 * whether to apply `experimentalDecorators`. An excluded file gets no
 * decorator support, so the syntax is emitted verbatim and every test that
 * declares a decorated class dies at import with
 * `SyntaxError: Invalid or unexpected token`.
 *
 * Older Vite applied the options regardless of the exclusion, which hid the
 * problem until a Vite bump surfaced it across 19 files at once. vitest.config
 * now states `oxc.decorator` explicitly; this file is the assertion that it
 * still holds, and it fails as one named test rather than as a wall of syntax
 * errors.
 *
 * Nearly every core test declares decorated classes inline (@config, @cache,
 * @http, @inject), so a regression here takes most of the suite with it.
 */

import {describe, expect, test} from 'vitest';

describe('decorator transform in test files', () => {
  test('class decorators run', () => {
    const seen: string[] = [];

    function tagClass(target: any) {
      seen.push(target.name);
    }

    @tagClass
    class Decorated {}

    // Reference the class so it cannot be elided.
    expect(Decorated.name).toBe('Decorated');
    expect(seen).toEqual(['Decorated']);
  });

  test('property decorators run and receive the property key', () => {
    const seen: string[] = [];

    function tagProperty(_target: any, key: string) {
      seen.push(key);
    }

    class Decorated {
      @tagProperty apiKey: string = '';
      @tagProperty timeout: number = 0;
    }

    expect(new Decorated().apiKey).toBe('');
    expect(seen).toEqual(['apiKey', 'timeout']);
  });

  test('method decorators can wrap the descriptor', () => {
    function double(_target: any, _key: string, descriptor: PropertyDescriptor) {
      const original = descriptor.value;
      descriptor.value = function (this: unknown, ...args: number[]) {
        return original.apply(this, args) * 2;
      };
      return descriptor;
    }

    class Decorated {
      @double
      value(n: number): number {
        return n + 1;
      }
    }

    // Undecorated this would be 4, so the wrapper demonstrably applied.
    expect(new Decorated().value(3)).toBe(8);
  });

  test('decorator factories receive their arguments', () => {
    const seen: Array<{key: string; opts: {ttl: number}}> = [];

    function withOptions(opts: {ttl: number}) {
      return function (_target: any, key: string) {
        seen.push({key, opts});
      };
    }

    class Decorated {
      @withOptions({ttl: 60}) cached: string = '';
    }

    expect(new Decorated().cached).toBe('');
    expect(seen).toEqual([{key: 'cached', opts: {ttl: 60}}]);
  });
});

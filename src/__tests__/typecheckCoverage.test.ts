import {describe, it, expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';

/**
 * The gate that keeps the test files typechecked.
 *
 * `tsconfig.json` excludes `**\/__tests__` and `**\/*.test.ts`, and it has to:
 * `npm run build` emits to `dist/`, and the tests must not land there. For a
 * long time that exclusion also meant NOTHING typechecked them. vitest strips
 * types with esbuild without checking them, and the pre-commit hook's
 * `tsc --noEmit` used the same excluding config, so a test file could say
 * anything at all.
 *
 * What that costs is invisible by construction. Change an exported function's
 * signature and every call site in the tests keeps compiling: a dropped
 * argument simply arrives as `undefined`, and whether anyone notices depends on
 * whether the function happens to dereference it. Found live in
 * `showAbsence.test.ts`, which passed `true` into `showBillAuthority`'s
 * `closedDates: ReadonlySet<string>` parameter at two call sites. The only
 * reason the suite stayed green is that `closedDates.has()` sits on a branch
 * those two cases never reach.
 *
 * `tsconfig.test.json` is the base config plus the tests, with `noEmit`, so the
 * exclusion that protects `dist/` no longer costs the coverage. This test
 * exists so that arrangement cannot be quietly undone: deleting the config,
 * dropping the npm script, or reverting the hook to the excluding config all
 * fail here.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');
const readJson = (p: string) => JSON.parse(read(p).replace(/^\s*\/\/.*$/gm, ''));

describe('the test files are typechecked by something', () => {
  it('tsconfig.json still keeps tests out of the build', () => {
    // Not a nicety: without this they are emitted into dist/ and shipped.
    const base = readJson('tsconfig.json');
    expect(base.exclude).toContain('**/__tests__');
    expect(base.exclude).toContain('**/*.test.ts');
  });

  it('tsconfig.test.json exists, extends the base, and does NOT exclude tests', () => {
    const test = readJson('tsconfig.test.json');
    expect(test.extends).toBe('./tsconfig.json');
    // noEmit is what makes including them safe.
    expect(test.compilerOptions?.noEmit).toBe(true);
    for (const pattern of ['**/__tests__', '**/*.test.ts']) {
      expect(test.exclude ?? []).not.toContain(pattern);
    }
    expect(test.include).toContain('src/**/*');
  });

  it('vitest globals are declared, or every describe/test/expect is an error', () => {
    const test = readJson('tsconfig.test.json');
    expect(test.compilerOptions?.types ?? []).toContain('vitest/globals');
  });

  it('npm run typecheck points at the test config, not the base one', () => {
    const pkg = readJson('package.json');
    const script = pkg.scripts?.typecheck;
    expect(script, 'package.json needs a "typecheck" script').toBeTruthy();
    expect(script).toContain('tsconfig.test.json');
    expect(script).toContain('--noEmit');
  });

  it('the pre-commit hook typechecks with the test config', () => {
    const hook = read('.githooks/pre-commit');
    expect(hook).toContain('tsconfig.test.json');
    // A bare `tsc --noEmit` here would silently drop the tests again.
    expect(hook).not.toMatch(/^\s*npx tsc --noEmit\s*(\|\||$)/m);
  });

  it('CI runs the typecheck too, so a hook bypass does not land it', () => {
    const ci = read('.github/workflows/unit_test.js.yml');
    expect(ci).toMatch(/run:\s*npm run typecheck/);
  });
});

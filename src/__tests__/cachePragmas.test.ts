import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../cache.js';

// The shared test setup forces CACHE_DB_PATH=:memory: (vitest.setup.ts), where
// journal_mode cannot be WAL. To prove the PERSISTENT cache gets the
// fsync-tolerant pragmas, open a real on-disk database.
//
// Test openDatabase(), not applyPersistencePragmas(), and not the module's
// exported `database`. openDatabase is the only way this module builds a cache
// database, so covering it covers the wiring as well as the behaviour. An
// earlier version of this test called the pragma function directly, which
// passed happily with the module's own call to it deleted — it proved the
// function body and nothing about what ships.
//
// It does NOT re-import the module under a mutated CACHE_DB_PATH. That needs
// vi.resetModules() plus a dynamic import, which measured 5-7x slower and sat
// at a 60s timeout under a loaded worker pool. The SQLite work itself is
// sub-second even on a busy machine, so the timeout below is headroom against
// worker starvation, not against the database.
describe('cache database construction', () => {
  it('opens a persistent cache in WAL with synchronous=NORMAL', {timeout: 15_000}, () => {
    const dir = mkdtempSync(join(tmpdir(), 'cache-pragma-'));
    const db = openDatabase(join(dir, 'cache.sqlite'));
    try {
      expect(
        (db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode,
      ).toBe('wal');
      // 0=OFF 1=NORMAL 2=FULL — NORMAL fsyncs at checkpoints, not per commit.
      expect(
        (db.prepare('PRAGMA synchronous').get() as { synchronous: number }).synchronous,
      ).toBe(1);
      expect(
        (db.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout,
      ).toBe(5000);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates the schema as well as the pragmas', {timeout: 15_000}, () => {
    const dir = mkdtempSync(join(tmpdir(), 'cache-schema-'));
    const db = openDatabase(join(dir, 'cache.sqlite'));
    try {
      const tables = (db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as Array<{ name: string }>).map((r) => r.name);

      expect(tables).toContain('cache');
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * WAL needs a file, so an in-memory database keeps journal_mode=memory — but
   * busy_timeout and synchronous do apply, and none of the three throws. Worth
   * pinning, because the pragma call used to carry a comment claiming this was
   * the case the try/catch existed for.
   */
  it('leaves an in-memory database on its own journal mode without throwing', () => {
    const db = openDatabase(':memory:', true);
    try {
      expect(
        (db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode,
      ).toBe('memory');
      expect(
        (db.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout,
      ).toBe(5000);
      expect(
        (db.prepare('PRAGMA synchronous').get() as { synchronous: number }).synchronous,
      ).toBe(1);
    } finally {
      db.close();
    }
  });
});

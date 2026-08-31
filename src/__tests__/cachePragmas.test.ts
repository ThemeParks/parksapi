import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyPersistencePragmas } from '../cache.js';

// The shared test setup forces CACHE_DB_PATH=:memory: (vitest.setup.ts), where
// journal_mode is 'memory' and synchronous is moot. To prove the PERSISTENT
// cache gets the fsync-tolerant pragmas, apply them to a real on-disk database.
//
// Two things were wrong with the previous version of this test and both are
// fixed here.
//
// It re-imported the cache module under a mutated CACHE_DB_PATH, needing
// vi.resetModules() plus a dynamic import, which turned a slow test into a
// pathological one — 60s timeouts under a loaded worker pool. The module now
// calls the same exported function this test calls, so the guarantee survives
// without the module registry games.
//
// And the underlying work is genuinely slow: opening an on-disk SQLite and
// switching it to WAL costs seconds when the disk is busy with a parallel test
// run, measured at 5.2s with the imports already gone. So it also gets a
// generous timeout. A gate test may not fail because something else was
// running.
describe('cache DB fsync pragmas (on-disk)', () => {
  it('opens a persistent cache in WAL with synchronous=NORMAL', {timeout: 60_000}, () => {
    const dir = mkdtempSync(join(tmpdir(), 'cache-pragma-'));
    const db = new DatabaseSync(join(dir, 'cache.sqlite'));
    try {
      applyPersistencePragmas(db);

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

  it('leaves an in-memory database alone rather than throwing', () => {
    const db = new DatabaseSync(':memory:');
    try {
      expect(() => applyPersistencePragmas(db)).not.toThrow();
    } finally {
      db.close();
    }
  });
});

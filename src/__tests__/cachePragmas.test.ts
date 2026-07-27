import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// The shared test setup forces CACHE_DB_PATH=:memory: (vitest.setup.ts), where
// journal_mode is 'memory' and synchronous is moot. To prove the PERSISTENT
// cache gets the fsync-tolerant pragmas, re-import the module against a real
// on-disk path.
describe('cache DB fsync pragmas (on-disk)', () => {
  it('opens the persistent cache in WAL with synchronous=NORMAL', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cache-pragma-'));
    process.env.CACHE_DB_PATH = join(dir, 'cache.sqlite');
    vi.resetModules();
    const { database } = await import('../cache.js');
    expect(
      (database.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode,
    ).toBe('wal');
    // 0=OFF 1=NORMAL 2=FULL — NORMAL fsyncs at checkpoints, not per commit.
    expect(
      (database.prepare('PRAGMA synchronous').get() as { synchronous: number }).synchronous,
    ).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });
});

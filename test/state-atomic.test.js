import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { saveState, loadState, STATE_FILENAME } from '../src/state.js';
import { withTmpDir } from './helpers.js';

describe('saveState atomicity (A2)', () => {
  it('writes via tmp+rename so a reader never sees an empty file', async () => {
    await withTmpDir(async (tmpDir) => {
      // Seed with a valid state.
      const initial = { version: 1, pins: { server: 'hash-a' } };
      await saveState(tmpDir, initial);

      // Kick off many concurrent writes with different payloads. Under the
      // old non-atomic implementation at least one reader could observe a
      // truncated zero-byte file. With tmp+rename every reader sees some
      // complete payload.
      const writers = [];
      for (let i = 0; i < 40; i++) {
        writers.push(saveState(tmpDir, { version: 1, pins: { server: `hash-${i}` } }));
      }

      // Read the file many times during the write storm.
      const targetPath = path.join(tmpDir, STATE_FILENAME);
      const readSamples = [];
      for (let i = 0; i < 100; i++) {
        try {
          const raw = fs.readFileSync(targetPath, 'utf8');
          readSamples.push(raw);
        } catch {
          // File briefly not visible during rename on some filesystems — that's
          // fine; we only care that what IS visible is complete.
        }
      }

      await Promise.all(writers);

      // Every successfully-read sample parses and has the expected shape.
      for (const raw of readSamples) {
        expect(raw.length).toBeGreaterThan(0);
        const parsed = JSON.parse(raw); // must not throw
        expect(parsed).toHaveProperty('pins.server');
        expect(parsed.pins.server).toMatch(/^hash-/);
      }
    });
  });

  it('retries a rename the OS transiently refuses, instead of losing the write', async () => {
    // Windows fails rename-onto-an-open-file with EPERM rather than swapping the
    // directory entry, so a reader holding the state open for a few microseconds
    // used to turn a routine save into a thrown error and a dropped pin. The
    // failure is transient by nature; the fix is to retry it.
    await withTmpDir(async (tmpDir) => {
      const realRename = fs.promises.rename;
      let calls = 0;
      fs.promises.rename = async (from, to) => {
        if (++calls <= 2) {
          const err = new Error('EPERM: operation not permitted, rename');
          err.code = 'EPERM';
          throw err;
        }
        return realRename(from, to);
      };
      try {
        await saveState(tmpDir, { version: 1, pins: { server: 'survived' } });
      } finally {
        fs.promises.rename = realRename;
      }
      expect(calls).toBe(3);
      const raw = fs.readFileSync(path.join(tmpDir, STATE_FILENAME), 'utf8');
      expect(JSON.parse(raw).pins.server).toBe('survived');
      expect(fs.readdirSync(tmpDir).filter((e) => e.includes('.tmp'))).toHaveLength(0);
    });
  });

  it('still surfaces a non-transient rename failure, and cleans up the tmp file', async () => {
    await withTmpDir(async (tmpDir) => {
      const realRename = fs.promises.rename;
      fs.promises.rename = async () => {
        const err = new Error('ENOSPC: no space left on device, rename');
        err.code = 'ENOSPC';
        throw err;
      };
      try {
        await expect(saveState(tmpDir, { version: 1, pins: {} })).rejects.toThrow(/ENOSPC/);
      } finally {
        fs.promises.rename = realRename;
      }
      expect(fs.readdirSync(tmpDir).filter((e) => e.includes('.tmp'))).toHaveLength(0);
    });
  });

  it('does not leave stray .tmp files after successful writes', async () => {
    await withTmpDir(async (tmpDir) => {
      for (let i = 0; i < 10; i++) {
        await saveState(tmpDir, { version: 1, pins: { n: i } });
      }
      const entries = fs.readdirSync(tmpDir);
      const tmpFiles = entries.filter((e) => e.includes('.tmp'));
      expect(tmpFiles).toHaveLength(0);
    });
  });

  it('is crash-safe: if rename never completes, the original file is untouched', async () => {
    await withTmpDir(async (tmpDir) => {
      // Seed a good value.
      const original = { version: 1, pins: { original: 'safe' } };
      await saveState(tmpDir, original);

      // Simulate a writer that crashes after the tmp file is written but
      // before rename: create a .tmp file manually, then verify the real
      // file is still the original. (A plain writeFile to the target would
      // have already truncated.)
      const targetPath = path.join(tmpDir, STATE_FILENAME);
      const strayTmp = `${targetPath}.99999.deadbeef.tmp`;
      fs.writeFileSync(strayTmp, 'garbage');

      const raw = fs.readFileSync(targetPath, 'utf8');
      const parsed = JSON.parse(raw);
      expect(parsed.pins.original).toBe('safe');

      // Clean up stray (real code would leave it; that's ok, it's not the
      // live file — recovery is a separate concern).
      fs.unlinkSync(strayTmp);
    });
  });

  it('round-trips through loadState', async () => {
    await withTmpDir(async (tmpDir) => {
      const payload = { version: 1, pins: { a: 'x', b: 'y' } };
      await saveState(tmpDir, payload);
      const loaded = await loadState(tmpDir);
      expect(loaded.corrupt).toBe(false);
      expect(loaded.state).toEqual(payload);
    });
  });
});

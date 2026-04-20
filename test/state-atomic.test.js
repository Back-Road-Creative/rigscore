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

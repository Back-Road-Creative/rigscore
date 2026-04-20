import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { walkDirSafe } from '../src/utils.js';
import deepSecrets from '../src/checks/deep-secrets.js';
import skillFiles from '../src/checks/skill-files.js';
import { withTmpDir } from './helpers.js';

function supportsSymlinks() {
  // Node on Windows without SeCreateSymbolicLink can't create symlinks;
  // the test becomes a noop in that env (CI runs on Linux).
  try {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-'));
    const src = path.join(tmp, 'a');
    const dst = path.join(tmp, 'b');
    fs.writeFileSync(src, 'x');
    fs.symlinkSync(src, dst);
    fs.rmSync(tmp, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

const CAN_SYMLINK = supportsSymlinks();

describe('A4: symlink-loop defense', () => {
  describe('walkDirSafe', () => {
    it.skipIf(!CAN_SYMLINK)('finishes on a self-symlink cycle within 2s', async () => {
      await withTmpDir(async (tmp) => {
        // `ln -s . self` — the classic cycle.
        fs.symlinkSync('.', path.join(tmp, 'self'));
        fs.writeFileSync(path.join(tmp, 'file.txt'), 'hello');

        const start = Date.now();
        const { files, loopDetected } = await walkDirSafe(tmp, {
          maxDepth: 50,
          shouldInclude: () => true,
        });
        const elapsed = Date.now() - start;

        expect(elapsed).toBeLessThan(2000);
        expect(loopDetected).toBe(true);
        // The real file should still be picked up exactly once.
        const realFiles = files.filter((f) => f.endsWith('file.txt'));
        expect(realFiles.length).toBe(1);
      });
    });

    it.skipIf(!CAN_SYMLINK)('handles criss-cross symlinks (a/b → a, a → a/b)', async () => {
      await withTmpDir(async (tmp) => {
        const a = path.join(tmp, 'a');
        fs.mkdirSync(a);
        // a/b → ../a  (cycle)
        fs.symlinkSync(a, path.join(a, 'b'));
        fs.writeFileSync(path.join(a, 'file.txt'), 'x');

        const start = Date.now();
        const { loopDetected } = await walkDirSafe(tmp, { maxDepth: 50 });
        const elapsed = Date.now() - start;
        expect(elapsed).toBeLessThan(2000);
        expect(loopDetected).toBe(true);
      });
    });

    it('respects maxDepth for pathological non-cyclic nesting', async () => {
      await withTmpDir(async (tmp) => {
        // Build 60 levels deep, and drop a file at the bottom.
        let cur = tmp;
        for (let i = 0; i < 60; i++) {
          cur = path.join(cur, `d${i}`);
          fs.mkdirSync(cur);
        }
        fs.writeFileSync(path.join(cur, 'deep.txt'), 'deep');

        const { files } = await walkDirSafe(tmp, { maxDepth: 10 });
        // maxDepth=10 means we never reach the deep file at depth 61.
        expect(files.some((f) => f.endsWith('deep.txt'))).toBe(false);
      });
    });
  });

  describe('deep-secrets check tolerates symlink cycles', () => {
    it.skipIf(!CAN_SYMLINK)('finishes <2s and emits INFO finding', async () => {
      await withTmpDir(async (tmp) => {
        fs.symlinkSync('.', path.join(tmp, 'self'));
        fs.writeFileSync(path.join(tmp, 'ok.js'), 'const x = 1;\n');

        const start = Date.now();
        const result = await deepSecrets.run({ cwd: tmp, deep: true, config: {} });
        const elapsed = Date.now() - start;

        expect(elapsed).toBeLessThan(2000);
        const infoLoop = result.findings.find(
          (f) => f.severity === 'info' && /symlink/i.test(f.title),
        );
        expect(infoLoop).toBeTruthy();
      });
    });
  });

  describe('skill-files check tolerates symlink cycles', () => {
    it.skipIf(!CAN_SYMLINK)('finishes <2s and emits INFO finding', async () => {
      await withTmpDir(async (tmp) => {
        const skillsDir = path.join(tmp, '.claude', 'skills');
        fs.mkdirSync(skillsDir, { recursive: true });
        fs.writeFileSync(
          path.join(skillsDir, 'good.md'),
          '# Good skill\nA safe skill file.\n',
        );
        // Classic cycle inside the skills dir.
        fs.symlinkSync('.', path.join(skillsDir, 'self'));

        const start = Date.now();
        const result = await skillFiles.run({
          cwd: tmp,
          homedir: null,
          includeHomeSkills: false,
          config: {},
        });
        const elapsed = Date.now() - start;

        expect(elapsed).toBeLessThan(2000);
        const infoLoop = result.findings.find(
          (f) => f.severity === 'info' && /symlink loop/i.test(f.title),
        );
        expect(infoLoop).toBeTruthy();
      });
    });
  });
});

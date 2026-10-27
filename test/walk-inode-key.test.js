import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { walkDirSafe } from '../src/utils.js';
import { withTmpDir } from './helpers.js';

// NTFS file IDs routinely exceed 2^53, so a Number `stat.ino` loses its low
// bits and two sibling directories can round to the same value. Keyed on that
// Number, the walker took the second directory for a symlink loop and skipped
// it: Windows CI dropped skill files at random. Simulate the rounding by
// collapsing every Number ino to one value; BigInt stats keep their real ino.
const ROUNDED_INO = 2 ** 53;

function collapseNumberInodes() {
  const realStat = fs.promises.stat;
  return vi.spyOn(fs.promises, 'stat').mockImplementation(async (p, opts) => {
    const st = await realStat(p, opts);
    if (typeof st.ino === 'bigint') return st;
    return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { ino: ROUNDED_INO });
  });
}

describe('walkDirSafe — inode keys survive precision loss', () => {
  afterEach(() => vi.restoreAllMocks());

  it('walks sibling directories whose Number inodes collide', async () => {
    await withTmpDir(async (root) => {
      for (const d of ['a', 'b']) {
        fs.mkdirSync(path.join(root, d));
        fs.writeFileSync(path.join(root, d, 'SKILL.md'), 'x');
      }
      collapseNumberInodes();
      const { files, loopDetected } = await walkDirSafe(root);
      expect(loopDetected).toBe(false);
      expect(files.map((f) => path.relative(root, f)).sort())
        .toEqual([path.join('a', 'SKILL.md'), path.join('b', 'SKILL.md')]);
    });
  });
});

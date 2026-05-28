import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { walkDirSafe } from '../src/utils.js';
import { withTmpDir } from './helpers.js';

// Wave 9 parity suite: walkUnder() was merged into walk() via the
// `skipRootInode` parameter. These tests pin the documented behaviors
// (hidden-dir skip, skipDirs allowlist, maxFiles cap, symlink-to-dir
// recursion) so a future drift on either branch surfaces as a failed
// test, not a silent finding-count divergence.

function supportsSymlinks() {
  try {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-'));
    fs.writeFileSync(path.join(t, 'a'), 'x');
    fs.symlinkSync(path.join(t, 'a'), path.join(t, 'b'));
    fs.rmSync(t, { recursive: true });
    return true;
  } catch {
    return false;
  }
}
const CAN_SYMLINK = supportsSymlinks();

describe('walkDirSafe — unified walk parity', () => {
  it('skipHidden:true (default) drops dot-directories', async () => {
    await withTmpDir(async (tmp) => {
      fs.mkdirSync(path.join(tmp, '.hidden'));
      fs.writeFileSync(path.join(tmp, '.hidden', 'secret.txt'), 'x');
      fs.writeFileSync(path.join(tmp, 'visible.txt'), 'y');
      const { files } = await walkDirSafe(tmp);
      const names = files.map((f) => path.basename(f));
      expect(names).toContain('visible.txt');
      expect(names).not.toContain('secret.txt');
    });
  });

  it('skipHidden:false includes dot-directories', async () => {
    await withTmpDir(async (tmp) => {
      fs.mkdirSync(path.join(tmp, '.hidden'));
      fs.writeFileSync(path.join(tmp, '.hidden', 'secret.txt'), 'x');
      const { files } = await walkDirSafe(tmp, { skipHidden: false });
      const names = files.map((f) => path.basename(f));
      expect(names).toContain('secret.txt');
    });
  });

  it('skipDirs blocks named directories regardless of hidden status', async () => {
    await withTmpDir(async (tmp) => {
      fs.mkdirSync(path.join(tmp, 'node_modules'));
      fs.writeFileSync(path.join(tmp, 'node_modules', 'lib.js'), 'x');
      fs.writeFileSync(path.join(tmp, 'app.js'), 'y');
      const { files } = await walkDirSafe(tmp, { skipDirs: new Set(['node_modules']) });
      const names = files.map((f) => path.basename(f));
      expect(names).toContain('app.js');
      expect(names).not.toContain('lib.js');
    });
  });

  it('maxFiles caps file accumulation early', async () => {
    await withTmpDir(async (tmp) => {
      for (let i = 0; i < 10; i++) {
        fs.writeFileSync(path.join(tmp, `f${i}.txt`), 'x');
      }
      const { files } = await walkDirSafe(tmp, { maxFiles: 3 });
      expect(files.length).toBeLessThanOrEqual(3);
    });
  });

  it.skipIf(!CAN_SYMLINK)('symlink-to-dir is traversed once (skipRootInode path)', async () => {
    await withTmpDir(async (tmp) => {
      // real/ contains one file; link/ is a symlink to real/.
      // After merge, walk(realPath, depth+1, {skipRootInode: true}) handles
      // the symlink target without double-counting against the inode set.
      const real = path.join(tmp, 'real');
      fs.mkdirSync(real);
      fs.writeFileSync(path.join(real, 'inside.txt'), 'x');
      fs.symlinkSync(real, path.join(tmp, 'link'));
      const { files, loopDetected } = await walkDirSafe(tmp);
      const insides = files.filter((f) => f.endsWith('inside.txt'));
      // The same file appears under both real/ and link/ paths — but the
      // inode visited set makes the second visit a loop, not a duplicate.
      expect(insides.length).toBe(1);
      expect(loopDetected).toBe(true);
    });
  });
});

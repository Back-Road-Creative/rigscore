import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Create a temp directory, run callback with its path, then clean up.
 * @param {(tmpDir: string) => Promise<void>} callback
 */
export async function withTmpDir(callback) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-test-'));
  try {
    await callback(tmpDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
}

/**
 * True when the filesystem enforces read permission bits against the current
 * user (a chmod-000 file is actually unreadable). False when running as root or
 * on a filesystem that ignores perms — used to skipIf() the unreadable-path
 * tests so they never false-fail in a root CI container.
 */
export function enforcesFilePerms() {
  try {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-perm-'));
    const f = path.join(t, 'locked');
    fs.writeFileSync(f, 'x');
    fs.chmodSync(f, 0o000);
    let blocked = false;
    try {
      fs.readFileSync(f);
    } catch {
      blocked = true;
    }
    fs.chmodSync(f, 0o644);
    fs.rmSync(t, { recursive: true });
    return blocked;
  } catch {
    return false;
  }
}

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
    // Windows cannot remove a directory while any handle under it is open, and a
    // just-exited `node bin/rigscore.js` child holds one for a few milliseconds
    // after the test's last statement — EBUSY on rmdir. On POSIX the first try wins.
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

/**
 * True when the filesystem enforces read permission bits against the current
 * user (a chmod-000 file is actually unreadable). False when running as root or
 * on a filesystem that ignores perms — used to skipIf() the unreadable-path
 * tests so they never false-fail in a root CI container.
 */
/**
 * True when the filesystem enforces a directory's write bit — a chmod-555 dir
 * actually refuses a new file. False as root and false on NTFS, where chmod is a
 * no-op reporting success. EACCES-on-write assertions only mean anything here.
 */
export function enforcesDirWritePerms() {
  let t;
  try {
    t = fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-dperm-'));
    fs.chmodSync(t, 0o555);
    try {
      fs.writeFileSync(path.join(t, 'probe'), 'x');
      return false; // the write went through — the bit is decorative here
    } catch {
      return true;
    }
  } catch {
    return false;
  } finally {
    try {
      fs.chmodSync(t, 0o755);
      fs.rmSync(t, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch { /* nothing to clean up */ }
  }
}

/**
 * True when the filesystem carries a POSIX exec bit at all. NTFS has none —
 * `chmod 0o755` succeeds and `stat().mode & 0o111` stays 0 — so "the installer
 * made it executable" there asserts the filesystem, not the installer.
 */
export function supportsExecBit() {
  let t;
  try {
    t = fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-xperm-'));
    const f = path.join(t, 'probe');
    fs.writeFileSync(f, 'x');
    fs.chmodSync(f, 0o755);
    return (fs.statSync(f).mode & 0o111) !== 0;
  } catch {
    return false;
  } finally {
    try {
      fs.rmSync(t, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch { /* nothing to clean up */ }
  }
}

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

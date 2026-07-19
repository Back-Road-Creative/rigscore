import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { enforcesDirWritePerms } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '..', 'bin', 'rigscore.js');

function runCli(args, opts = {}) {
  return spawnSync('node', [BIN, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, NO_COLOR: '1' },
    ...opts,
  });
}

// These assert what the CLI prints when the filesystem REFUSES a write, so they
// need a filesystem that refuses. It doesn't as root (CI containers,
// devcontainer-root) and it doesn't on NTFS, where chmod 555 returns success and
// changes nothing. One empirical probe covers both, and any future filesystem
// with the same property, instead of a growing list of platform names.
const describeIfEnforced = enforcesDirWritePerms() ? describe : describe.skip;

describeIfEnforced('CLI fs error handling (Wave 4)', () => {
  let tmp;

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-fs-err-'));
  });

  afterAll(() => {
    try {
      fs.chmodSync(tmp, 0o755);
    } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('init writes a clean stderr line + exit 2 when target dir is unwriteable', () => {
    const sub = path.join(tmp, 'init-target');
    fs.mkdirSync(sub);
    fs.chmodSync(sub, 0o555);
    try {
      const res = runCli(['init'], { cwd: sub });
      expect(res.status).toBe(2);
      expect(res.stderr).toMatch(/rigscore: could not write/);
      expect(res.stderr).not.toMatch(/^\s*at /m); // no Node stack
    } finally {
      fs.chmodSync(sub, 0o755);
    }
  });

  it('--baseline writes a clean stderr line + exit 2 when baseline path is unwriteable', () => {
    const sub = path.join(tmp, 'baseline-target');
    fs.mkdirSync(sub);
    fs.chmodSync(sub, 0o555);
    try {
      // The baseline path lives inside an unwriteable directory
      const res = runCli([
        '--baseline', path.join(sub, 'baseline.json'),
        tmp,
      ]);
      expect(res.status).toBe(2);
      expect(res.stderr).toMatch(/rigscore: could not write baseline/);
      expect(res.stderr).not.toMatch(/^\s*at /m);
    } finally {
      fs.chmodSync(sub, 0o755);
    }
  });

  it('--init-hook writes a clean stderr line + exit 2 when hooks dir is unwriteable', () => {
    const sub = path.join(tmp, 'init-hook-target');
    fs.mkdirSync(path.join(sub, '.git'), { recursive: true });
    // Make the .git directory itself read-only so mkdirSync(hooks) fails
    fs.chmodSync(path.join(sub, '.git'), 0o555);
    try {
      const res = runCli(['--init-hook'], { cwd: sub });
      expect(res.status).toBe(2);
      expect(res.stderr).toMatch(/rigscore: could not install hook/);
      expect(res.stderr).not.toMatch(/^\s*at /m);
    } finally {
      fs.chmodSync(path.join(sub, '.git'), 0o755);
    }
  });
});

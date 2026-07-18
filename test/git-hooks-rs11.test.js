/**
 * RS-11 — git-hooks substance filter was weaker than advertised: a hook whose
 * only "substance" is `exit 1` or a bare `if…then` graded as substantive (PASS).
 * Those are pure control flow, not real work — they must fall to lacks-substance.
 */
import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import check from '../src/checks/git-hooks.js';

const tmpdirs = [];
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-gh11-'));
  tmpdirs.push(d);
  return d;
}
afterEach(() => {
  while (tmpdirs.length) {
    const d = tmpdirs.pop();
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
const cfg = { paths: { hookDirs: [] }, network: {} };

function hook(cwd, body) {
  const p = path.join(cwd, '.git', 'hooks', 'pre-commit');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  fs.chmodSync(p, 0o755);
  return cwd;
}

describe('git-hooks RS-11 substance filter', () => {
  it('a hook that only does `exit 1` is NOT substantive', async () => {
    const cwd = hook(tmp(), '#!/bin/sh\nexit 1\n');
    const r = await check.run({ cwd, homedir: '/tmp', config: cfg });
    expect(r.findings.some(f => f.findingId === 'git-hooks/hook-lacks-substance')).toBe(true);
    expect(r.findings.some(f => f.severity === 'pass' && f.title?.includes('Pre-commit hook installed'))).toBe(false);
  });

  it('a hook that is only a bare `if…then…fi` is NOT substantive', async () => {
    const cwd = hook(tmp(), '#!/bin/sh\nif [ -z "$FOO" ]; then\n  exit 1\nfi\n');
    const r = await check.run({ cwd, homedir: '/tmp', config: cfg });
    expect(r.findings.some(f => f.findingId === 'git-hooks/hook-lacks-substance')).toBe(true);
  });

  it('a hook doing real work (grep) still passes as substantive', async () => {
    const cwd = hook(tmp(), '#!/bin/sh\ngit diff --cached | grep -q SECRET && exit 1\n');
    const r = await check.run({ cwd, homedir: '/tmp', config: cfg });
    expect(r.findings.some(f => f.severity === 'pass' && f.title?.includes('Pre-commit hook installed'))).toBe(true);
    expect(r.findings.some(f => f.findingId === 'git-hooks/hook-lacks-substance')).toBe(false);
  });
});

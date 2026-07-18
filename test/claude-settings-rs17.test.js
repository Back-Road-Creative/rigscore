/**
 * RS-17 — the dangerous-allow `sudo -u` rule was hardcoded to this workspace's
 * container username (`dev`) and required the command to be `bash`, so
 * `sudo -u <anyone> <not-bash>` slipped through. It must be general.
 */
import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import check from '../src/checks/claude-settings.js';

const tmpdirs = [];
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-cs17-'));
  tmpdirs.push(d);
  return d;
}
afterEach(() => {
  while (tmpdirs.length) {
    const d = tmpdirs.pop();
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function withAllow(cwd, allow) {
  const p = path.join(cwd, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ permissions: { allow } }));
  return cwd;
}
const dangerous = (r) => r.findings.filter(f => f.findingId === 'claude-settings/dangerous-allow-list-entry');

describe('claude-settings RS-17 general sudo -u rule', () => {
  it('flags `sudo -u <anyuser> <non-bash>` (not just dev, not just bash)', async () => {
    const cwd = withAllow(tmp(), ['Bash(sudo -u alice python -c foo:*)']);
    const r = await check.run({ cwd, homedir: '/tmp' });
    expect(dangerous(r).length).toBe(1);
  });

  it('still flags the classic `sudo -u dev bash` with the bash-specific message', async () => {
    const cwd = withAllow(tmp(), ['Bash(sudo -u dev bash:*)']);
    const r = await check.run({ cwd, homedir: '/tmp' });
    const d = dangerous(r);
    expect(d.length).toBe(1);
    expect(d[0].detail).toContain('bash');
  });

  it('flags `sudo -u dev <non-bash>` too (regression on the old dev\\b form)', async () => {
    const cwd = withAllow(tmp(), ['Bash(sudo -u dev rm -rf /:*)']);
    const r = await check.run({ cwd, homedir: '/tmp' });
    expect(dangerous(r).length).toBe(1);
  });

  it('does not flag an ordinary allow entry', async () => {
    const cwd = withAllow(tmp(), ['Bash(git status:*)']);
    const r = await check.run({ cwd, homedir: '/tmp' });
    expect(dangerous(r).length).toBe(0);
  });
});

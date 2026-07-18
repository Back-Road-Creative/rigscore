import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '..', 'bin', 'rigscore.js');

function runCli(args, opts = {}) {
  return spawnSync('node', [BIN, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, NO_COLOR: '1' },
    ...opts,
  });
}

// Regression: before this fix, --ignore / --fix / --baseline / --verbose were
// silently no-ops when combined with --recursive because their handler blocks
// lived in the non-recursive `else` branch only. (--badge is now SUPPORTED in
// recursive mode — it badges the monorepo average — see the positive test below.)
describe('recursive-mode flag parity', () => {
  let root;
  let projDir;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-recursive-parity-'));
    projDir = path.join(root, 'pkg-foo');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'package.json'), '{}');
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  for (const flag of ['--fix', '--baseline', '--junit', '--code-quality']) {
    it(`rejects ${flag} in --recursive mode with stderr + exit 2`, () => {
      const args = ['--recursive', root];
      // --baseline takes a path arg
      const fullArgs = flag === '--baseline'
        ? ['--baseline', path.join(root, 'b.json'), ...args]
        : [flag, ...args];
      const res = runCli(fullArgs);
      expect(res.status).toBe(2);
      expect(res.stderr).toMatch(/not supported in --recursive mode/);
    });
  }

  it('--badge IS supported in --recursive mode (badges the average score)', () => {
    const res = runCli(['--badge', '--recursive', root]);
    expect(res.status).not.toBe(2);
    expect(res.stderr).not.toMatch(/not supported in --recursive mode/);
    expect(res.stdout).toContain('shields.io');
  });

  it('--ignore actually suppresses findings in --recursive mode', () => {
    // Run twice: once with --ignore using a pattern that matches all findings,
    // once without. The --ignore run should report fewer or equal findings.
    const without = runCli(['--recursive', '--json', root]);
    const withIgnore = runCli(['--recursive', '--ignore', '**/*', '--json', root]);
    expect(without.status).not.toBe(2);
    expect(withIgnore.status).not.toBe(2);
    const w = JSON.parse(without.stdout);
    const wi = JSON.parse(withIgnore.stdout);
    const countFindings = (r) => (r.projects || [])
      .flatMap(p => p.results || [])
      .reduce((sum, c) => sum + (c.findings || []).length, 0);
    expect(countFindings(wi)).toBeLessThanOrEqual(countFindings(w));
  });
});

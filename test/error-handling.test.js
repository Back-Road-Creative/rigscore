import { describe, it, expect } from 'vitest';
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

describe('CLI error handling', () => {
  // Q5 (corrected, not weakened): this test used to pin exit 1. That WAS the bug.
  // README's exit-code table already classifies an invalid target directory as a
  // *configuration error* (code 2) and tells CI authors to branch on 0 vs 1 for
  // score-gating — so a typo'd path exiting 1 was indistinguishable from a real
  // below-threshold score. Code now matches the documented contract.
  it('exits 2 with a clean message when the target directory does not exist', () => {
    const res = runCli(['/nonexistent/path/that-should-not-exist-xyz']);
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/not a valid directory/);
    expect(res.stderr).not.toMatch(/at Object\.|at async|Error:.*\n.*at /); // no Node stack trace
  });

  it('exits 2 with a sanitized "scan failed" line when a config file is unreadable', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-err-'));
    try {
      // Malformed .rigscorerc.json triggers ConfigParseError → handleFatal
      fs.writeFileSync(path.join(tmp, '.rigscorerc.json'), '{ this is not json');
      const res = runCli([tmp]);
      expect(res.status).toBe(2);
      // Either ConfigParseError's user message or the generic scan-failed line
      expect(res.stderr.length).toBeGreaterThan(0);
      expect(res.stderr).not.toMatch(/^\s*at /m); // no stack frames
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

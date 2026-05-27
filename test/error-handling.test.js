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
  it('exits 1 with a clean message when the target directory does not exist', () => {
    const res = runCli(['/nonexistent/path/that-should-not-exist-xyz']);
    expect(res.status).toBe(1);
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

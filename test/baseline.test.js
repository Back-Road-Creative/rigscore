import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  flattenFindings,
  buildBaseline,
  loadBaseline,
  writeBaseline,
  diffFindings,
} from '../src/cli/baseline.js';
import { assignFindingIds } from '../src/scanner.js';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'rigscore.js');
const runBin = (args) =>
  spawnSync('node', [BIN, ...args], { encoding: 'utf-8', env: { ...process.env, NO_COLOR: '1' } });

describe('baseline helpers', () => {
  let tmp;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-baseline-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('flattenFindings excludes skipped and pass, keeps warnings/info/critical', () => {
    const results = [
      {
        id: 'claude-md',
        findings: [
          { severity: 'warning', title: 'A', findingId: 'claude-md/a' },
          { severity: 'skipped', title: 'B' },
          { severity: 'pass', title: 'C' },
        ],
      },
      {
        id: 'mcp-config',
        findings: [
          { severity: 'info', title: 'D', findingId: 'mcp-config/d' },
          { severity: 'critical', title: 'E' }, // no findingId → slugified
        ],
      },
    ];
    const flat = flattenFindings(results);
    expect(flat.length).toBe(3);
    expect(flat[0].findingId).toBe('claude-md/a');
    expect(flat[2].findingId).toBe('mcp-config/e');
  });

  it('buildBaseline records timestamp, version, findings', () => {
    const baseline = buildBaseline({ results: [] });
    expect(typeof baseline.timestamp).toBe('string');
    expect(new Date(baseline.timestamp).toString()).not.toBe('Invalid Date');
    expect(typeof baseline.version).toBe('string');
    expect(Array.isArray(baseline.findings)).toBe(true);
  });

  it('writeBaseline + loadBaseline round-trip', () => {
    const target = path.join(tmp, 'rigscore.baseline.json');
    const original = {
      timestamp: new Date().toISOString(),
      version: '0.9.0',
      findings: [{ checkId: 'x', findingId: 'x/y', severity: 'warning', title: 'foo' }],
    };
    writeBaseline(target, original);
    const loaded = loadBaseline(target);
    expect(loaded).toEqual(original);
  });

  it('loadBaseline returns null for missing or malformed file', () => {
    expect(loadBaseline(path.join(tmp, 'missing.json'))).toBeNull();
    const bad = path.join(tmp, 'bad.json');
    fs.writeFileSync(bad, 'not json');
    expect(loadBaseline(bad)).toBeNull();
  });

  it('diffFindings returns only findings not in baseline (by findingId+severity)', () => {
    const baseline = [
      { findingId: 'a', severity: 'warning', title: 'a' },
      { findingId: 'b', severity: 'info', title: 'b' },
    ];
    const current = [
      { findingId: 'a', severity: 'warning', title: 'a' }, // unchanged
      { findingId: 'b', severity: 'warning', title: 'b' }, // severity upgraded → counts as new
      { findingId: 'c', severity: 'critical', title: 'c' }, // new
    ];
    const added = diffFindings(baseline, current);
    expect(added.map((f) => f.findingId).sort()).toEqual(['b', 'c']);
  });

  it('empty baseline + empty current → no added', () => {
    expect(diffFindings([], [])).toEqual([]);
  });

  it('runBaselineMode: a CORRUPT existing baseline fails closed (exit 2, never re-minted)', () => {
    // Security regression (Wave 9): an attacker who overwrites a committed
    // baseline with junk must NOT get the gate to silently re-seed their
    // current (attacker-controlled) findings and ship green. A corrupt
    // existing baseline is never a legitimate state → hard-fail, don't mint.
    const target = path.join(tmp, 'target');
    fs.mkdirSync(target);
    const basePath = path.join(tmp, 'rigscore-baseline.json');
    const junk = '{ not valid json';
    fs.writeFileSync(basePath, junk);

    const res = runBin(['--baseline', basePath, target]);

    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/malformed/);
    expect(res.stderr).not.toMatch(/^\s*at /m); // no Node stack trace
    // The corrupt file must survive untouched — proof the gate refused to re-mint.
    expect(fs.readFileSync(basePath, 'utf8')).toBe(junk);
  });

  it('runBaselineMode: a MISSING baseline still mints + exits 0 (documented regenerate flow)', () => {
    // Guard the documented `rm <baseline> && rigscore --baseline` flow
    // (docs/TROUBLESHOOTING.md): a missing file is first-run, not corruption.
    const target = path.join(tmp, 'target');
    fs.mkdirSync(target);
    const basePath = path.join(tmp, 'fresh-baseline.json');
    expect(fs.existsSync(basePath)).toBe(false);

    const res = runBin(['--baseline', basePath, target]);

    expect(res.status).toBe(0);
    expect(fs.existsSync(basePath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(basePath, 'utf8'));
    expect(Array.isArray(parsed.findings)).toBe(true);
  });

  it('flattenFindings and assignFindingIds slugify titles identically', () => {
    // Regression: baseline.js had its own inline slugify that omitted the
    // leading/trailing dash strip used by scanner.js, so titles starting or
    // ending with non-alphanumerics produced divergent findingIds across
    // the two paths. Now both call utils.slugify.
    const tricky = [
      '!!leading-and-trailing!!',
      '   whitespace   wrapped   ',
      'normal title text',
      ':punctuation: bookends:',
    ];
    for (const title of tricky) {
      const scannerInput = [{ id: 'env-exposure', findings: [{ severity: 'critical', title }] }];
      const baselineInput = [{ id: 'env-exposure', findings: [{ severity: 'critical', title }] }];
      assignFindingIds(scannerInput);
      const flat = flattenFindings(baselineInput);
      expect(flat[0].findingId).toBe(scannerInput[0].findings[0].findingId);
    }
  });
});

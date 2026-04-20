import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  flattenFindings,
  buildBaseline,
  loadBaseline,
  writeBaseline,
  diffFindings,
} from '../src/cli/baseline.js';

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
});

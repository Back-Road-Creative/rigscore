import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import check from '../src/checks/governance-docs.js';
import { formatTerminal, formatTerminalRecursive, formatJson, stripAnsi } from '../src/reporter.js';

const defaultConfig = { paths: { claudeMd: [] }, network: {} };
const MISSING_PREFIX = 'governance-docs/missing-';

// A governance file long enough to skip the "short" warning that states only
// one quality rule, so the other eight quality patterns are all missing.
async function runGovernance(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-group-'));
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), [...lines, ...Array(60).fill('# filler line')].join('\n'));
  try {
    return await check.run({ cwd: dir, homedir: '/tmp/nonexistent', config: defaultConfig });
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
}

function wrap(checkResult) {
  return {
    score: 50,
    results: [{ id: 'governance-docs', name: 'CLAUDE.md governance', weight: 20, score: 50, findings: checkResult.findings }],
  };
}

describe('governance-docs missing-rule warnings carry a group (UI-8)', () => {
  it('tags every missing-* warning with the same group key and its own label', async () => {
    const res = await runGovernance(['# Rules', 'Never delete production data.']);
    const missing = res.findings.filter((f) => f.findingId.startsWith(MISSING_PREFIX));
    expect(missing.length).toBeGreaterThanOrEqual(4);
    expect(new Set(missing.map((f) => f.group?.key)).size).toBe(1);
    expect(missing[0].group.key).toBe('governance-docs/missing');
    for (const f of missing) {
      expect(f.title).toBe(`Governance file missing: ${f.group.label}`);
    }
  });

  it('keeps one finding per rule, ids and severity unchanged (suppression and scoring)', async () => {
    const res = await runGovernance(['# Rules', 'Never delete production data.']);
    const ids = res.findings.filter((f) => f.findingId.startsWith(MISSING_PREFIX)).map((f) => f.findingId);
    expect(ids).toContain('governance-docs/missing-anti-injection');
    expect(ids).toContain('governance-docs/missing-approval-gates');
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('formatTerminal collapses grouped findings into one line (UI-8)', () => {
  it('four missing docs render as one grouped warning listing every rule', async () => {
    const res = await runGovernance(['# Rules', 'Never delete production data.']);
    const missing = res.findings.filter((f) => f.findingId.startsWith(MISSING_PREFIX));
    const plain = stripAnsi(formatTerminal(wrap(res), '/proj', { width: 100 }));
    const titleLines = plain.split('\n').filter((l) => l.includes('Governance file missing'));
    expect(titleLines.length).toBe(1);
    const flat = plain.replace(/\s+/g, ' ');
    for (const f of missing) expect(flat).toContain(f.group.label);
    // Every member id stays discoverable for `explain` and `--ignore`.
    for (const f of missing) expect(flat).toContain(f.findingId);
    // The header still counts findings, not rendered lines.
    expect(plain).toContain(`WARNING (${res.findings.filter((f) => f.severity === 'warning').length})`);
  });

  it('a lone grouped finding renders as a normal finding', () => {
    const f = {
      severity: 'warning', findingId: 'governance-docs/missing-tdd',
      title: 'Governance file missing: tdd', remediation: 'Add tdd.',
      group: { key: 'governance-docs/missing', label: 'tdd', title: 'Governance file missing', remediation: 'Add each.' },
    };
    const plain = stripAnsi(formatTerminal(wrap({ findings: [f] }), '/proj'));
    expect(plain).toContain('Governance file missing: tdd [governance-docs/missing-tdd]');
  });

  it('does not merge groups across different severities or checks', () => {
    const g = { key: 'k/missing', title: 'Missing', remediation: 'Fix all.' };
    const mk = (id, sev) => ({ severity: sev, findingId: `k/missing-${id}`, title: `Missing: ${id}`, group: { ...g, label: id } });
    const result = {
      score: 50,
      results: [
        { id: 'a', name: 'A', weight: 5, score: 50, findings: [mk('a1', 'warning'), mk('a2', 'warning'), mk('a3', 'critical')] },
        { id: 'b', name: 'B', weight: 5, score: 50, findings: [mk('b1', 'warning')] },
      ],
    };
    const plain = stripAnsi(formatTerminal(result, '/proj', { width: 100 }));
    expect(plain).toContain('Missing: a1, a2');
    expect(plain).toContain('Missing: a3 [k/missing-a3]');
    expect(plain).toContain('Missing: b1 [k/missing-b1]');
  });

  it('recursive report groups per project too', async () => {
    const res = await runGovernance(['# Rules', 'Never delete production data.']);
    const rec = {
      score: 30,
      projects: [{ path: 'apps/web', score: 30, results: wrap(res).results }],
      worstProject: { path: 'apps/web', score: 30 },
    };
    const plain = stripAnsi(formatTerminalRecursive(rec, '/root', { width: 100 }));
    expect(plain.split('\n').filter((l) => l.includes('Governance file missing')).length).toBe(1);
  });

  it('stays within 80 columns', async () => {
    const res = await runGovernance(['# Rules', 'Never delete production data.']);
    const plain = stripAnsi(formatTerminal(wrap(res), '/proj', { width: 80 }));
    expect(plain.split('\n').filter((l) => l.length > 80)).toEqual([]);
  });

  it('JSON keeps every finding ungrouped', async () => {
    const res = await runGovernance(['# Rules', 'Never delete production data.']);
    const parsed = JSON.parse(formatJson(wrap(res)));
    const n = parsed.results[0].findings.filter((f) => f.findingId.startsWith(MISSING_PREFIX)).length;
    expect(n).toBeGreaterThanOrEqual(4);
  });
});

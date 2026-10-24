import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { findFindingSection, findTriggerRow } from '../src/cli/explain.js';
import { extractDocumentedRuleIds } from '../src/lib/verify-docs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '..', 'bin', 'rigscore.js');

describe('rigscore explain — section resolver', () => {
  const doc = `# claude-md

## Purpose
Overall purpose.

## Findings

### missing-claude-md
This specific finding describes a missing governance file.
Remediation: create one.

### conflicting-rules
Another finding.

## Weight rationale
Ten points.
`;

  it('returns the section matching a finding slug at H3', () => {
    const section = findFindingSection(doc, 'missing-claude-md');
    expect(section).toMatch(/^### missing-claude-md/);
    expect(section).toContain('governance file');
    // Stops at the next H3 (same level) or H2
    expect(section).not.toContain('conflicting-rules');
  });

  it('returns null when the slug does not match any heading', () => {
    expect(findFindingSection(doc, 'nonexistent-slug')).toBeNull();
  });

  it('does not resolve a slug by substring of an unrelated heading', () => {
    // "conflicting" is only a fragment of "conflicting-rules"; a loose
    // includes() match would print an unrelated section for any short slug.
    expect(findFindingSection(doc, 'conflicting')).toBeNull();
    // ...and a long slug must not match a heading that is merely a prefix of it.
    expect(findFindingSection(doc, 'findings-and-more')).toBeNull();
  });
});

describe('rigscore explain — CLI dispatch', () => {
  it('routes `explain <findingId>` to the subcommand and prints docs', () => {
    const res = spawnSync('node', [BIN, 'explain', 'governance-docs/missing-claude-md'], {
      encoding: 'utf-8',
      env: { ...process.env, NO_COLOR: '1' },
    });
    expect(res.status).toBe(0);
    expect(res.stdout.length).toBeGreaterThan(0);
  });

  it('exits non-zero with a helpful message when the check id is unknown', () => {
    const res = spawnSync('node', [BIN, 'explain', 'no-such-check/whatever'], {
      encoding: 'utf-8',
      env: { ...process.env, NO_COLOR: '1' },
    });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/no docs found/i);
  });
});

describe('rigscore explain — Triggers table resolver', () => {
  const doc = `# demo

## Triggers

| Condition | Severity | SARIF ruleId | Remediation summary |
|---|---|---|---|
| No file found | CRITICAL | \`demo/no-file\` | Create the file |
| Two ids in one row | WARNING | \`demo/alpha\`, \`demo/beta\` | Fix both |
| Informational | INFO | — | None |

## Example
Body.
`;

  it('resolves a ruleId to its Triggers row', () => {
    const row = findTriggerRow(doc, 'demo', 'no-file');
    expect(row).toEqual({
      condition: 'No file found',
      severity: 'CRITICAL',
      ruleId: 'demo/no-file',
      remediation: 'Create the file',
    });
  });

  it('resolves any id listed in a multi-id row', () => {
    expect(findTriggerRow(doc, 'demo', 'beta').severity).toBe('WARNING');
  });

  it('returns null for an id that is not a whole ruleId token', () => {
    expect(findTriggerRow(doc, 'demo', 'no')).toBeNull();
    expect(findTriggerRow(doc, 'demo', 'missing')).toBeNull();
  });

  it('keeps an escaped pipe inside a cell and resolves the row', () => {
    const pipeDoc = [
      '## Triggers',
      '| Condition | Severity | SARIF ruleId | Remediation summary |',
      '|---|---|---|---|',
      '| RUN has `curl\\|wget` piped to a shell | WARNING | `demo/pipe-to-shell` | Verify, then run |',
      '',
    ].join('\n');
    expect(findTriggerRow(pipeDoc, 'demo', 'pipe-to-shell')).toEqual({
      condition: 'RUN has `curl|wget` piped to a shell',
      severity: 'WARNING',
      ruleId: 'demo/pipe-to-shell',
      remediation: 'Verify, then run',
    });
  });

  it('resolves an id in a 2-column sub-table under Triggers', () => {
    const subDoc = [
      '## Triggers',
      '| Condition | Severity | SARIF ruleId | Remediation summary |',
      '|---|---|---|---|',
      '| Something | INFO | `demo/other` | None |',
      '',
      '### Escalation ruleIds',
      '| Matches | SARIF ruleId |',
      '|---|---|',
      '| `run as root` | `demo/escalation-root` |',
      '',
      '## Example',
      '| `x` | `demo/not-a-trigger` |',
    ].join('\n');
    const row = findTriggerRow(subDoc, 'demo', 'escalation-root');
    expect(row.ruleId).toBe('demo/escalation-root');
    expect(row.condition).toBe('`run as root`');
    expect(findTriggerRow(subDoc, 'demo', 'not-a-trigger')).toBeNull();
  });

  it('resolves every ruleId documented under docs/checks', () => {
    const dir = path.resolve(__dirname, '..', 'docs', 'checks');
    const missing = [];
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.md') && !n.startsWith('_'))) {
      const checkId = f.replace(/\.md$/, '');
      const body = fs.readFileSync(path.join(dir, f), 'utf8');
      for (const id of extractDocumentedRuleIds(body, checkId)) {
        const slug = id.slice(checkId.length + 1);
        if (!findTriggerRow(body, checkId, slug) && !findFindingSection(body, slug)) missing.push(id);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe('rigscore explain — real finding ids', () => {
  const run = (...a) =>
    spawnSync('node', [BIN, 'explain', ...a], { encoding: 'utf-8', env: { ...process.env, NO_COLOR: '1' } });

  it('resolves a documented finding id to its Triggers row, not the whole doc', () => {
    const res = run('governance-docs/no-governance-file');
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('governance-docs/no-governance-file');
    expect(res.stdout).toContain('CRITICAL');
    expect(res.stdout).toContain('Create CLAUDE.md');
    expect(res.stdout).toContain('docs/checks/governance-docs.md');
    expect(res.stderr).not.toMatch(/No finding-specific section/);
    // a single finding, not the whole check page
    expect(res.stdout).not.toContain('## Purpose');
  });

  it('notes an undocumented slug and lists the ids that are documented', () => {
    const res = run('governance-docs/not-a-real-slug');
    expect(res.status).toBe(0);
    expect(res.stderr).toMatch(/No finding "not-a-real-slug" in docs\/checks\/governance-docs\.md/);
    expect(res.stderr).toContain('governance-docs/no-governance-file');
    expect(res.stdout).toContain('# governance-docs');
  });

  it('explain --help prints usage and exits 0', () => {
    const res = run('--help');
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/Usage:\s+rigscore explain/);
  });
});

import { describe, it, expect } from 'vitest';
import { formatTerminal, formatTerminalRecursive, stripAnsi } from '../src/reporter.js';

const LONG_DETAIL =
  'This finding carries a deliberately long explanation that runs well past eighty columns so the terminal report has to wrap it onto continuation lines instead of overflowing.';
const LONG_EVIDENCE = '.claude/settings.json: permissions.allow contains Bash(*) and Bash(rm -rf *) which together grant unrestricted shell access';
const LONG_FIX = 'Replace the wildcard allow rule with an explicit allow-list of the commands the project actually needs and move the rest to deny.';

function makeResult() {
  return {
    score: 40,
    results: [
      {
        id: 'governance-docs',
        name: 'CLAUDE.md governance',
        weight: 20,
        score: 40,
        findings: [
          {
            severity: 'warning',
            findingId: 'governance-docs/missing-anti-injection',
            title: 'CLAUDE.md missing: anti-injection',
            detail: LONG_DETAIL,
            remediation: LONG_FIX,
          },
          {
            severity: 'info',
            findingId: 'governance-docs/governance-file-short',
            title: 'Governance file is short',
          },
        ],
      },
      {
        id: 'claude-settings',
        name: 'Claude Code settings safety',
        weight: 8,
        score: 0,
        findings: [
          {
            severity: 'critical',
            findingId: 'claude-settings/wildcard-bash-allow',
            title: 'Wildcard Bash allow rule grants unrestricted shell access to the agent',
            evidence: LONG_EVIDENCE,
            learnMore: 'https://example.invalid/docs/checks/claude-settings#wildcard-bash-allow',
          },
        ],
      },
      {
        id: 'mcp-config',
        name: 'MCP server configuration trust',
        weight: 14,
        score: 100,
        findings: [],
      },
    ],
  };
}

const lines = (s) => stripAnsi(s).split('\n');

describe('formatTerminal finding ids and explain hint (UI-3)', () => {
  it('shows each finding id in square brackets', () => {
    const plain = stripAnsi(formatTerminal(makeResult(), '/proj'));
    expect(plain).toContain('[governance-docs/missing-anti-injection]');
    expect(plain).toContain('[claude-settings/wildcard-bash-allow]');
    expect(plain).toContain('[governance-docs/governance-file-short]');
  });

  it('prints the `rigscore explain <id>` hint exactly once', () => {
    const plain = stripAnsi(formatTerminal(makeResult(), '/proj'));
    const hits = plain.split('rigscore explain').length - 1;
    expect(hits).toBe(1);
    expect(plain).toMatch(/rigscore explain <id>/);
  });

  it('prints no hint when there are no findings to explain', () => {
    const r = makeResult();
    r.results.forEach((c) => { c.findings = []; });
    const plain = stripAnsi(formatTerminal(r, '/proj'));
    expect(plain).not.toContain('rigscore explain');
  });

  it('omits the bracket for a finding that has no id', () => {
    const r = makeResult();
    delete r.results[0].findings[0].findingId;
    const plain = stripAnsi(formatTerminal(r, '/proj'));
    expect(plain).toContain('CLAUDE.md missing: anti-injection');
    expect(plain).not.toMatch(/CLAUDE\.md missing: anti-injection \[/);
  });

  it('--quiet stays summary-only (no ids, no hint)', () => {
    const plain = stripAnsi(formatTerminal(makeResult(), '/proj', { quiet: true }));
    expect(plain).not.toContain('rigscore explain');
    expect(plain).not.toContain('[governance-docs/');
  });

  it('recursive report shows ids for failing projects and the hint once', () => {
    const r = makeResult();
    const rec = {
      score: 40,
      projects: [
        { path: 'apps/web', score: 40, results: r.results },
        { path: 'apps/api', score: 30, results: r.results },
      ],
      worstProject: { path: 'apps/api', score: 30 },
    };
    const plain = stripAnsi(formatTerminalRecursive(rec, '/root'));
    expect(plain).toContain('[claude-settings/wildcard-bash-allow]');
    expect(plain.split('rigscore explain').length - 1).toBe(1);
  });

  it('strips terminal escapes smuggled into a finding id', () => {
    const r = makeResult();
    r.results[0].findings[0].findingId = 'governance-docs/x\x1b[2Jevil';
    const out = formatTerminal(r, '/proj');
    expect(out).not.toContain('\x1b[2J');
  });
});

describe('formatTerminal wraps to the terminal width (UI-7)', () => {
  it('no line exceeds 80 columns at width 80', () => {
    const plain = stripAnsi(formatTerminal(makeResult(), '/proj', { width: 80, noCta: false }));
    const over = lines(plain).filter((l) => l.length > 80);
    expect(over).toEqual([]);
    // Wrapping must not drop words.
    expect(plain.replace(/\s+/g, ' ')).toContain('deliberately long explanation that runs well past eighty columns');
  });

  it('wraps a long cwd and the recursive report at 80 columns too', () => {
    const cwd = '/very/long/' + 'nested-directory-name/'.repeat(5) + 'project';
    const plain = stripAnsi(formatTerminal(makeResult(), cwd, { width: 80 }));
    expect(lines(plain).filter((l) => l.length > 80)).toEqual([]);

    const r = makeResult();
    const rec = {
      score: 40,
      projects: [{ path: 'packages/' + 'deeply-nested-package-name/'.repeat(3) + 'x', score: 40, results: r.results }],
      worstProject: { path: 'p', score: 40 },
    };
    const out = stripAnsi(formatTerminalRecursive(rec, cwd, { width: 80 }));
    expect(lines(out).filter((l) => l.length > 80)).toEqual([]);
  });

  it('keeps a narrower width honest (60 columns)', () => {
    const plain = stripAnsi(formatTerminal(makeResult(), '/proj', { width: 60, noCta: false }));
    // The score box (44) and CTA fit inside the 60-column floor; the rest wraps.
    expect(lines(plain).filter((l) => l.length > 60)).toEqual([]);
  });

  it('continuation lines of a wrapped field are indented under the arrow', () => {
    const plain = stripAnsi(formatTerminal(makeResult(), '/proj', { width: 80 }));
    const ls = lines(plain);
    const i = ls.findIndex((l) => l.includes('→ This finding carries'));
    expect(i).toBeGreaterThan(-1);
    expect(ls[i + 1].startsWith('      ')).toBe(true);
    expect(ls[i + 1].trim().length).toBeGreaterThan(0);
  });
});

describe('formatTerminal check-name column (CL-1)', () => {
  it('aligns the grade label column even when a name is longer than 30 chars', () => {
    const r = makeResult();
    r.results[2].name = 'Model Context Protocol server configuration trust'; // 49 chars
    const ls = lines(formatTerminal(r, '/proj', { width: 100 }))
      .filter((l) => l.includes('[pattern]') || l.includes('[mechanical]') || l.includes('[keyword]'));
    expect(ls.length).toBe(3);
    const cols = ls.map((l) => l.search(/\[(pattern|mechanical|keyword)\]/));
    expect(new Set(cols).size).toBe(1);
  });

  it('recursive project column aligns for paths longer than 40 chars', () => {
    const rec = {
      score: 60,
      projects: [
        { path: 'a', score: 90, results: [] },
        { path: 'packages/some/very/deeply/nested/workspace/package-name', score: 80, results: [] },
      ],
      worstProject: { path: 'a', score: 90 },
    };
    const ls = lines(formatTerminalRecursive(rec, '/root', { width: 100 })).filter((l) => /\d+\/100 \(/.test(l));
    expect(ls.length).toBe(2);
    expect(new Set(ls.map((l) => l.search(/\d+\/100 \(/))).size).toBe(1);
  });
});

import { describe, it, expect } from 'vitest';
import { formatTerminal, formatJson, formatBadge, stripAnsi } from '../src/reporter.js';

const mockResult = {
  score: 54,
  results: [
    {
      id: 'claude-md',
      name: 'CLAUDE.md governance',
      weight: 20,
      score: 60,
      findings: [
        { severity: 'warning', title: 'CLAUDE.md missing: anti-injection', detail: 'No anti-injection rules.' },
      ],
    },
    {
      id: 'mcp-config',
      name: 'MCP server configuration',
      weight: 25,
      score: 60,
      findings: [
        { severity: 'warning', title: 'MCP server using unpinned version', detail: 'Unpinned.' },
      ],
    },
    {
      id: 'env-exposure',
      name: 'Secret exposure',
      weight: 20,
      score: 0,
      findings: [
        {
          severity: 'critical',
          title: '.env file found but NOT in .gitignore',
          detail: 'Your API keys will be committed.',
          remediation: 'Add .env to .gitignore.',
        },
      ],
    },
    {
      id: 'docker-security',
      name: 'Docker security',
      weight: 15,
      score: 80,
      findings: [{ severity: 'pass', title: 'Docker looks fine' }],
    },
    {
      id: 'git-hooks',
      name: 'Git hooks',
      weight: 10,
      score: 50,
      findings: [
        { severity: 'warning', title: 'No pre-commit hooks', detail: 'Missing hooks.' },
      ],
    },
    {
      id: 'skill-files',
      name: 'Skill file safety',
      weight: 10,
      score: 80,
      findings: [{ severity: 'pass', title: 'Clean skill files' }],
    },
  ],
};

describe('formatTerminal', () => {
  it('produces output containing the score', () => {
    const output = formatTerminal(mockResult, '/home/user/project');
    const plain = stripAnsi(output);
    expect(plain).toContain('54');
    expect(plain).toContain('HYGIENE SCORE');
  });

  it('includes check sub-scores', () => {
    const plain = stripAnsi(formatTerminal(mockResult, '/home/user/project'));
    expect(plain).toContain('CLAUDE.md governance');
    expect(plain).toContain('Secret exposure');
  });

  it('groups findings by severity', () => {
    const plain = stripAnsi(formatTerminal(mockResult, '/home/user/project'));
    expect(plain).toContain('CRITICAL');
    expect(plain).toContain('.env file found but NOT in .gitignore');
  });

  it('suppresses CTA by default (opt-in via --cta)', () => {
    const plain = stripAnsi(formatTerminal(mockResult, '/home/user/project'));
    expect(plain).not.toContain('backroadcreative.com');
  });

  it('includes CTA when noCta is explicitly false', () => {
    const plain = stripAnsi(formatTerminal(mockResult, '/home/user/project', { noCta: false }));
    expect(plain).toContain('backroadcreative.com');
  });

  it('suppresses CTA when noCta is true', () => {
    const plain = stripAnsi(formatTerminal(mockResult, '/home/user/project', { noCta: true }));
    expect(plain).not.toContain('backroadcreative.com');
  });
});

describe('formatTerminalRecursive CTA gating', () => {
  const recursiveResult = {
    score: 60,
    projects: [
      { path: 'project-a', score: 40, results: mockResult.results },
      { path: 'project-b', score: 80, results: [] },
    ],
    worstProject: { path: 'project-a', score: 40 },
  };

  it('suppresses CTA by default', async () => {
    const { formatTerminalRecursive } = await import('../src/reporter.js');
    const plain = stripAnsi(formatTerminalRecursive(recursiveResult, '/root'));
    expect(plain).not.toContain('backroadcreative.com');
  });

  it('includes CTA when noCta is explicitly false', async () => {
    const { formatTerminalRecursive } = await import('../src/reporter.js');
    const plain = stripAnsi(formatTerminalRecursive(recursiveResult, '/root', { noCta: false }));
    expect(plain).toContain('backroadcreative.com');
  });
});

describe('formatJson', () => {
  it('produces valid JSON', () => {
    const json = formatJson(mockResult);
    const parsed = JSON.parse(json);
    expect(parsed.score).toBe(54);
    expect(parsed.results).toHaveLength(6);
  });
});

describe('formatBadge', () => {
  it('produces shields.io markdown', () => {
    const badge = formatBadge(mockResult);
    expect(badge).toContain('shields.io');
    expect(badge).toContain('54');
  });

  it('badge URL includes cacheSeconds parameter', () => {
    const badge = formatBadge(mockResult);
    expect(badge).toContain('cacheSeconds=86400');
  });

  it('links to Back-Road-Creative org, not joepetjr', () => {
    const badge = formatBadge(mockResult);
    expect(badge).toContain('Back-Road-Creative/rigscore');
    expect(badge).not.toContain('joepetjr');
  });
});

describe('stripAnsi', () => {
  it('removes ANSI codes', () => {
    const input = '\x1b[31mred\x1b[0m';
    expect(stripAnsi(input)).toBe('red');
  });
});

describe('formatTerminal evidence field (Moat & Ship Agent A)', () => {
  it('renders evidence line when a finding has one', () => {
    const result = {
      score: 50,
      results: [
        {
          id: 'env-exposure',
          name: 'Secret exposure',
          weight: 8,
          score: 0,
          findings: [
            {
              severity: 'critical',
              title: '.env file found but NOT in .gitignore',
              detail: 'secret exposed',
              evidence: '.env present; .gitignore does not list .env',
              remediation: 'add it',
            },
          ],
        },
      ],
    };
    const output = stripAnsi(formatTerminal(result, '/x'));
    expect(output).toContain('Evidence: .env present; .gitignore does not list .env');
  });

  it('omits evidence line when not present (no empty label)', () => {
    const result = {
      score: 50,
      results: [
        {
          id: 'env-exposure',
          name: 'Secret exposure',
          weight: 8,
          score: 0,
          findings: [
            { severity: 'critical', title: 'No governance file' },
          ],
        },
      ],
    };
    const output = stripAnsi(formatTerminal(result, '/x'));
    expect(output).not.toContain('Evidence:');
  });
});

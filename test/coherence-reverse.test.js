import { describe, it, expect } from 'vitest';
import check from '../src/checks/coherence.js';
import { NOT_APPLICABLE_SCORE } from '../src/constants.js';

/**
 * Reverse coherence: config → governance direction.
 * Checks that MCP servers declared in config are also declared in governance docs.
 */
describe('coherence reverse check', () => {
  // Helpers for building priorResults with reverse-coherence data
  function makePriorResults({ serverNames = [], governanceText = '', extraPatterns = [] } = {}) {
    return [
      {
        id: 'claude-md',
        score: 100,
        findings: [],
        data: {
          matchedPatterns: ['forbidden actions', 'path restrictions', ...extraPatterns],
          governanceText,
        },
      },
      {
        id: 'mcp-config',
        score: 100,
        findings: [],
        data: {
          hasNetworkTransport: false,
          hasBroadFilesystemAccess: false,
          driftDetected: false,
          clientCount: serverNames.length > 0 ? 1 : 0,
          serverCount: serverNames.length,
          serverNames,
        },
      },
      {
        id: 'docker-security',
        score: 100,
        findings: [],
        data: { hasPrivilegedContainer: false },
      },
    ];
  }

  it('emits warning for MCP server not mentioned in governance', async () => {
    // Server "filesystem-mcp" in config, governance text has no mention of it
    const result = await check.run({
      priorResults: makePriorResults({
        serverNames: ['filesystem-mcp'],
        governanceText: 'This governance file says nothing about any tools.',
      }),
    });

    const finding = result.findings.find(
      f => f.severity === 'warning' && f.title.includes('Undeclared MCP server')
    );
    expect(finding).toBeDefined();
    expect(finding.title).toContain('filesystem-mcp');
  });

  it('no warning when MCP server is declared in governance', async () => {
    // Server "filesystem-mcp" in config AND mentioned in governance text
    const result = await check.run({
      priorResults: makePriorResults({
        serverNames: ['filesystem-mcp'],
        governanceText: 'Approved tools: filesystem-mcp is allowed for project reads.',
      }),
    });

    const undeclared = result.findings.filter(
      f => f.severity === 'warning' && f.title.includes('Undeclared MCP server')
    );
    expect(undeclared).toHaveLength(0);
  });

  it('no findings when no MCP servers are configured', async () => {
    const result = await check.run({
      priorResults: makePriorResults({
        serverNames: [],
        governanceText: 'Some governance text with no tools configured.',
      }),
    });

    const reverseFindings = result.findings.filter(
      f => f.title.includes('Undeclared MCP server') || f.title.includes('approved-tools')
    );
    expect(reverseFindings).toHaveLength(0);
  });

  it('emits info when broad-capability server has no approved-tools declaration in governance', async () => {
    // Server "filesystem" in config, governance has no "approved tools" phrase
    const result = await check.run({
      priorResults: makePriorResults({
        serverNames: ['filesystem'],
        governanceText: 'filesystem is a server we use. No explicit tool approvals listed here.',
      }),
    });

    const info = result.findings.find(
      f => f.severity === 'info' && f.title.includes('approved-tools')
    );
    expect(info).toBeDefined();
  });

  it('no info finding when governance has approved-tools declaration', async () => {
    // Server "filesystem" in config, governance has "Approved Tools: filesystem (read-only)"
    const result = await check.run({
      priorResults: makePriorResults({
        serverNames: ['filesystem'],
        governanceText: 'filesystem is configured.\n\nApproved Tools: filesystem (read-only)',
      }),
    });

    const approvedToolsInfo = result.findings.filter(
      f => f.severity === 'info' && f.title.includes('approved-tools')
    );
    expect(approvedToolsInfo).toHaveLength(0);
  });

  it('emits one warning per undeclared server when multiple servers are configured', async () => {
    const result = await check.run({
      priorResults: makePriorResults({
        serverNames: ['filesystem-mcp', 'browser-tools', 'declared-server'],
        governanceText: 'We use declared-server for project tasks. No other tools declared.',
      }),
    });

    const undeclared = result.findings.filter(
      f => f.severity === 'warning' && f.title.includes('Undeclared MCP server')
    );
    // filesystem-mcp and browser-tools are undeclared; declared-server is mentioned
    expect(undeclared).toHaveLength(2);
    const titles = undeclared.map(f => f.title);
    expect(titles.some(t => t.includes('filesystem-mcp'))).toBe(true);
    expect(titles.some(t => t.includes('browser-tools'))).toBe(true);
  });

  it('finding shape has required fields: severity, title, detail, remediation', async () => {
    const result = await check.run({
      priorResults: makePriorResults({
        serverNames: ['filesystem-mcp'],
        governanceText: 'No mention of any server.',
      }),
    });

    const finding = result.findings.find(f => f.title.includes('Undeclared MCP server'));
    expect(finding).toBeDefined();
    expect(finding.severity).toBe('warning');
    expect(typeof finding.title).toBe('string');
    expect(typeof finding.detail).toBe('string');
    expect(typeof finding.remediation).toBe('string');
  });

  it('does not emit reverse findings when mcp-config data is absent', async () => {
    // priorResults without mcp-config data.serverNames — graceful degradation
    const result = await check.run({
      priorResults: [
        {
          id: 'claude-md',
          score: 100,
          findings: [],
          data: { matchedPatterns: ['forbidden actions'], governanceText: '' },
        },
        {
          id: 'mcp-config',
          score: 100,
          findings: [],
          data: {
            hasNetworkTransport: false,
            hasBroadFilesystemAccess: false,
            driftDetected: false,
            clientCount: 1,
            serverCount: 2,
            // serverNames intentionally omitted — backward compat
          },
        },
        {
          id: 'docker-security',
          score: 100,
          findings: [],
          data: { hasPrivilegedContainer: false },
        },
      ],
    });

    const undeclared = result.findings.filter(f => f.title.includes('Undeclared MCP server'));
    expect(undeclared).toHaveLength(0);
  });
});

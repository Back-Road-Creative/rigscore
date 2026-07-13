import { describe, it, expect } from 'vitest';
import check from '../src/checks/coherence.js';
import { NOT_APPLICABLE_SCORE, WEIGHTS } from '../src/constants.js';

describe('coherence check', () => {
  it('has required shape', () => {
    expect(check.id).toBe('coherence');
    expect(WEIGHTS[check.id]).toBe(14);
  });

  it('returns N/A when no prior results', async () => {
    const result = await check.run({ priorResults: [] });
    expect(result.score).toBe(NOT_APPLICABLE_SCORE);
  });

  it('returns N/A when governance is missing', async () => {
    const result = await check.run({
      priorResults: [
        { id: 'claude-md', score: NOT_APPLICABLE_SCORE, findings: [] },
        { id: 'mcp-config', score: 100, findings: [], data: { hasNetworkTransport: false, hasBroadFilesystemAccess: false } },
        { id: 'docker-security', score: 100, findings: [], data: { hasPrivilegedContainer: false } },
      ],
    });
    expect(result.score).toBe(NOT_APPLICABLE_SCORE);
  });

  it('PASS when config is coherent with governance', async () => {
    const result = await check.run({
      priorResults: [
        {
          id: 'claude-md',
          score: 100,
          findings: [],
          // A passing claude-md always exports governanceText (claude-md.js
          // returns it on every non-early-return path); coherence keys N/A-vs-
          // PASS off real governance text, so the fixture must carry it.
          data: {
            matchedPatterns: ['network restrictions', 'path restrictions', 'forbidden actions'],
            governanceText: 'No external network access. Paths restricted to the project directory. Forbidden actions are defined.',
          },
        },
        {
          id: 'mcp-config',
          score: 100,
          findings: [],
          data: { hasNetworkTransport: false, hasBroadFilesystemAccess: false },
        },
        {
          id: 'docker-security',
          score: 100,
          findings: [],
          data: { hasPrivilegedContainer: false },
        },
      ],
    });
    expect(result.score).toBe(100);
    expect(result.findings[0].severity).toBe('pass');
  });

  it('WARNING when governance claims network restrictions but MCP uses network', async () => {
    const result = await check.run({
      priorResults: [
        {
          id: 'claude-md',
          score: 100,
          findings: [],
          data: { matchedPatterns: ['network restrictions'] },
        },
        {
          id: 'mcp-config',
          score: 70,
          findings: [],
          data: { hasNetworkTransport: true, hasBroadFilesystemAccess: false },
        },
        {
          id: 'docker-security',
          score: 100,
          findings: [],
          data: { hasPrivilegedContainer: false },
        },
      ],
    });
    const warning = result.findings.find(f => f.title.includes('network restrictions'));
    expect(warning).toBeDefined();
    expect(warning.severity).toBe('warning');
  });

  it('WARNING when governance claims path restrictions but MCP has broad access', async () => {
    const result = await check.run({
      priorResults: [
        {
          id: 'claude-md',
          score: 100,
          findings: [],
          data: { matchedPatterns: ['path restrictions'] },
        },
        {
          id: 'mcp-config',
          score: 0,
          findings: [],
          data: { hasNetworkTransport: false, hasBroadFilesystemAccess: true },
        },
        {
          id: 'docker-security',
          score: 100,
          findings: [],
          data: { hasPrivilegedContainer: false },
        },
      ],
    });
    const warning = result.findings.find(f => f.title.includes('path restrictions'));
    expect(warning).toBeDefined();
  });

  it('WARNING when governance claims forbidden actions but Docker is privileged', async () => {
    const result = await check.run({
      priorResults: [
        {
          id: 'claude-md',
          score: 100,
          findings: [],
          data: { matchedPatterns: ['forbidden actions'] },
        },
        {
          id: 'mcp-config',
          score: NOT_APPLICABLE_SCORE,
          findings: [],
          data: { hasNetworkTransport: false, hasBroadFilesystemAccess: false },
        },
        {
          id: 'docker-security',
          score: 0,
          findings: [],
          data: { hasPrivilegedContainer: true },
        },
      ],
    });
    const warning = result.findings.find(f => f.title.includes('forbidden actions'));
    expect(warning).toBeDefined();
  });

  it('CRITICAL when governance file is gitignored', async () => {
    const result = await check.run({
      priorResults: [
        {
          id: 'claude-md',
          score: 0,
          findings: [
            { severity: 'critical', title: 'Governance file CLAUDE.md is in .gitignore' },
          ],
          data: { matchedPatterns: [] },
        },
        {
          id: 'mcp-config',
          score: 100,
          findings: [],
          data: { hasNetworkTransport: false, hasBroadFilesystemAccess: false },
        },
        {
          id: 'docker-security',
          score: NOT_APPLICABLE_SCORE,
          findings: [],
          data: { hasPrivilegedContainer: false },
        },
      ],
    });
    // Downgraded to info to avoid double-counting with claude-md check
    const info = result.findings.find(f => f.severity === 'info' && f.title.includes('gitignored'));
    expect(info).toBeDefined();
  });

  it('WARNING when governance has shell restrictions but skill files have shell findings', async () => {
    const result = await check.run({
      priorResults: [
        {
          id: 'claude-md',
          score: 100,
          findings: [],
          data: { matchedPatterns: ['shell restrictions'] },
        },
        {
          id: 'skill-files',
          score: 70,
          findings: [],
          data: { filesScanned: 1, injectionFindings: 0, exfiltrationFindings: 0, shellFindings: 2 },
        },
        {
          id: 'mcp-config',
          score: 100,
          findings: [],
          data: { hasNetworkTransport: false, hasBroadFilesystemAccess: false },
        },
        {
          id: 'docker-security',
          score: 100,
          findings: [],
          data: { hasPrivilegedContainer: false },
        },
      ],
    });
    const warning = result.findings.find(f => f.title.includes('shell restrictions'));
    expect(warning).toBeDefined();
    expect(warning.severity).toBe('warning');
  });

  it('multiple contradictions compound', async () => {
    const result = await check.run({
      priorResults: [
        {
          id: 'claude-md',
          score: 100,
          findings: [],
          data: { matchedPatterns: ['network restrictions', 'path restrictions', 'forbidden actions'] },
        },
        {
          id: 'mcp-config',
          score: 0,
          findings: [],
          data: { hasNetworkTransport: true, hasBroadFilesystemAccess: true },
        },
        {
          id: 'docker-security',
          score: 0,
          findings: [],
          data: { hasPrivilegedContainer: true },
        },
      ],
    });
    const warnings = result.findings.filter(f => f.severity === 'warning');
    expect(warnings.length).toBe(3);
    // 3 WARNINGs = 100 - 45 = 55
    expect(result.score).toBe(55);
  });
});

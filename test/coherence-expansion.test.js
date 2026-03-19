import { describe, it, expect } from 'vitest';
import check from '../src/checks/coherence.js';
import { NOT_APPLICABLE_SCORE } from '../src/constants.js';

describe('coherence expansion', () => {
  it('WARNING when MCP drift detected across multiple clients', async () => {
    const context = {
      priorResults: [
        {
          id: 'claude-md',
          score: 100,
          findings: [{ severity: 'pass', title: 'All good' }],
          data: { matchedPatterns: ['forbidden actions'] },
        },
        {
          id: 'mcp-config',
          score: 85,
          findings: [{ severity: 'warning', title: 'drift' }],
          data: { hasNetworkTransport: false, hasBroadFilesystemAccess: false, driftDetected: true, clientCount: 3, serverCount: 5 },
        },
        {
          id: 'docker-security',
          score: 100,
          findings: [],
          data: { hasPrivilegedContainer: false },
        },
      ],
    };

    const result = await check.run(context);
    const drift = result.findings.find(f => f.title?.includes('drift'));
    expect(drift).toBeDefined();
    expect(drift.severity).toBe('warning');
  });

  it('CRITICAL when governance claims anti-injection but skill files have injections', async () => {
    const context = {
      priorResults: [
        {
          id: 'claude-md',
          score: 100,
          findings: [{ severity: 'pass', title: 'ok' }],
          data: { matchedPatterns: ['anti-injection', 'forbidden actions'] },
        },
        {
          id: 'mcp-config',
          score: 100,
          findings: [],
          data: { hasNetworkTransport: false, hasBroadFilesystemAccess: false, driftDetected: false, clientCount: 1, serverCount: 1 },
        },
        {
          id: 'skill-files',
          score: 0,
          findings: [{ severity: 'critical', title: 'Injection found' }],
          data: { filesScanned: 1, injectionFindings: 1, exfiltrationFindings: 0 },
        },
        {
          id: 'docker-security',
          score: 100,
          findings: [],
          data: { hasPrivilegedContainer: false },
        },
      ],
    };

    const result = await check.run(context);
    const finding = result.findings.find(f => f.title?.includes('anti-injection'));
    expect(finding).toBeDefined();
    expect(finding.severity).toBe('critical');
  });

  it('CRITICAL for compound risk: exfiltration + broad filesystem', async () => {
    const context = {
      priorResults: [
        {
          id: 'claude-md',
          score: 100,
          findings: [{ severity: 'pass', title: 'ok' }],
          data: { matchedPatterns: [] },
        },
        {
          id: 'mcp-config',
          score: 0,
          findings: [{ severity: 'critical', title: 'broad fs' }],
          data: { hasNetworkTransport: false, hasBroadFilesystemAccess: true, driftDetected: false, clientCount: 1, serverCount: 1 },
        },
        {
          id: 'skill-files',
          score: 85,
          findings: [{ severity: 'warning', title: 'Exfiltration' }],
          data: { filesScanned: 1, injectionFindings: 0, exfiltrationFindings: 1 },
        },
        {
          id: 'docker-security',
          score: 100,
          findings: [],
          data: { hasPrivilegedContainer: false },
        },
      ],
    };

    const result = await check.run(context);
    const finding = result.findings.find(f => f.title?.includes('Compound risk'));
    expect(finding).toBeDefined();
    expect(finding.severity).toBe('critical');
  });

  it('no drift warning when only one client', async () => {
    const context = {
      priorResults: [
        {
          id: 'claude-md',
          score: 100,
          findings: [{ severity: 'pass', title: 'ok' }],
          data: { matchedPatterns: [] },
        },
        {
          id: 'mcp-config',
          score: 100,
          findings: [],
          data: { hasNetworkTransport: false, hasBroadFilesystemAccess: false, driftDetected: false, clientCount: 1, serverCount: 2 },
        },
        {
          id: 'docker-security',
          score: 100,
          findings: [],
          data: { hasPrivilegedContainer: false },
        },
      ],
    };

    const result = await check.run(context);
    const drift = result.findings.find(f => f.title?.includes('drift'));
    expect(drift).toBeUndefined();
  });
});

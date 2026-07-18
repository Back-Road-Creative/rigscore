import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { scan } from '../src/scanner.js';
import check from '../src/checks/coherence.js';
import { NOT_APPLICABLE_SCORE } from '../src/constants.js';

// Regression: coherence must return N/A (per its Triggers table:
// "Insufficient data (no governance ...) -> SKIPPED (score = N/A)") when a
// repo has configuration (.mcp.json) but NO governance file. Previously the
// PASS-vs-N/A gate keyed `hasGovernance` off `claudeMdResult.score !== N/A`.
// But claude-md's no-governance-file path returns a CRITICAL with score 0
// (not the -1 N/A sentinel) and NO `data.governanceText`, so the gate saw
// governance where there was none, reverse coherence never ran (it is gated
// on non-empty governanceText), and the check emitted a FALSE PASS (100) on a
// weight-14 surface for a repo with zero governance and undeclared servers.
// The gate now keys off whether there is real governance TEXT to check.

describe('coherence: N/A when configuration exists but no governance file', () => {
  it('scan() with .mcp.json and no CLAUDE.md returns N/A, never a PASS', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-coherence-nogov-'));
    // Throwaway homedir: a real ~/.claude/CLAUDE.md or ~/CLAUDE.md must NOT
    // satisfy governance for this fixture (claude-md scans homedir paths too).
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-coherence-home-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
      fs.writeFileSync(
        path.join(tmpDir, '.mcp.json'),
        JSON.stringify({ mcpServers: { undeclaredserver: { command: 'node', args: ['s.js'] } } }),
      );
      // NOTE: intentionally no CLAUDE.md — claude-md returns a CRITICAL
      // (score 0), NOT the N/A sentinel, and exports no governanceText.

      const result = await scan({ cwd: tmpDir, homedir: tmpHome });
      const coherence = result.results.find((r) => r.id === 'coherence');
      const claudeMd = result.results.find((r) => r.id === 'governance-docs');

      // Precondition sanity: this is the exact shape that fooled the old gate.
      expect(claudeMd.score).not.toBe(NOT_APPLICABLE_SCORE); // real 0, not -1

      // The fix: no real governance text -> N/A, and definitely not a PASS.
      expect(coherence.score).toBe(NOT_APPLICABLE_SCORE);
      expect(coherence.findings.some((f) => f.severity === 'pass')).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
      fs.rmSync(tmpHome, { recursive: true });
    }
  });

  // ---- Boundary tests: prove only the no-governance path was narrowed. ----

  // Mirrors claude-md.js output shapes so the coherence gate is exercised
  // exactly as the scanner drives it.
  function priorResults({ claudeMd, serverNames = [], mcpScore = 100 }) {
    return [
      claudeMd,
      {
        id: 'mcp-config',
        score: mcpScore,
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
    ];
  }

  const govPass = (governanceText) => ({
    id: 'governance-docs',
    score: 100,
    findings: [],
    data: { matchedPatterns: ['forbidden actions', 'path restrictions'], governanceText },
  });

  it('(a) governance present + all servers declared -> still PASS', async () => {
    const result = await check.run({
      priorResults: priorResults({
        claudeMd: govPass('We use declared-server for project reads.'),
        serverNames: ['declared-server'],
      }),
    });
    expect(result.score).toBe(100);
    expect(result.findings.some((f) => f.severity === 'pass')).toBe(true);
  });

  it('(b) governance present + an undeclared server -> still WARNING', async () => {
    const result = await check.run({
      priorResults: priorResults({
        claudeMd: govPass('Governance prose that names no server at all.'),
        serverNames: ['undeclaredserver'],
      }),
    });
    expect(result.findings.some((f) => f.findingId === 'coherence/undeclared-mcp-server')).toBe(true);
    expect(result.score).not.toBe(NOT_APPLICABLE_SCORE);
    expect(result.findings.some((f) => f.severity === 'pass')).toBe(false);
  });

  it('(c) no governance file (claude-md CRITICAL, no governanceText) + config -> N/A', async () => {
    const result = await check.run({
      priorResults: priorResults({
        // Exactly what claude-md returns when there is no governance file:
        // CRITICAL, score 0, and NO `data` (so governanceText resolves to '').
        claudeMd: {
          id: 'governance-docs',
          score: 0,
          findings: [
            {
              findingId: 'governance-docs/no-governance-file',
              severity: 'critical',
              title: 'No governance file found',
            },
          ],
        },
        serverNames: ['undeclaredserver'],
      }),
    });
    expect(result.score).toBe(NOT_APPLICABLE_SCORE);
    expect(result.findings).toHaveLength(0);
  });
});

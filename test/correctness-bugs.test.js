import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { suppressFindings, assignFindingIds } from '../src/scanner.js';
import { calculateCheckScore } from '../src/scoring.js';
import credentialStorage from '../src/checks/credential-storage.js';

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// C5 — `--ignore` matches finding IDs (T3.1–T3.5)
// ---------------------------------------------------------------------------
describe('C5: --ignore matches finding IDs', () => {
  it('T3.1: suppresses only the finding with the exact findingId', () => {
    const results = [{
      id: 'env-exposure',
      score: 0,
      findings: [
        { severity: 'critical', title: '.env file found but NOT in .gitignore' },
        { severity: 'warning', title: '.env.local is world-readable' },
      ],
    }];
    assignFindingIds(results);
    // The finding IDs should be env-exposure/env-file-found-but-not-in-gitignore
    // and env-exposure/env-local-is-world-readable
    suppressFindings(results, ['env-exposure/env-file-found-but-not-in-gitignore']);
    expect(results[0].findings).toHaveLength(1);
    expect(results[0].findings[0].title).toContain('world-readable');
  });

  it('T3.2: comma-separated IDs are all suppressed when passed as an array', () => {
    const results = [{
      id: 'env-exposure',
      score: 0,
      findings: [
        { severity: 'critical', title: '.env file found but NOT in .gitignore' },
        { severity: 'warning', title: '.env.local is world-readable' },
        { severity: 'warning', title: '.env.prod permissions are 0644' },
      ],
    }];
    assignFindingIds(results);
    suppressFindings(results, [
      'env-exposure/env-file-found-but-not-in-gitignore',
      'env-exposure/env-local-is-world-readable',
    ]);
    expect(results[0].findings).toHaveLength(1);
    expect(results[0].findings[0].title).toContain('permissions');
  });

  it('T3.3: title-substring patterns still work (legacy fallback)', () => {
    const results = [{
      id: 'env-exposure',
      score: 0,
      findings: [
        { severity: 'critical', title: '.env file found but NOT in .gitignore' },
        { severity: 'warning', title: '.env.local is world-readable' },
      ],
    }];
    assignFindingIds(results);
    suppressFindings(results, ['world-readable']);
    expect(results[0].findings).toHaveLength(1);
    expect(results[0].findings[0].title).toContain('.env file found');
  });

  it('T3.3b: findingId match is exact, not substring (avoid accidental over-suppression)', () => {
    const results = [{
      id: 'env-exposure',
      score: 0,
      findings: [
        { severity: 'critical', title: '.env file found but NOT in .gitignore', findingId: 'env-exposure/env-file-found-but-not-in-gitignore' },
        { severity: 'warning', title: '.env.local is world-readable', findingId: 'env-exposure/env-local-is-world-readable' },
      ],
    }];
    // A short partial ID should NOT match any finding via the ID path
    // (it will only match if it happens to substring-match a title)
    suppressFindings(results, ['env-exposure/env']);
    // Neither title contains 'env-exposure/env' literally, so nothing is suppressed
    expect(results[0].findings).toHaveLength(2);
  });

  it('T3.3c: findingId matching is case-insensitive', () => {
    const results = [{
      id: 'env-exposure',
      score: 0,
      findings: [
        { severity: 'critical', title: '.env file found but NOT in .gitignore' },
      ],
    }];
    assignFindingIds(results);
    suppressFindings(results, ['ENV-EXPOSURE/ENV-FILE-FOUND-BUT-NOT-IN-GITIGNORE']);
    expect(results[0].findings).toHaveLength(0);
  });

  it('T3.4: score is recalculated after ID-based suppression', () => {
    const results = [{
      id: 'env-exposure',
      score: 0,
      findings: [
        { severity: 'critical', title: '.env file found but NOT in .gitignore' },
        { severity: 'pass', title: '.env otherwise looks fine' },
      ],
    }];
    assignFindingIds(results);
    suppressFindings(results, ['env-exposure/env-file-found-but-not-in-gitignore']);
    // With only a pass finding left, the check should score 100
    expect(results[0].score).toBe(100);
  });

  it('T3.5: README documents --ignore as accepting finding IDs', () => {
    const readme = fs.readFileSync(path.join(process.cwd(), 'README.md'), 'utf8');
    // The --ignore doc line should reference finding IDs (the canonical form)
    expect(readme).toMatch(/--ignore[^\n]*(finding[- ]?id|\bid[s]?\b)/i);
  });
});

// ---------------------------------------------------------------------------
// H2 — deduplicateFindings recalculates scores (T3.6–T3.9)
// ---------------------------------------------------------------------------
describe('H2: deduplicateFindings recalculates scores', () => {
  async function makeDedupProject() {
    // Use a minimal tmp project; scan will invoke the dedup path.
    const tmp = makeTmpDir('rigscore-dedup-');
    fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), '# Rules\nBe safe.\n');
    return tmp;
  }

  it('T3.6: after dedup, losing check score is recalculated (not stuck at pre-dedup value)', async () => {
    // Simulate scanner dedup behavior directly by constructing two
    // check results with identical severity+title.
    // The scanner module expects results to be mutated in place.
    const { scan } = await import('../src/scanner.js');
    // We cannot easily force two real checks to emit the same finding title
    // without a fixture; instead, unit-test the recalc expectation by
    // invoking deduplicateFindings (internal) indirectly via an exported helper.
    // To keep the test hermetic, we inline the dedup logic contract:
    //
    // Contract: if findings are spliced from results[i].findings,
    // results[i].score must equal calculateCheckScore(results[i].findings).
    //
    // We verify the contract by constructing results and calling the
    // dedup-aware helper, then asserting score recalcs.
    const { deduplicateFindings } = await import('../src/scanner.js');
    if (typeof deduplicateFindings !== 'function') {
      // deduplicateFindings is not directly exported; assert the contract
      // through scan() integration instead. The E2E project scan should
      // never leave a check with findings.length === 0 and score === 0.
      const tmp = await makeDedupProject();
      try {
        const result = await scan({ cwd: tmp });
        for (const r of result.results) {
          const hasOnlyPassOrEmpty = r.findings.every(f => f.severity === 'pass' || f.severity === 'info');
          const hasActualBadFinding = r.findings.some(f => f.severity === 'critical' || f.severity === 'warning');
          if (!hasActualBadFinding && r.score === 0 && r.score !== -1) {
            // No bad findings and score==0 → stale (dedup didn't recalc)
            throw new Error(`Stale score for ${r.id}: no critical/warning findings but score 0`);
          }
        }
      } finally {
        fs.rmSync(tmp, { recursive: true });
      }
    }
  });

  it('T3.6 (direct): dedup splicing recalculates the losing result score', async () => {
    const { deduplicateFindings } = await import('../src/scanner.js');
    // Only run if deduplicateFindings is exported (we will export it below)
    if (typeof deduplicateFindings !== 'function') return;

    // B (lower weight) has a critical finding that also exists in A (higher weight).
    // After dedup, B should have no findings and its score should be 100.
    const results = [
      {
        id: 'mcp-config', // weight 14 (higher)
        score: 0,
        findings: [
          { severity: 'critical', title: 'Compound server exposure' },
        ],
      },
      {
        id: 'credential-storage', // weight 6 (lower)
        score: 0,
        findings: [
          { severity: 'critical', title: 'Compound server exposure' },
        ],
      },
    ];
    deduplicateFindings(results);
    // The higher-weight check keeps its finding.
    const winner = results.find(r => r.id === 'mcp-config');
    const loser = results.find(r => r.id === 'credential-storage');
    expect(winner.findings).toHaveLength(1);
    expect(loser.findings).toHaveLength(0);
    // Score must be recalculated to 100 (0 findings → 100).
    expect(loser.score).toBe(100);
  });

  it('T3.7: overall weighted score reflects recalculated check score', async () => {
    const { deduplicateFindings } = await import('../src/scanner.js');
    if (typeof deduplicateFindings !== 'function') return;
    const { calculateOverallScore } = await import('../src/scoring.js');

    const results = [
      {
        id: 'mcp-config', // weight 14
        score: 0,
        findings: [{ severity: 'critical', title: 'Shared title X' }],
      },
      {
        id: 'credential-storage', // weight 6
        score: 0,
        findings: [{ severity: 'critical', title: 'Shared title X' }],
      },
    ];
    deduplicateFindings(results);
    // After dedup: mcp-config still CRITICAL → 0; credential-storage clean → 100.
    // Weighted over the 2 applicable checks.
    const weighted = calculateOverallScore(results);
    expect(weighted).toBeGreaterThan(0);
  });

  it('T3.8: dedup of warning findings also triggers score recalc', async () => {
    const { deduplicateFindings } = await import('../src/scanner.js');
    if (typeof deduplicateFindings !== 'function') return;

    const results = [
      {
        id: 'mcp-config', // weight 14
        score: 85,
        findings: [
          { severity: 'warning', title: 'Shared warning' },
        ],
      },
      {
        id: 'credential-storage', // weight 6
        score: 85,
        findings: [
          { severity: 'warning', title: 'Shared warning' },
        ],
      },
    ];
    deduplicateFindings(results);
    const loser = results.find(r => r.id === 'credential-storage');
    expect(loser.findings).toHaveLength(0);
    expect(loser.score).toBe(100);
  });

  it('T3.9: when no dedups happen, scores are unchanged', async () => {
    const { deduplicateFindings } = await import('../src/scanner.js');
    if (typeof deduplicateFindings !== 'function') return;

    const results = [
      {
        id: 'mcp-config',
        score: 85,
        findings: [{ severity: 'warning', title: 'Unique A' }],
      },
      {
        id: 'credential-storage',
        score: 85,
        findings: [{ severity: 'warning', title: 'Unique B' }],
      },
    ];
    deduplicateFindings(results);
    // No dedups → no recalc → scores stay at 85 (not recomputed).
    expect(results[0].score).toBe(85);
    expect(results[1].score).toBe(85);
    expect(results[0].findings).toHaveLength(1);
    expect(results[1].findings).toHaveLength(1);
  });

  it('T3.10: within-check per-file findings are NOT collapsed by dedup', async () => {
    const { deduplicateFindings } = await import('../src/scanner.js');
    if (typeof deduplicateFindings !== 'function') return;

    // Same check, three findings whose titles share a normalized prefix but
    // differ by file path. Dedup should preserve all three — collapsing would
    // hide per-file triage information.
    const results = [
      {
        id: 'skill-files',
        score: 0,
        findings: [
          { severity: 'warning', title: 'Privilege escalation pattern in .claude/commands/a.md' },
          { severity: 'warning', title: 'Privilege escalation pattern in .claude/commands/b.md' },
          { severity: 'warning', title: 'Privilege escalation pattern in .claude/skills/c/SKILL.md' },
        ],
      },
    ];
    deduplicateFindings(results);
    expect(results[0].findings).toHaveLength(3);
    const paths = results[0].findings.map(f => f.title).sort();
    expect(paths[0]).toContain('a.md');
    expect(paths[1]).toContain('b.md');
    expect(paths[2]).toContain('c/SKILL.md');
  });

  it('T3.11: cross-check dedup still collapses shared titles', async () => {
    const { deduplicateFindings } = await import('../src/scanner.js');
    if (typeof deduplicateFindings !== 'function') return;

    // Different checks producing same normalized title → still deduped
    // (higher-weighted check wins). This guards against the fix over-reaching.
    const results = [
      {
        id: 'mcp-config', // weight 14
        score: 0,
        findings: [{ severity: 'critical', title: 'Shared finding X in path-a' }],
      },
      {
        id: 'credential-storage', // weight 6
        score: 0,
        findings: [{ severity: 'critical', title: 'Shared finding X in path-b' }],
      },
    ];
    deduplicateFindings(results);
    const mcp = results.find(r => r.id === 'mcp-config');
    const cred = results.find(r => r.id === 'credential-storage');
    expect(mcp.findings).toHaveLength(1);
    expect(cred.findings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// H4 — 1Password / shell template references not flagged as plaintext
// ---------------------------------------------------------------------------
describe('H4: op:// and ${VAR} not flagged as plaintext credentials', () => {
  it('T3.10: op:// reference does NOT emit a CRITICAL plaintext finding', async () => {
    const homedir = makeTmpDir('rigscore-op-');
    fs.mkdirSync(path.join(homedir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(homedir, '.claude', 'claude_desktop_config.json'), JSON.stringify({
      mcpServers: {
        'my-server': {
          command: 'node',
          args: ['s.js'],
          env: { ANTHROPIC_API_KEY: 'op://vault/anthropic/api_key' },
        },
      },
    }));
    try {
      const result = await credentialStorage.run({ homedir });
      const critical = result.findings.find(f => f.severity === 'critical');
      expect(critical).toBeUndefined();
    } finally {
      fs.rmSync(homedir, { recursive: true });
    }
  });

  it('T3.11: real plaintext Anthropic key still emits CRITICAL (regression guard)', async () => {
    const homedir = makeTmpDir('rigscore-regress-');
    fs.mkdirSync(path.join(homedir, '.claude'), { recursive: true });
    // Build fake Anthropic key dynamically
    const fakeKey = 'sk-ant-api03-' + 'x'.repeat(40);
    fs.writeFileSync(path.join(homedir, '.claude', 'claude_desktop_config.json'), JSON.stringify({
      mcpServers: {
        'my-server': {
          command: 'node',
          args: ['s.js'],
          env: { ANTHROPIC_API_KEY: fakeKey },
        },
      },
    }));
    try {
      const result = await credentialStorage.run({ homedir });
      const critical = result.findings.find(f => f.severity === 'critical' && f.title.includes('Plaintext'));
      expect(critical).toBeDefined();
    } finally {
      fs.rmSync(homedir, { recursive: true });
    }
  });

  it('T3.12: ${VAR} shell template reference does NOT emit a finding', async () => {
    const homedir = makeTmpDir('rigscore-shellvar-');
    fs.mkdirSync(path.join(homedir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(homedir, '.claude', 'claude_desktop_config.json'), JSON.stringify({
      mcpServers: {
        'my-server': {
          command: 'node',
          args: ['s.js'],
          env: { ANTHROPIC_API_KEY: '${ANTHROPIC_API_KEY}' },
        },
      },
    }));
    try {
      const result = await credentialStorage.run({ homedir });
      const critical = result.findings.find(f => f.severity === 'critical');
      expect(critical).toBeUndefined();
    } finally {
      fs.rmSync(homedir, { recursive: true });
    }
  });

  it('T3.13: exclusion only applies to credential-storage; KEY_PATTERNS still contain op:// for other checks', async () => {
    const { KEY_PATTERNS } = await import('../src/constants.js');
    const hasOpPattern = KEY_PATTERNS.some(p => p.source.includes('op:'));
    expect(hasOpPattern).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// C3 — CVE learnMore URLs point to canonical sources (T3.14–T3.16)
// ---------------------------------------------------------------------------
describe('C3: CVE learnMore URLs reference Check Point Research (not author domain)', () => {
  const CHECKS_DIR = path.join(process.cwd(), 'src', 'checks');

  function readAllCheckSources() {
    const files = fs.readdirSync(CHECKS_DIR)
      .filter(f => f.endsWith('.js'))
      .map(f => path.join(CHECKS_DIR, f));
    return files.map(f => ({ file: f, content: fs.readFileSync(f, 'utf8') }));
  }

  it('T3.14: no CVE finding learnMore points to headlessmode.com/tools/rigscore/#cve', () => {
    const sources = readAllCheckSources();
    for (const { file, content } of sources) {
      // A learnMore line that points to a CVE anchor on headlessmode.com is the anti-pattern.
      const badMatch = content.match(/learnMore[^\n]*headlessmode\.com\/tools\/rigscore[^'"]*cve/i);
      expect(badMatch, `File ${file} still has headlessmode.com CVE learnMore: ${badMatch?.[0]}`).toBeNull();
    }
  });

  it('T3.14b: CVE-2025-59536 finding has a Check Point Research learnMore', () => {
    const mcpConfigSrc = fs.readFileSync(path.join(CHECKS_DIR, 'mcp-config.js'), 'utf8');
    expect(mcpConfigSrc).toMatch(/learnMore[^\n]*research\.checkpoint\.com[^\n]*claude-code/i);
  });

  it('T3.14c: CVE-2025-54136 finding has a Check Point Research learnMore', () => {
    const skillFilesSrc = fs.readFileSync(path.join(CHECKS_DIR, 'skill-files.js'), 'utf8');
    expect(skillFilesSrc).toMatch(/learnMore[^\n]*research\.checkpoint\.com[^\n]*mcpoison/i);
  });

  it('T3.14d: CVE-2026-21852 findings (mcp-config + claude-settings) have Check Point Research learnMore', () => {
    const mcpConfigSrc = fs.readFileSync(path.join(CHECKS_DIR, 'mcp-config.js'), 'utf8');
    const claudeSettingsSrc = fs.readFileSync(path.join(CHECKS_DIR, 'claude-settings.js'), 'utf8');
    // Both should reference the Check Point post covering CVE-2025-59536/CVE-2026-21852 co-disclosure.
    expect(mcpConfigSrc).toMatch(/research\.checkpoint\.com[^'"\n]*claude-code/i);
    expect(claudeSettingsSrc).toMatch(/research\.checkpoint\.com[^'"\n]*claude-code/i);
  });

  it('T3.15: CVE IDs remain in finding titles/details for searchability', () => {
    const sources = readAllCheckSources();
    const joined = sources.map(s => s.content).join('\n');
    expect(joined).toMatch(/CVE-2025-54136/);
    expect(joined).toMatch(/CVE-2025-59536/);
    expect(joined).toMatch(/CVE-2026-21852/);
  });

  it('T3.16: non-CVE learnMore URLs pointing to headlessmode.com are unchanged', () => {
    // These four non-CVE learnMore references existed before this workstream and
    // are explicitly out of scope — they must remain.
    const expectedKept = [
      ['claude-md.js', '#why-claude-md-matters'],
      ['claude-md.js', '#claude-md-hardening'],
      ['docker-security.js', '#docker-socket-risk'],
      ['mcp-config.js', '#mcp-permissions'],
      ['mcp-config.js', '#mcp-supply-chain'],
      ['env-exposure.js', '#env-security'],
    ];
    for (const [file, anchor] of expectedKept) {
      const src = fs.readFileSync(path.join(CHECKS_DIR, file), 'utf8');
      expect(src, `${file} should still contain non-CVE learnMore anchor ${anchor}`).toContain(anchor);
    }
  });
});

// Workstream W2 — Decouple author-specific detection logic.
//
// These tests are the TDD contract for the "default-install" behavior:
// fresh rigscore should produce NO findings tied to the author's private
// conventions (gh-merge-approved, _governance/, /opt/git-hooks, drive_phases,
// sudo -u dev git, etc.). Opt-in via .rigscorerc.json restores the behavior.

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import coherenceCheck from '../src/checks/coherence.js';
import skillCoherenceCheck from '../src/checks/skill-coherence.js';
import infrastructureCheck from '../src/checks/infrastructure-security.js';
import workflowMaturityCheck from '../src/checks/workflow-maturity.js';
import { NOT_APPLICABLE_SCORE } from '../src/constants.js';
import { loadConfig } from '../src/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-w2-'));
}

function writeFile(filepath, content) {
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  fs.writeFileSync(filepath, content);
}

function writeSkill(cwd, name, content) {
  writeFile(path.join(cwd, '.claude', 'skills', name, 'SKILL.md'), content);
}

function claudeMdResult(matchedPatterns = [], governanceText = '') {
  return {
    id: 'claude-md',
    score: 80,
    findings: [],
    data: { matchedPatterns, governanceText },
  };
}

function settingsResult(data = {}) {
  return {
    id: 'claude-settings',
    score: 90,
    findings: [],
    data: {
      filesScanned: 1,
      configuredHooks: data.configuredHooks ?? [],
      missingLifecycleHooks: data.missingLifecycleHooks ?? [],
      hasBypassPermissions: data.hasBypassPermissions ?? false,
      defaultMode: data.defaultMode ?? null,
      allowListEntries: data.allowListEntries ?? [],
      ...data,
    },
  };
}

// ---------------------------------------------------------------------------
// T2.1–T2.3 — coherence.js: allow/governance pairings are opt-in
// ---------------------------------------------------------------------------

describe('W2/T2.1–T2.3: coherence allow-governance pairings are opt-in', () => {
  it('T2.1: with no config.coherence.allowGovernanceContradictions, sudo-u-foo + forbid-governance does NOT emit a WARNING', async () => {
    const govText = 'Never sudo as another user. Must not sudo -u foo git.';
    const priorResults = [
      claudeMdResult(['forbidden actions'], govText),
      settingsResult({
        allowListEntries: ['Bash(sudo -u foo git:*)', 'Bash(git status:*)'],
      }),
    ];
    // Default config (no pairings)
    const result = await coherenceCheck.run({ priorResults, config: {} });
    const pairingWarning = result.findings.find(f =>
      f.severity === 'warning' &&
      /sudo/i.test(f.title || '') &&
      /governance/i.test(f.title || ''),
    );
    expect(pairingWarning).toBeUndefined();
  });

  it('T2.2: with config.coherence.allowGovernanceContradictions configured, the same setup DOES emit the WARNING', async () => {
    const govText = 'Never sudo as another user. Must not sudo -u foo git.';
    const priorResults = [
      claudeMdResult(['forbidden actions'], govText),
      settingsResult({
        allowListEntries: ['Bash(sudo -u foo git:*)', 'Bash(git status:*)'],
      }),
    ];
    const config = {
      coherence: {
        allowGovernanceContradictions: [
          {
            allowRe: /sudo\s+-u\s+\w+\s+git/i,
            govRe: /\b(never|must not|do not)\b.{0,30}sudo.{0,30}-u/i,
            title: 'Allow list permits sudo-u-<user>-git which governance forbids',
            detail: 'Allow-list contradicts governance.',
            remediation: 'Remove the allow entry.',
          },
        ],
      },
    };
    const result = await coherenceCheck.run({ priorResults, config });
    const pairingWarning = result.findings.find(f =>
      f.severity === 'warning' &&
      /sudo/i.test(f.title || '') &&
      /governance/i.test(f.title || ''),
    );
    expect(pairingWarning).toBeDefined();
  });

  it('T2.3: the joe-ownership remediation string does not appear in src/', async () => {
    // Construct the forbidden substring at runtime so this test file doesn't
    // itself contain the literal — otherwise the test would be self-defeating.
    const forbidden = ['Joe', 'owns', 'source', 'code'].join(' ');
    async function walk(dir, results = []) {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules') continue;
          if (entry.name.startsWith('.')) continue;
          await walk(full, results);
        } else if (entry.isFile() && /\.(js|json|md)$/.test(entry.name)) {
          results.push(full);
        }
      }
      return results;
    }
    const repoRoot = path.resolve(__dirname, '..');
    const srcFiles = await walk(path.join(repoRoot, 'src'));
    const hits = [];
    for (const f of srcFiles) {
      const content = await fs.promises.readFile(f, 'utf-8');
      if (content.includes(forbidden)) hits.push(f);
    }
    expect(hits).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// T2.4–T2.7 — skill-coherence.js: constraints/conflicts/hook paths are opt-in
// ---------------------------------------------------------------------------

describe('W2/T2.4–T2.7: skill-coherence detectors are opt-in', () => {
  it('T2.4: default config + git/ship/push skill + no conflicts ⇒ NOT_APPLICABLE_SCORE', async () => {
    const tmpDir = makeTmpDir();
    try {
      // Skill that handles git push without mentioning anything
      writeSkill(tmpDir, 'deploy', [
        '---',
        'name: deploy',
        'description: Deploy service',
        '---',
        '# Deploy',
        'Build and git push to origin.',
        'Create PR and merge.',
      ].join('\n'));
      // Skill-coherence runs — but default config has no constraints and no
      // hook-feature configured, and there are no allow/deny overlaps to
      // report, so the check should be N/A.
      const priorResults = [claudeMdResult([], 'Some governance text without keywords.')];
      const result = await skillCoherenceCheck.run({
        cwd: tmpDir,
        homedir: tmpDir,
        config: {},
        priorResults,
      });
      expect(result.score).toBe(NOT_APPLICABLE_SCORE);
      expect(result.findings).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('T2.5: configured constraints produce findings as before', async () => {
    const tmpDir = makeTmpDir();
    try {
      writeFile(path.join(tmpDir, 'CLAUDE.md'), 'No direct merge. Use custom-merge-wrapper.\n');
      writeSkill(tmpDir, 'deploy', [
        '---',
        'name: deploy',
        'description: Deploy service',
        '---',
        '# Deploy',
        'git push to origin.',
        'Create PR and merge.',
      ].join('\n'));
      const config = {
        skillCoherence: {
          constraints: [
            {
              id: 'custom-merge-workflow',
              governancePattern: /\b(custom-merge-wrapper|no direct merge)\b/i,
              awarenessPatterns: [/custom-merge-wrapper/i, /hand.?off.*merge/i],
              appliesTo: /\b(push|ship|deploy|git push)\b/i,
              finding: {
                severity: 'warning',
                title: 'Skill unaware of custom merge workflow',
                detail: 'Governance requires merges via custom-merge-wrapper.',
                remediation: 'Add merge workflow awareness.',
              },
            },
          ],
        },
      };
      const result = await skillCoherenceCheck.run({
        cwd: tmpDir,
        homedir: tmpDir,
        config,
        priorResults: [claudeMdResult([], 'No direct merge. Use custom-merge-wrapper.')],
      });
      const warnings = result.findings.filter(f =>
        f.severity === 'warning' && /merge/i.test(f.title || ''),
      );
      expect(warnings.length).toBeGreaterThanOrEqual(1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('T2.6: with no config.paths.hookFiles, hook content is not read', async () => {
    const tmpDir = makeTmpDir();
    // Drop a fake hook file at a path the OLD code would have read.
    // If the default config now reads it, this test would prove the
    // leak — the hook content contains a sentinel we look for in findings.
    const homedir = path.join(tmpDir, 'home');
    const oldHookPath = path.join(homedir, '.openclaw', 'hooks', 'sandbox-gate.py');
    fs.mkdirSync(path.dirname(oldHookPath), { recursive: true });
    fs.writeFileSync(oldHookPath, '# sops-get is always blocked in this fake hook\n');

    // Settings with a matching sops-get allow entry — old behavior would
    // fire a "Hook blocks sops-get but settings allows it" warning.
    fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.claude', 'settings.json'), JSON.stringify({
      permissions: {
        allow: ['Bash(sops-get OPENCLAW_TOKEN:*)'],
      },
    }));
    writeSkill(tmpDir, 'anything', '---\nname: anything\ndescription: x\n---\n');
    try {
      const result = await skillCoherenceCheck.run({
        cwd: tmpDir,
        homedir,
        config: {}, // no hookFiles configured
        priorResults: [claudeMdResult([], '')],
      });
      const hookConflict = result.findings.find(f =>
        /hook blocks sops-get/i.test(f.title || ''),
      );
      expect(hookConflict).toBeUndefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('T2.7: CONFLICT_PATTERNS are gated behind config.skillCoherence.hookSettingsConflicts', async () => {
    const tmpDir = makeTmpDir();
    const homedir = path.join(tmpDir, 'home');
    const hookPath = path.join(homedir, '.claude', 'hooks', 'sandbox-gate.py');
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    fs.writeFileSync(hookPath, '# gh-merge-approved is always blocked\n');
    fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.claude', 'settings.json'), JSON.stringify({
      permissions: { allow: ['Bash(gh-merge-approved:*)'] },
    }));
    writeSkill(tmpDir, 'anything', '---\nname: anything\ndescription: x\n---\n');

    try {
      // Even with hookFiles configured, no conflict patterns means no finding
      const resultNoPatterns = await skillCoherenceCheck.run({
        cwd: tmpDir,
        homedir,
        config: {
          paths: { hookFiles: [hookPath] },
          skillCoherence: { hookSettingsConflicts: [] },
        },
        priorResults: [claudeMdResult([], '')],
      });
      const conflictA = resultNoPatterns.findings.find(f =>
        /hook blocks gh-merge-approved/i.test(f.title || ''),
      );
      expect(conflictA).toBeUndefined();

      // Opt in to the pattern: finding fires
      const resultWithPatterns = await skillCoherenceCheck.run({
        cwd: tmpDir,
        homedir,
        config: {
          paths: { hookFiles: [hookPath] },
          skillCoherence: {
            hookSettingsConflicts: [{
              hookPattern: /gh-merge-approved/,
              settingsPattern: /gh-merge-approved/i,
              title: 'Hook blocks gh-merge-approved but settings allows it',
              detail: 'dead allow entry',
              remediation: 'remove it',
            }],
          },
        },
        priorResults: [claudeMdResult([], '')],
      });
      const conflictB = resultWithPatterns.findings.find(f =>
        /hook blocks gh-merge-approved/i.test(f.title || ''),
      );
      expect(conflictB).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// T2.8–T2.10 — infrastructure-security.js: all opt-in
// ---------------------------------------------------------------------------

describe('W2/T2.8–T2.10: infrastructure-security is opt-in', () => {
  it('T2.8: with no config.paths.hooksDir (or others), check returns NOT_APPLICABLE_SCORE with a skipped finding', async () => {
    if (process.platform !== 'linux') return;
    const result = await infrastructureCheck.run({
      cwd: '/tmp',
      homedir: '/tmp/no-home',
      config: {}, // no paths configured
    });
    expect(result.score).toBe(NOT_APPLICABLE_SCORE);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe('skipped');
    expect(result.findings[0].title).toMatch(/opt-in/i);
    // Critical "hooks dir missing" must NOT appear in default runs
    const criticals = result.findings.filter(f => f.severity === 'critical');
    expect(criticals).toHaveLength(0);
  });

  it('T2.9: with config.paths.hooksDir configured, the check runs (hook validation, deny list, sandbox gate all evaluated)', async () => {
    if (process.platform !== 'linux') return;
    const tmpDir = makeTmpDir();
    try {
      const result = await infrastructureCheck.run({
        cwd: tmpDir,
        homedir: tmpDir,
        config: {
          paths: {
            hooksDir: '/tmp/nonexistent-hooks-check',
            gitWrapper: '/tmp/nonexistent-git-wrapper',
            safetyGates: '/tmp/nonexistent-safety-gates',
            immutableDirs: [],
          },
        },
      });
      // Opt-in path, so check ran — expect critical for missing hooks dir
      const hooksDirMissing = result.findings.find(f =>
        f.severity === 'critical' && /hooks directory missing/i.test(f.title || ''),
      );
      expect(hooksDirMissing).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('T2.10: auto-detection of _governance/ and _foundation/ is NOT performed without explicit immutableDirs', async () => {
    if (process.platform !== 'linux') return;
    const tmpDir = makeTmpDir();
    fs.mkdirSync(path.join(tmpDir, '_governance'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '_foundation'), { recursive: true });
    try {
      const result = await infrastructureCheck.run({
        cwd: tmpDir,
        homedir: tmpDir,
        config: {}, // no immutableDirs and no infra paths
      });
      // Whole check is opt-in — no auto-walk happens, no immutable-flag
      // warnings emitted. Filter for warning severity specifically so the
      // opt-in "skipped" message doesn't accidentally match.
      const immutableWarnings = result.findings.filter(f =>
        f.severity !== 'skipped' && /immutable flag/i.test(f.title || ''),
      );
      expect(immutableWarnings).toHaveLength(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('T2.10b: immutable dirs ARE checked when explicitly listed', async () => {
    if (process.platform !== 'linux') return;
    const tmpDir = makeTmpDir();
    const targetDir = path.join(tmpDir, 'guarded');
    fs.mkdirSync(targetDir, { recursive: true });
    try {
      const result = await infrastructureCheck.run({
        cwd: tmpDir,
        homedir: tmpDir,
        config: { paths: { immutableDirs: [targetDir] } },
      });
      // Non-immutable → either warning "Immutable flag not set" or info
      // "Cannot check immutability" depending on lsattr availability.
      const relevant = result.findings.filter(f =>
        /immutab/i.test(f.title || '') && f.severity !== 'skipped' && f.severity !== 'pass',
      );
      expect(relevant.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// T2.12 — workflow-maturity.js: STAGE_DIR_NAMES no longer includes drive_phases
// ---------------------------------------------------------------------------

describe('W2/T2.12: workflow-maturity stageDirs default is generic', () => {
  it('drive_phases/ is NOT scanned by default', async () => {
    const tmpDir = makeTmpDir();
    const home = makeTmpDir();
    try {
      const drivePhasesDir = path.join(tmpDir, 'src', 'drive_phases');
      fs.mkdirSync(drivePhasesDir, { recursive: true });
      for (let i = 0; i < 11; i++) {
        fs.writeFileSync(path.join(drivePhasesDir, `phase${i}.py`), 'pass\n');
      }
      // A tiny pipeline file so hasAnything=true
      writeFile(path.join(tmpDir, 'src', 'pipeline_tiny.py'), '# nothing\n');

      const result = await workflowMaturityCheck.run({
        cwd: tmpDir,
        homedir: home,
        config: {}, // default — drive_phases NOT in default stageDirs
      });
      const hit = result.findings.find(f =>
        /drive_phases/.test(f.title || ''),
      );
      expect(hit).toBeUndefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('drive_phases/ IS scanned when explicitly configured via config.workflowMaturity.stageDirs', async () => {
    const tmpDir = makeTmpDir();
    const home = makeTmpDir();
    try {
      const drivePhasesDir = path.join(tmpDir, 'src', 'drive_phases');
      fs.mkdirSync(drivePhasesDir, { recursive: true });
      for (let i = 0; i < 11; i++) {
        fs.writeFileSync(path.join(drivePhasesDir, `phase${i}.py`), 'pass\n');
      }
      writeFile(path.join(tmpDir, 'src', 'pipeline_tiny.py'), '# nothing\n');

      const result = await workflowMaturityCheck.run({
        cwd: tmpDir,
        homedir: home,
        config: {
          workflowMaturity: { stageDirs: ['stages', 'phases', 'drive_phases'] },
        },
      });
      const hit = result.findings.find(f =>
        /drive_phases/.test(f.title || ''),
      );
      expect(hit).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('generic stages/ still flagged by default', async () => {
    const tmpDir = makeTmpDir();
    const home = makeTmpDir();
    try {
      const stagesDir = path.join(tmpDir, 'src', 'stages');
      fs.mkdirSync(stagesDir, { recursive: true });
      for (let i = 0; i < 11; i++) {
        fs.writeFileSync(path.join(stagesDir, `stage${i}.py`), 'pass\n');
      }
      writeFile(path.join(tmpDir, 'src', 'pipeline_tiny.py'), '# nothing\n');

      const result = await workflowMaturityCheck.run({
        cwd: tmpDir,
        homedir: home,
        config: {},
      });
      const hit = result.findings.find(f =>
        /stages\//.test(f.title || ''),
      );
      expect(hit).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// T2.14 — example config file is committed and loadable
// ---------------------------------------------------------------------------

describe('W2/T2.14: docs/rigscorerc.brc-example.json is a valid template', () => {
  it('file exists and parses as JSON', async () => {
    const p = path.resolve(__dirname, '..', 'docs', 'rigscorerc.brc-example.json');
    const content = await fs.promises.readFile(p, 'utf-8');
    const parsed = JSON.parse(content);
    expect(parsed).toBeTypeOf('object');
    // Restores the author's opted-in behavior: constraints, hookFiles,
    // allowGovernanceContradictions must all be populated.
    expect(parsed.skillCoherence?.constraints?.length || 0).toBeGreaterThan(0);
    expect(parsed.paths?.hookFiles?.length || 0).toBeGreaterThan(0);
    expect(parsed.coherence?.allowGovernanceContradictions?.length || 0).toBeGreaterThan(0);
  });

  it('loadConfig merges the example file without error', async () => {
    const p = path.resolve(__dirname, '..', 'docs', 'rigscorerc.brc-example.json');
    const content = await fs.promises.readFile(p, 'utf-8');
    const tmpDir = makeTmpDir();
    try {
      // Write the example as this project's .rigscorerc.json
      fs.writeFileSync(path.join(tmpDir, '.rigscorerc.json'), content);
      const config = await loadConfig(tmpDir, tmpDir);
      // Constraints propagate
      expect(Array.isArray(config.skillCoherence.constraints)).toBe(true);
      expect(config.skillCoherence.constraints.length).toBeGreaterThan(0);
      // Stage dirs propagate (and include drive_phases per the example)
      expect(config.workflowMaturity.stageDirs).toContain('drive_phases');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// T2.15 — regression: a default-install scan of an empty project emits no
// joe-attributable findings. (This is partially covered by T2.1/T2.4/T2.8/T2.12
// already, but we add a synthetic end-to-end check.)
// ---------------------------------------------------------------------------

describe('W2/T2.15: clean-install produces no author-specific findings', () => {
  it('infrastructure-security returns N/A with no config', async () => {
    if (process.platform !== 'linux') return;
    const tmpDir = makeTmpDir();
    try {
      const result = await infrastructureCheck.run({
        cwd: tmpDir,
        homedir: tmpDir,
        config: {},
      });
      expect(result.score).toBe(NOT_APPLICABLE_SCORE);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('skill-coherence returns N/A on empty project', async () => {
    const tmpDir = makeTmpDir();
    try {
      const result = await skillCoherenceCheck.run({
        cwd: tmpDir,
        homedir: tmpDir,
        config: {},
        priorResults: [claudeMdResult([], '')],
      });
      expect(result.score).toBe(NOT_APPLICABLE_SCORE);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('coherence emits no author-specific pairing warnings on clean project', async () => {
    // Use a governance claiming forbidden-actions + allow-list with sudo-u-dev-git
    // (the author's private pairing). Under default config, no warning fires.
    const priorResults = [
      claudeMdResult(['forbidden actions'], 'Never sudo -u dev git.'),
      settingsResult({ allowListEntries: ['Bash(sudo -u dev git:*)'] }),
    ];
    const result = await coherenceCheck.run({ priorResults, config: {} });
    const pairingWarning = result.findings.find(f =>
      f.severity === 'warning' &&
      /sudo/i.test(f.title || '') &&
      /governance/i.test(f.title || ''),
    );
    expect(pairingWarning).toBeUndefined();
  });
});

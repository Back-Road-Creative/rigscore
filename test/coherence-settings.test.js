import { describe, it, expect } from 'vitest';
import check from '../src/checks/coherence.js';
import { NOT_APPLICABLE_SCORE } from '../src/constants.js';

// Helpers to build priorResults arrays for coherence check
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
      missingLifecycleHooks: data.missingLifecycleHooks ?? ['PreToolUse', 'PostToolUse', 'Stop', 'UserPromptSubmit'],
      hasBypassPermissions: data.hasBypassPermissions ?? false,
      defaultMode: data.defaultMode ?? null,
      allowListEntries: data.allowListEntries ?? [],
      ...data,
    },
  };
}

const defaultConfig = { paths: {}, network: {} };

// Config that enables the author's opted-in pairings (used by tests that
// exercise the configurable coherence pairings).
const joePairingsConfig = {
  paths: {},
  network: {},
  coherence: {
    allowGovernanceContradictions: [
      {
        allowRe: /sudo\s+-u\s+dev\s+git/i,
        govRe: /\b(never|must not|do not)\b.{0,30}sudo.{0,20}-u.{0,20}dev/i,
        title: 'Allow list permits sudo-u-dev-git which governance forbids',
        detail: 'settings.json allow list contains a sudo -u dev git entry, but governance explicitly forbids this operation.',
        remediation: 'Remove the sudo -u dev git allow-list entry and use git as the human owner directly.',
      },
      {
        allowRe: /pip[23]?\s+install/i,
        govRe: /\b(dev-pip|pip.*wrapper|use.*wrapper.*pip|no pip install|must not.*pip)\b/i,
        title: 'Allow list permits pip install which governance restricts to a wrapper',
        detail: 'settings.json allow list contains pip install, but governance restricts installs to a project-specific wrapper.',
        remediation: 'Remove the pip install allow-list entry and use the configured wrapper instead.',
      },
    ],
  },
};

describe('coherence: settings vs. governance', () => {
  // --- bypassPermissions + approval gates + no PreToolUse ---

  it('WARNING: bypassPermissions + approval-gates governance + no PreToolUse hook', async () => {
    const govText = 'Human approval required before deploying. Require approval for sensitive ops.';
    const priorResults = [
      claudeMdResult(['approval gates'], govText),
      settingsResult({
        hasBypassPermissions: true,
        configuredHooks: ['Stop'],
        missingLifecycleHooks: ['PreToolUse', 'PostToolUse', 'UserPromptSubmit'],
      }),
    ];
    const result = await check.run({ priorResults, config: defaultConfig });
    const warning = result.findings.find(f =>
      f.severity === 'warning' && f.title.toLowerCase().includes('approval gates') && f.title.toLowerCase().includes('pretooluse'),
    );
    expect(warning).toBeDefined();
  });

  it('no WARNING when PreToolUse IS configured (approval gate enforceable)', async () => {
    const govText = 'Human approval required before deploying. Require approval for sensitive ops.';
    const priorResults = [
      claudeMdResult(['approval gates'], govText),
      settingsResult({
        hasBypassPermissions: true,
        configuredHooks: ['PreToolUse', 'Stop'],
        missingLifecycleHooks: ['PostToolUse', 'UserPromptSubmit'],
      }),
    ];
    const result = await check.run({ priorResults, config: defaultConfig });
    const warning = result.findings.find(f =>
      f.severity === 'warning' && f.title.toLowerCase().includes('approval gates') && f.title.toLowerCase().includes('pretooluse'),
    );
    expect(warning).toBeUndefined();
  });

  it('no WARNING when bypassPermissions is false (normal mode)', async () => {
    const govText = 'Human approval required before deploying.';
    const priorResults = [
      claudeMdResult(['approval gates'], govText),
      settingsResult({
        hasBypassPermissions: false,
        configuredHooks: [],
        missingLifecycleHooks: ['PreToolUse', 'PostToolUse', 'Stop', 'UserPromptSubmit'],
      }),
    ];
    const result = await check.run({ priorResults, config: defaultConfig });
    const warning = result.findings.find(f =>
      f.title?.toLowerCase().includes('approval gates') && f.title?.toLowerCase().includes('pretooluse'),
    );
    expect(warning).toBeUndefined();
  });

  // --- allow-list vs. governance contradiction ---

  it('WARNING: allow list permits sudo-u-dev-git which governance forbids (with opt-in pairings)', async () => {
    const govText = 'Never use sudo -u dev git for operations. Must not run sudo -u dev git add or commit.';
    const priorResults = [
      claudeMdResult(['forbidden actions'], govText),
      settingsResult({
        allowListEntries: ['Bash(sudo -u dev git:*)', 'Bash(git status:*)'],
      }),
    ];
    const result = await check.run({ priorResults, config: joePairingsConfig });
    const warning = result.findings.find(f =>
      f.severity === 'warning' && f.title.toLowerCase().includes('sudo') && f.title.toLowerCase().includes('governance'),
    );
    expect(warning).toBeDefined();
  });

  it('no WARNING when sudo-u-dev-git not in allow list (pairings enabled, no match)', async () => {
    const govText = 'Never use sudo -u dev git for operations.';
    const priorResults = [
      claudeMdResult(['forbidden actions'], govText),
      settingsResult({
        allowListEntries: ['Bash(git status:*)', 'Bash(npm test:*)'],
      }),
    ];
    const result = await check.run({ priorResults, config: joePairingsConfig });
    const warning = result.findings.find(f =>
      f.title?.toLowerCase().includes('sudo') && f.title?.toLowerCase().includes('governance'),
    );
    expect(warning).toBeUndefined();
  });

  it('WARNING: allow list permits pip install which governance restricts to wrapper (with opt-in pairings)', async () => {
    const govText = 'Use the dev-pip wrapper for all package installs. No pip install directly.';
    const priorResults = [
      claudeMdResult(['forbidden actions'], govText),
      settingsResult({
        allowListEntries: ['Bash(pip install:*)', 'Bash(git status:*)'],
      }),
    ];
    const result = await check.run({ priorResults, config: joePairingsConfig });
    const warning = result.findings.find(f =>
      f.severity === 'warning' && f.title.toLowerCase().includes('pip') && f.title.toLowerCase().includes('governance'),
    );
    expect(warning).toBeDefined();
  });

  it('no WARNING for pip when governance does not mention pip restrictions (pairings enabled, no match)', async () => {
    const govText = 'Never delete production data. Require approval for deploys.';
    const priorResults = [
      claudeMdResult(['forbidden actions'], govText),
      settingsResult({
        allowListEntries: ['Bash(pip install:*)'],
      }),
    ];
    const result = await check.run({ priorResults, config: joePairingsConfig });
    const warning = result.findings.find(f =>
      f.title?.toLowerCase().includes('pip') && f.title?.toLowerCase().includes('governance'),
    );
    expect(warning).toBeUndefined();
  });

  it('N/A when no settings result in priorResults', async () => {
    const priorResults = [
      claudeMdResult(['approval gates'], 'Require approval.'),
      // no settings result
    ];
    const result = await check.run({ priorResults, config: defaultConfig });
    // Should not throw, should not emit settings-specific warnings
    const settingsWarning = result.findings.find(f =>
      f.title?.toLowerCase().includes('pretooluse') || f.title?.toLowerCase().includes('sudo'),
    );
    expect(settingsWarning).toBeUndefined();
  });
});

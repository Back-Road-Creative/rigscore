/**
 * RS-10 — HOME decoupling. The scanner's $HOME must not change a PROJECT's
 * findings/score unless the operator passes --include-home-skills. These tests
 * lock the shared gate (src/lib/home-scope.js) and every home-reading check
 * routed through it. Also covers claude-settings' hook-file-cap-reached naming
 * the root that actually hit the cap.
 */
import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { homeScopeEnabled, homeAwareRoots } from '../src/lib/home-scope.js';
import governanceDocs from '../src/checks/governance-docs.js';
import credentialStorage from '../src/checks/credential-storage.js';
import claudeSettings from '../src/checks/claude-settings.js';
import agentSchemas from '../src/checks/agent-output-schemas.js';
import gitHooks from '../src/checks/git-hooks.js';
import skillCoherence from '../src/checks/skill-coherence.js';
import workflowMaturity from '../src/checks/workflow-maturity.js';
import { CLIENTS } from '../src/clients.js';
import { NOT_APPLICABLE_SCORE } from '../src/constants.js';

const tmpdirs = [];
function tmp(prefix = 'rigscore-hs-') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpdirs.push(d);
  return d;
}
function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
afterEach(() => {
  while (tmpdirs.length) {
    const d = tmpdirs.pop();
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

const fakeStripeKey = ['sk', 'live', 'abcdefghijklmnopqrstuvwx'].join('_');
const cfg = { paths: {}, network: {}, limits: {} };

describe('home-scope gate (helper)', () => {
  it('is off by default (no flag)', () => {
    expect(homeScopeEnabled({ cwd: '/a', homedir: '/h' })).toBe(false);
  });
  it('is on only when the flag is set AND home ≠ cwd', () => {
    expect(homeScopeEnabled({ cwd: '/a', homedir: '/h', includeHomeSkills: true })).toBe(true);
    expect(homeScopeEnabled({ cwd: '/a', homedir: '/a', includeHomeSkills: true })).toBe(false);
    expect(homeScopeEnabled({ cwd: '/a', includeHomeSkills: true })).toBe(false);
  });
  it('homeAwareRoots yields cwd always, home only when enabled', () => {
    expect(homeAwareRoots({ cwd: '/a', homedir: '/h' })).toEqual([{ root: '/a', home: false }]);
    expect(homeAwareRoots({ cwd: '/a', homedir: '/h', includeHomeSkills: true }))
      .toEqual([{ root: '/a', home: false }, { root: '/h', home: true }]);
  });
});

describe('governance-docs: home CLAUDE.md is gated', () => {
  function setup() {
    const cwd = tmp();
    const home = tmp();
    write(path.join(cwd, '.cursorrules'), 'PROJECT_GOVERNANCE_MARKER\nNever run sudo.\n');
    write(path.join(home, '.claude', 'CLAUDE.md'), 'HOME_GOVERNANCE_MARKER\nApproval gates required.\n');
    return { cwd, home };
  }
  it('does NOT read ~/.claude/CLAUDE.md without the flag', async () => {
    const { cwd, home } = setup();
    const r = await governanceDocs.run({ cwd, homedir: home, config: cfg });
    expect(r.data.governanceText).toContain('PROJECT_GOVERNANCE_MARKER');
    expect(r.data.governanceText).not.toContain('HOME_GOVERNANCE_MARKER');
  });
  it('reads ~/.claude/CLAUDE.md under --include-home-skills', async () => {
    const { cwd, home } = setup();
    const r = await governanceDocs.run({ cwd, homedir: home, config: cfg, includeHomeSkills: true });
    expect(r.data.governanceText).toContain('PROJECT_GOVERNANCE_MARKER');
    expect(r.data.governanceText).toContain('HOME_GOVERNANCE_MARKER');
  });
});

// The registry (src/clients.js) is the single source of truth for where a client
// keeps its credential-bearing config. Hardcoding the path here made this fixture
// go stale the moment the registry was corrected, so derive it instead.
function credentialRelPath(clientId) {
  const client = CLIENTS.find(c => c.id === clientId);
  const cred = (client?.credentials || [])[0];
  if (!cred) throw new Error(`no credential path registered for client "${clientId}"`);
  return path.join(cred.dir, cred.file);
}

describe('credential-storage: home client configs are gated', () => {
  function setup() {
    const home = tmp();
    write(path.join(home, credentialRelPath('claude-desktop')), JSON.stringify({
      mcpServers: { s: { command: 'node', env: { STRIPE_KEY: fakeStripeKey } } },
    }));
    return home;
  }
  it('returns N/A without the flag (all surfaces are $HOME)', async () => {
    const home = setup();
    const r = await credentialStorage.run({ cwd: tmp(), homedir: home });
    expect(r.score).toBe(NOT_APPLICABLE_SCORE);
    expect(r.data.filesScanned).toBe(0);
  });
  it('scans home configs under --include-home-skills', async () => {
    const home = setup();
    const r = await credentialStorage.run({ cwd: tmp(), homedir: home, includeHomeSkills: true });
    expect(r.data.secretsFound).toBeGreaterThanOrEqual(1);
    expect(r.findings.some(f => f.severity === 'critical')).toBe(true);
  });
});

describe('claude-settings: home settings are gated', () => {
  function setup() {
    const home = tmp();
    write(path.join(home, '.claude', 'settings.json'), JSON.stringify({
      permissions: { defaultMode: 'bypassPermissions' },
    }));
    return home;
  }
  it('does NOT read ~/.claude/settings.json without the flag', async () => {
    const home = setup();
    const r = await claudeSettings.run({ cwd: tmp(), homedir: home });
    expect(r.score).toBe(NOT_APPLICABLE_SCORE);
  });
  it('reads home settings under --include-home-skills', async () => {
    const home = setup();
    const r = await claudeSettings.run({ cwd: tmp(), homedir: home, includeHomeSkills: true });
    expect(r.findings.some(f => f.findingId === 'claude-settings/bypass-permissions-mode')).toBe(true);
  });
});

describe('agent-output-schemas: home agents dir is gated', () => {
  function setup() {
    const home = tmp();
    write(path.join(home, '.claude', 'agents', 'user-agent.md'),
      'Return ONLY a JSON object with no fence.\n');
    return home;
  }
  it('does NOT scan ~/.claude/agents without the flag', async () => {
    const home = setup();
    const r = await agentSchemas.run({ cwd: tmp(), homedir: home });
    expect(r.score).toBe(NOT_APPLICABLE_SCORE);
  });
  it('scans home agents under --include-home-skills', async () => {
    const home = setup();
    const r = await agentSchemas.run({ cwd: tmp(), homedir: home, includeHomeSkills: true });
    expect(r.data.agentsScanned).toBe(1);
    expect(r.findings.some(f => f.findingId === 'agent-output-schemas/missing-schema-block')).toBe(true);
  });
});

describe('git-hooks: home Claude settings hooks are gated', () => {
  function setup() {
    const cwd = tmp();
    const home = tmp();
    fs.mkdirSync(path.join(cwd, '.git', 'hooks'), { recursive: true });
    write(path.join(home, '.claude', 'settings.json'), JSON.stringify({
      hooks: { PreToolUse: [{ command: 'echo hi' }] },
    }));
    return { cwd, home };
  }
  it('a hookless project is not rescued by the operator home hooks', async () => {
    const { cwd, home } = setup();
    const r = await gitHooks.run({ cwd, homedir: home, config: cfg });
    expect(r.findings.some(f => f.findingId === 'git-hooks/no-hooks-installed')).toBe(true);
    expect(r.findings.some(f => f.title?.includes('Claude Code hooks'))).toBe(false);
  });
  it('counts home hooks under --include-home-skills', async () => {
    const { cwd, home } = setup();
    const r = await gitHooks.run({ cwd, homedir: home, config: cfg, includeHomeSkills: true });
    expect(r.findings.some(f => f.title?.includes('Claude Code hooks'))).toBe(true);
  });
});

describe('skill-coherence: home settings/skills are gated', () => {
  // The operator's OWN ~/.claude/settings.json allow/deny conflict must not
  // surface as a finding on every project scan.
  function setup() {
    const home = tmp();
    write(path.join(home, '.claude', 'settings.json'), JSON.stringify({
      permissions: { allow: ['Bash(git commit:*)'], deny: ['Bash(git:*)'] },
    }));
    return home;
  }
  it('does NOT read home settings without the flag', async () => {
    const home = setup();
    const r = await skillCoherence.run({ cwd: tmp(), homedir: home, priorResults: [] });
    expect(r.score).toBe(NOT_APPLICABLE_SCORE);
    expect(r.findings.some(f => f.findingId === 'skill-coherence/settings-allow-deny-conflict')).toBe(false);
  });
  it('reads home settings under --include-home-skills', async () => {
    const home = setup();
    const r = await skillCoherence.run({ cwd: tmp(), homedir: home, priorResults: [], includeHomeSkills: true });
    expect(r.findings.some(f => f.findingId === 'skill-coherence/settings-allow-deny-conflict')).toBe(true);
  });
});

describe('workflow-maturity: home memory is gated', () => {
  function setup() {
    const home = tmp();
    const memDir = path.join(home, '.claude', 'projects', 'proj', 'memory');
    write(path.join(memDir, 'MEMORY.md'), '# Index\n');
    write(path.join(memDir, 'orphan.md'), '# Orphan\n');
    return home;
  }
  it('does NOT scan operator home memory without the flag', async () => {
    const home = setup();
    const r = await workflowMaturity.run({ cwd: tmp(), homedir: home, config: cfg });
    expect(r.score).toBe(NOT_APPLICABLE_SCORE);
    expect(r.findings.some(f => f.title?.includes('orphan.md'))).toBe(false);
  });
  it('scans home memory under --include-home-skills', async () => {
    const home = setup();
    const r = await workflowMaturity.run({ cwd: tmp(), homedir: home, config: cfg, includeHomeSkills: true });
    expect(r.findings.some(f => f.title?.includes('orphan.md') && f.title?.includes('not linked'))).toBe(true);
  });
});

describe('claude-settings hook-file-cap-reached names the root that hit the cap', () => {
  it('names home, not the small project, when the operator home overflows the cap', async () => {
    const cwd = tmp();
    const home = tmp();
    // A tiny project — nothing to "move" here.
    write(path.join(cwd, '.claude', 'skills', 'a', 'SKILL.md'), '# a\n');
    // Operator home skills tree blows past the 200-file walk cap.
    const homeSkills = path.join(home, '.claude', 'skills');
    fs.mkdirSync(homeSkills, { recursive: true });
    for (let i = 0; i < 210; i++) fs.writeFileSync(path.join(homeSkills, `s${i}.md`), '# s\n');

    const r = await claudeSettings.run({ cwd, homedir: home, includeHomeSkills: true });
    const cap = r.findings.find(f => f.findingId === 'claude-settings/hook-file-cap-reached');
    expect(cap).toBeDefined();
    // The remediation must point at the HOME tree, not a project with nothing to move.
    const text = `${cap.title} ${cap.detail}`.toLowerCase();
    expect(text).toContain('home');
    expect(cap.context?.roots).toContain('home (~)');
  });
  it('does not fire from the operator home cap when the flag is off', async () => {
    const cwd = tmp();
    const home = tmp();
    write(path.join(cwd, '.claude', 'skills', 'a', 'SKILL.md'), '# a\n');
    const homeSkills = path.join(home, '.claude', 'skills');
    fs.mkdirSync(homeSkills, { recursive: true });
    for (let i = 0; i < 210; i++) fs.writeFileSync(path.join(homeSkills, `s${i}.md`), '# s\n');

    const r = await claudeSettings.run({ cwd, homedir: home });
    expect(r.findings.some(f => f.findingId === 'claude-settings/hook-file-cap-reached')).toBe(false);
  });
});

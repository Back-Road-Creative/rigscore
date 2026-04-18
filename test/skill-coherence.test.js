import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import check from '../src/checks/skill-coherence.js';
import { WEIGHTS, NOT_APPLICABLE_SCORE } from '../src/constants.js';

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-sc-'));
}

function writeSkill(dir, name, content) {
  const skillDir = path.join(dir, '.claude', 'skills', name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content);
}

function writeGovernance(dir, content) {
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), content);
}

function writeGovSubdir(dir, filename, content) {
  const govDir = path.join(dir, '_governance');
  fs.mkdirSync(govDir, { recursive: true });
  fs.writeFileSync(path.join(govDir, filename), content);
}

function writeSettings(dir, data) {
  const settingsDir = path.join(dir, '.claude');
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(path.join(settingsDir, 'settings.json'), JSON.stringify(data, null, 2));
}

// Mock priorResults with claude-md data
function makePriorResults(governanceText) {
  return [
    {
      id: 'claude-md',
      score: 100,
      findings: [],
      data: { matchedPatterns: [], governanceText },
    },
  ];
}

describe('skill-coherence check', () => {
  it('has required shape', () => {
    expect(check.id).toBe('skill-coherence');
    expect(check.name).toBe('Skill ↔ governance coherence');
    expect(check.category).toBe('governance');
    expect(check.pass).toBe(2);
    expect(WEIGHTS[check.id]).toBe(0);
  });

  it('returns N/A when no skills and no governance', async () => {
    const tmpDir = makeTmpDir();
    try {
      const result = await check.run({
        cwd: tmpDir,
        homedir: tmpDir,
        priorResults: makePriorResults(''),
      });
      expect(result.score).toBe(NOT_APPLICABLE_SCORE);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('passes when skills are aware of governance constraints', async () => {
    const tmpDir = makeTmpDir();
    writeGovernance(tmpDir, 'No direct merge. Use gh-merge-approved.\n');
    writeSkill(tmpDir, 'ship', [
      '---',
      'name: ship',
      'description: Ship code',
      '---',
      '# Ship',
      'Push to remote, create PR.',
      'Merge is manual via gh-merge-approved — hand off to user.',
      'git push to origin.',
    ].join('\n'));
    try {
      const result = await check.run({
        cwd: tmpDir,
        homedir: tmpDir,
        priorResults: makePriorResults('No direct merge. Use gh-merge-approved.'),
      });
      const warnings = result.findings.filter(f => f.severity === 'warning');
      const mergeWarnings = warnings.filter(f => f.title?.includes('merge'));
      expect(mergeWarnings).toHaveLength(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('warns when skill handling git push is unaware of merge workflow', async () => {
    const tmpDir = makeTmpDir();
    writeGovernance(tmpDir, 'No direct merge. Use gh-merge-approved.\n');
    writeSkill(tmpDir, 'deploy', [
      '---',
      'name: deploy',
      'description: Deploy service',
      '---',
      '# Deploy',
      'Build the service.',
      'git push to origin.',
      'Create PR and merge.',
    ].join('\n'));
    try {
      const result = await check.run({
        cwd: tmpDir,
        homedir: tmpDir,
        priorResults: makePriorResults('No direct merge. Use gh-merge-approved.'),
      });
      const warnings = result.findings.filter(f =>
        f.severity === 'warning' && f.title?.includes('merge'),
      );
      expect(warnings.length).toBeGreaterThanOrEqual(1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('warns when skill handling writes is unaware of layer restrictions', async () => {
    const tmpDir = makeTmpDir();
    writeGovSubdir(tmpDir, 'RULES.md', 'Changes to _governance/ require session-local explicit consent.');
    writeSkill(tmpDir, 'fixer', [
      '---',
      'name: fixer',
      'description: Fix issues',
      '---',
      '# Fixer',
      'Edit and modify files to fix bugs.',
      'Create new files as needed.',
    ].join('\n'));
    try {
      const result = await check.run({
        cwd: tmpDir,
        homedir: tmpDir,
        priorResults: makePriorResults(''),
      });
      const layerWarnings = result.findings.filter(f =>
        f.severity === 'warning' && f.title?.includes('layer'),
      );
      expect(layerWarnings.length).toBeGreaterThanOrEqual(1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('detects settings allow/deny conflicts', async () => {
    const tmpDir = makeTmpDir();
    writeGovernance(tmpDir, '# Rules\n');
    writeSettings(tmpDir, {
      permissions: {
        allow: ['Bash(sops-get OPENCLAW_TOKEN:*)'],
        deny: ['Bash(sops-get:*)'],
      },
    });
    writeSkill(tmpDir, 'dummy', [
      '---',
      'name: dummy',
      'description: Dummy skill',
      '---',
      '# Dummy',
    ].join('\n'));
    try {
      const result = await check.run({
        cwd: tmpDir,
        homedir: tmpDir,
        priorResults: makePriorResults('# Rules'),
      });
      const conflicts = result.findings.filter(f =>
        f.title?.includes('allow/deny conflict'),
      );
      expect(conflicts.length).toBeGreaterThanOrEqual(1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('does not flag skills that do not perform relevant operations', async () => {
    const tmpDir = makeTmpDir();
    writeGovernance(tmpDir, 'No direct merge. Use gh-merge-approved.\n');
    writeSkill(tmpDir, 'analyzer', [
      '---',
      'name: analyzer',
      'description: Read-only analysis',
      '---',
      '# Analyzer',
      'Read files and produce a report.',
      'Glob and Grep for patterns.',
      'Never modify any files.',
    ].join('\n'));
    try {
      const result = await check.run({
        cwd: tmpDir,
        homedir: tmpDir,
        priorResults: makePriorResults('No direct merge. Use gh-merge-approved.'),
      });
      const mergeWarnings = result.findings.filter(f =>
        f.severity === 'warning' && f.title?.includes('merge'),
      );
      // Read-only skill should not be flagged for merge awareness
      expect(mergeWarnings).toHaveLength(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('populates data object', async () => {
    const tmpDir = makeTmpDir();
    writeGovernance(tmpDir, 'No direct merge. Use gh-merge-approved.\n');
    writeSkill(tmpDir, 'builder', [
      '---',
      'name: builder',
      'description: Build things',
      '---',
      '# Builder',
      'Scaffold and create files.',
    ].join('\n'));
    try {
      const result = await check.run({
        cwd: tmpDir,
        homedir: tmpDir,
        priorResults: makePriorResults('No direct merge. Use gh-merge-approved.'),
      });
      expect(result.data).toBeDefined();
      expect(result.data.skillsAnalyzed).toBe(1);
      expect(typeof result.data.constraintsCovered).toBe('number');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

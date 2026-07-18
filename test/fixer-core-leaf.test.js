import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findApplicableFixes, applyFixes } from '../src/fixer.js';
import { loadChecks } from '../src/checks/index.js';

// RS-26: widen fixer coverage with four mechanical fixers added in src/fixer.js
// (unicode-steganography strip, git-hooks executable-bit, claude-settings deny-list
// scaffold, credential-storage ${VAR} scaffold). None edit their check modules.

let tmpDir;
beforeAll(async () => { await loadChecks(); });
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-fixleaf-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

function fixIdsFor(findingId) {
  const results = [{ id: 'x', findings: [{ findingId, severity: 'warning', title: 't' }] }];
  return findApplicableFixes(results).map((f) => f.id);
}

describe('unicode-steganography strip fixer (RS-26)', () => {
  it('matches the hidden-unicode findings by findingId', () => {
    expect(fixIdsFor('unicode-steganography/zero-width')).toContain('unicode-steganography-strip');
    expect(fixIdsFor('unicode-steganography/bidi-override')).toContain('unicode-steganography-strip');
    expect(fixIdsFor('unicode-steganography/tag-chars')).toContain('unicode-steganography-strip');
  });

  it('strips zero-width / bidi chars from a governance file', async () => {
    const p = path.join(tmpDir, 'CLAUDE.md');
    fs.writeFileSync(p, '# Rules\nDo the​ thing and‮ reverse.\n');
    const { applied } = await applyFixes(
      [{ id: 'unicode-steganography-strip', description: 'strip' }], tmpDir, tmpDir);
    expect(applied.length).toBe(1);
    const out = fs.readFileSync(p, 'utf8');
    expect(out).not.toMatch(/[​‮]/);
    expect(out).toContain('Do the thing and reverse.');
  });
});

describe('git-hooks executable-bit fixer (RS-26)', () => {
  it('chmods +x a non-executable pre-commit hook', async () => {
    if (process.platform === 'win32') return;
    const hookDir = path.join(tmpDir, '.git', 'hooks');
    fs.mkdirSync(hookDir, { recursive: true });
    const hook = path.join(hookDir, 'pre-commit');
    fs.writeFileSync(hook, '#!/bin/sh\nnpm test\n');
    fs.chmodSync(hook, 0o644);
    expect(fixIdsFor('git-hooks/hook-not-executable')).toContain('git-hook-executable');
    const { applied } = await applyFixes(
      [{ id: 'git-hook-executable', description: 'chmod +x' }], tmpDir, tmpDir);
    expect(applied.length).toBe(1);
    expect(fs.statSync(hook).mode & 0o111).not.toBe(0);
  });
});

describe('claude-settings deny-list scaffold fixer (RS-26)', () => {
  const settingsPath = () => path.join(tmpDir, '.claude', 'settings.json');
  const writeSettings = (obj) => {
    fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(obj));
  };

  it('fills a deny list into an existing settings.json that declares none', async () => {
    expect(fixIdsFor('infrastructure-security/no-deny-list')).toContain('claude-settings-deny-scaffold');
    writeSettings({ mine: true });
    const { applied } = await applyFixes(
      [{ id: 'claude-settings-deny-scaffold', description: 'scaffold' }], tmpDir, tmpDir);
    expect(applied.length).toBe(1);
    const settings = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    expect(Array.isArray(settings.permissions.deny)).toBe(true);
    expect(settings.permissions.deny.length).toBeGreaterThan(0);
    // unrelated operator keys survive
    expect(settings.mine).toBe(true);
  });

  // `--fix` remediates existing files; installing a governance baseline is the
  // separate `--install-packs` consent (test/fixer-pack-gate.test.js).
  it('creates no settings.json when the repo has none', async () => {
    const { applied, skipped } = await applyFixes(
      [{ id: 'claude-settings-deny-scaffold', description: 'scaffold' }], tmpDir, tmpDir);
    expect(applied.length).toBe(0);
    expect(skipped.length).toBe(1);
    expect(fs.existsSync(settingsPath())).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.claude'))).toBe(false);
  });

  it('never clobbers an existing deny list', async () => {
    writeSettings({ permissions: { deny: ['Bash(mine*)'] } });
    const { applied, skipped } = await applyFixes(
      [{ id: 'claude-settings-deny-scaffold', description: 'scaffold' }], tmpDir, tmpDir);
    expect(applied.length).toBe(0);
    expect(skipped.length).toBe(1);
    expect(JSON.parse(fs.readFileSync(settingsPath(), 'utf8')).permissions.deny).toEqual(['Bash(mine*)']);
  });
});

describe('credential-storage ${VAR} scaffold fixer (RS-26)', () => {
  const credResults = () => ([{
      id: 'credential-storage',
      findings: [{
        findingId: 'credential-storage/plaintext-credential-in-client-config',
        severity: 'critical',
        title: 'Plaintext credential in Gemini CLI config (weather)',
        detail: 'env.API_KEY contains a plaintext secret. Credentials in config files are stored world-readable.',
      }],
    }]);
  const credFixes = () =>
    findApplicableFixes(credResults()).filter((f) => f.id === 'credential-storage-env-var-scaffold');
  const envExample = () => path.join(tmpDir, '.env.example');

  it('appends a ${VAR} placeholder to an existing .env.example', async () => {
    expect(credFixes().length).toBe(1);
    fs.writeFileSync(envExample(), 'EXISTING=\n');
    const { applied } = await applyFixes(credFixes(), tmpDir, tmpDir);
    expect(applied.length).toBe(1);
    const out = fs.readFileSync(envExample(), 'utf8');
    expect(out).toMatch(/^API_KEY=$/m);
    expect(out).toMatch(/^EXISTING=$/m);
  });

  // `--fix` never creates a file the repo did not have (fixer-pack-gate contract).
  it('creates no .env.example when the repo has none', async () => {
    const { applied, skipped } = await applyFixes(credFixes(), tmpDir, tmpDir);
    expect(applied.length).toBe(0);
    expect(skipped.length).toBe(1);
    expect(fs.existsSync(envExample())).toBe(false);
  });
});

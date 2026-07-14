import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixes } from '../src/checks/mcp-config.js';
import { findApplicableFixes, applyFixes } from '../src/fixer.js';
import { loadChecks } from '../src/checks/index.js';

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-mcp-fix-'));
}

function writeSettings(dir, obj) {
  const settingsDir = path.join(dir, '.claude');
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(path.join(settingsDir, 'settings.json'), JSON.stringify(obj, null, 2) + '\n');
}

function readSettingsRaw(dir) {
  return fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf-8');
}

const autoApproveFix = () => fixes.find((f) => f.id === 'mcp-auto-approve-disable');

describe('mcp-config fixes: disable MCP auto-approve bypass', () => {
  it('exports a fixer for both auto-approve findingIds', () => {
    const fix = autoApproveFix();
    expect(fix).toBeDefined();
    expect(fix.findingIds).toContain('mcp-config/mcp-auto-approve-enabled');
    expect(fix.findingIds).toContain('mcp-config/cve-2025-59536-auto-approve-on-clone');
    expect(typeof fix.apply).toBe('function');
  });

  it('flips enableAllProjectMcpServers true -> false and returns true', async () => {
    const dir = makeTmpDir();
    try {
      writeSettings(dir, { enableAllProjectMcpServers: true });
      const changed = await autoApproveFix().apply(dir);
      expect(changed).toBe(true);
      const parsed = JSON.parse(readSettingsRaw(dir));
      expect(parsed.enableAllProjectMcpServers).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('writes 2-space indent with a trailing newline', async () => {
    const dir = makeTmpDir();
    try {
      writeSettings(dir, { enableAllProjectMcpServers: true });
      await autoApproveFix().apply(dir);
      const raw = readSettingsRaw(dir);
      expect(raw.endsWith('\n')).toBe(true);
      expect(raw).toContain('  "enableAllProjectMcpServers": false');
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('is idempotent: a second run is a no-op returning false', async () => {
    const dir = makeTmpDir();
    try {
      writeSettings(dir, { enableAllProjectMcpServers: true });
      expect(await autoApproveFix().apply(dir)).toBe(true);
      const afterFirst = readSettingsRaw(dir);
      expect(await autoApproveFix().apply(dir)).toBe(false);
      // Second run must not rewrite (byte-identical, no mtime churn).
      expect(readSettingsRaw(dir)).toBe(afterFirst);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('returns false when the key is already false', async () => {
    const dir = makeTmpDir();
    try {
      writeSettings(dir, { enableAllProjectMcpServers: false });
      expect(await autoApproveFix().apply(dir)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('returns false when the key is absent', async () => {
    const dir = makeTmpDir();
    try {
      writeSettings(dir, { permissions: { allow: ['Bash'] } });
      expect(await autoApproveFix().apply(dir)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('preserves unrelated keys and their order', async () => {
    const dir = makeTmpDir();
    try {
      writeSettings(dir, {
        permissions: { allow: ['Bash', 'Read'], deny: [] },
        enableAllProjectMcpServers: true,
        hooks: { PreToolUse: [] },
      });
      const changed = await autoApproveFix().apply(dir);
      expect(changed).toBe(true);
      const parsed = JSON.parse(readSettingsRaw(dir));
      expect(parsed.permissions).toEqual({ allow: ['Bash', 'Read'], deny: [] });
      expect(parsed.hooks).toEqual({ PreToolUse: [] });
      expect(parsed.enableAllProjectMcpServers).toBe(false);
      expect(Object.keys(parsed)).toEqual([
        'permissions',
        'enableAllProjectMcpServers',
        'hooks',
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('returns false when settings.json is missing', async () => {
    const dir = makeTmpDir();
    try {
      expect(await autoApproveFix().apply(dir)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('returns false when settings.json is corrupt (never clobbers)', async () => {
    const dir = makeTmpDir();
    try {
      const settingsDir = path.join(dir, '.claude');
      fs.mkdirSync(settingsDir, { recursive: true });
      const corrupt = '{ this is not valid json ]]]';
      fs.writeFileSync(path.join(settingsDir, 'settings.json'), corrupt);
      expect(await autoApproveFix().apply(dir)).toBe(false);
      // Corrupt file left byte-for-byte alone.
      expect(readSettingsRaw(dir)).toBe(corrupt);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });
});

describe('mcp-config fixes: registration + dispatch', () => {
  beforeAll(async () => {
    await loadChecks();
  });

  it('findApplicableFixes matches the fixer by each auto-approve findingId', () => {
    for (const findingId of [
      'mcp-config/mcp-auto-approve-enabled',
      'mcp-config/cve-2025-59536-auto-approve-on-clone',
    ]) {
      const results = [{
        id: 'mcp-config',
        findings: [{ severity: 'critical', findingId, title: 'reworded title' }],
      }];
      const applicable = findApplicableFixes(results);
      expect(applicable.some((f) => f.id === 'mcp-auto-approve-disable')).toBe(true);
    }
  });

  it('applies end-to-end via findApplicableFixes + applyFixes', async () => {
    const dir = makeTmpDir();
    try {
      writeSettings(dir, { enableAllProjectMcpServers: true });
      const results = [{
        id: 'mcp-config',
        findings: [{
          severity: 'critical',
          findingId: 'mcp-config/mcp-auto-approve-enabled',
          title: 'MCP auto-approve enabled in .claude/settings.json',
        }],
      }];
      const applicable = findApplicableFixes(results);
      const { applied } = await applyFixes(applicable, dir, dir);
      expect(applied.length).toBe(1);
      expect(JSON.parse(readSettingsRaw(dir)).enableAllProjectMcpServers).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });
});

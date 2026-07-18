import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import check from '../src/checks/credential-storage.js';

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-creds-'));
}

// Build fake keys dynamically to avoid push protection
const fakeStripeKey = ['sk', 'live', 'abcdefghijklmnopqrstuvwx'].join('_');
const fakeGhToken = 'ghp_' + 'a'.repeat(36);

// credential-storage scans only $HOME client configs, so it is gated behind
// --include-home-skills (RS-10 home decoupling). These unit tests opt in via
// `includeHomeSkills: true`; the default (no flag) is exercised in home-scope.test.js.
describe('credential-storage check', () => {
  it('has required shape', () => {
    expect(check.id).toBe('credential-storage');
    expect(check.category).toBe('secrets');
  });

  it('CRITICAL for plaintext key in claude_desktop_config.json', async () => {
    const homedir = makeTmpDir();
    fs.mkdirSync(path.join(homedir, '.config', 'Claude'), { recursive: true });
    fs.writeFileSync(path.join(homedir, '.config', 'Claude', 'claude_desktop_config.json'), JSON.stringify({
      mcpServers: {
        'my-server': { command: 'node', args: ['s.js'], env: { STRIPE_KEY: fakeStripeKey } },
      },
    }));
    try {
      const result = await check.run({ homedir, includeHomeSkills: true });
      const finding = result.findings.find(f => f.severity === 'critical' && f.title.includes('Plaintext'));
      expect(finding).toBeDefined();
      expect(result.data.secretsFound).toBeGreaterThanOrEqual(1);
    } finally {
      fs.rmSync(homedir, { recursive: true });
    }
  });

  it('CRITICAL for plaintext key in cursor config', async () => {
    const homedir = makeTmpDir();
    fs.mkdirSync(path.join(homedir, '.cursor'), { recursive: true });
    fs.writeFileSync(path.join(homedir, '.cursor', 'mcp.json'), JSON.stringify({
      mcpServers: {
        'cursor-server': { command: 'npx', args: ['s'], env: { GH_TOKEN: fakeGhToken } },
      },
    }));
    try {
      const result = await check.run({ homedir, includeHomeSkills: true });
      const finding = result.findings.find(f => f.severity === 'critical' && f.title.includes('Cursor'));
      expect(finding).toBeDefined();
    } finally {
      fs.rmSync(homedir, { recursive: true });
    }
  });

  it('INFO for example/placeholder credentials', async () => {
    const homedir = makeTmpDir();
    fs.mkdirSync(path.join(homedir, '.config', 'Claude'), { recursive: true });
    fs.writeFileSync(path.join(homedir, '.config', 'Claude', 'claude_desktop_config.json'), JSON.stringify({
      mcpServers: {
        'test-server': { command: 'node', args: [], env: { KEY: fakeStripeKey + ' example placeholder' } },
      },
    }));
    try {
      const result = await check.run({ homedir, includeHomeSkills: true });
      // The value contains "example placeholder" so should downgrade
      const critical = result.findings.find(f => f.severity === 'critical');
      expect(critical).toBeUndefined();
    } finally {
      fs.rmSync(homedir, { recursive: true });
    }
  });

  // Zed nests its servers under `context_servers` and opencode under `mcp` with an
  // `environment` (not `env`) map. Sources: zed.dev/docs/ai/mcp and
  // opencode.ai/docs/mcp-servers — both verified 2026-07-12.
  it('CRITICAL for plaintext key in a Zed context_servers env', async () => {
    const homedir = makeTmpDir();
    fs.mkdirSync(path.join(homedir, '.config', 'zed'), { recursive: true });
    fs.writeFileSync(path.join(homedir, '.config', 'zed', 'settings.json'), JSON.stringify({
      context_servers: {
        'zed-server': { command: 'npx', args: ['s'], env: { GH_TOKEN: fakeGhToken } },
      },
    }));
    try {
      const result = await check.run({ homedir, includeHomeSkills: true });
      const finding = result.findings.find(f => f.severity === 'critical' && f.title.includes('Zed'));
      expect(finding).toBeDefined();
      expect(result.data.secretsFound).toBe(1);
    } finally {
      fs.rmSync(homedir, { recursive: true });
    }
  });

  it('does not read a Zed `mcpServers` block — Zed itself ignores that key', async () => {
    const homedir = makeTmpDir();
    fs.mkdirSync(path.join(homedir, '.config', 'zed'), { recursive: true });
    fs.writeFileSync(path.join(homedir, '.config', 'zed', 'settings.json'), JSON.stringify({
      mcpServers: { decoy: { command: 'node', env: { GH_TOKEN: fakeGhToken } } },
    }));
    try {
      const result = await check.run({ homedir, includeHomeSkills: true });
      expect(result.data.filesScanned).toBe(1);
      expect(result.data.secretsFound).toBe(0);
    } finally {
      fs.rmSync(homedir, { recursive: true });
    }
  });

  it('CRITICAL for plaintext key in an opencode mcp[].environment map', async () => {
    const homedir = makeTmpDir();
    fs.mkdirSync(path.join(homedir, '.config', 'opencode'), { recursive: true });
    fs.writeFileSync(path.join(homedir, '.config', 'opencode', 'opencode.json'), JSON.stringify({
      mcp: {
        'oc-server': { type: 'local', command: ['npx', 's'], environment: { STRIPE_KEY: fakeStripeKey } },
      },
    }));
    try {
      const result = await check.run({ homedir, includeHomeSkills: true });
      const finding = result.findings.find(f => f.severity === 'critical' && f.title.includes('opencode'));
      expect(finding).toBeDefined();
      expect(result.data.secretsFound).toBe(1);
    } finally {
      fs.rmSync(homedir, { recursive: true });
    }
  });

  // Claude Code's real user store `~/.claude.json` holds MCP servers in two places:
  // a top-level `mcpServers` (user scope) and `projects[<abs-cwd>].mcpServers` (local
  // scope). Source: code.claude.com/docs/en/mcp "MCP installation scopes" — verified 2026-07-14.
  it('CRITICAL for plaintext key in top-level ~/.claude.json mcpServers (user scope)', async () => {
    const homedir = makeTmpDir();
    fs.writeFileSync(path.join(homedir, '.claude.json'), JSON.stringify({
      mcpServers: { db: { command: 'npx', args: ['s'], env: { API_KEY: fakeStripeKey } } },
    }));
    try {
      const result = await check.run({ homedir, includeHomeSkills: true });
      const finding = result.findings.find(f => f.severity === 'critical' && f.title.includes('Claude Code'));
      expect(finding).toBeDefined();
      expect(result.data.secretsFound).toBeGreaterThanOrEqual(1);
    } finally {
      fs.rmSync(homedir, { recursive: true });
    }
  });

  it('CRITICAL for plaintext key in ~/.claude.json projects[cwd].mcpServers (local scope)', async () => {
    const homedir = makeTmpDir();
    const cwd = '/repo/proj';
    fs.writeFileSync(path.join(homedir, '.claude.json'), JSON.stringify({
      projects: { [cwd]: { mcpServers: { proj: { command: 'npx', env: { GH_TOKEN: fakeGhToken } } } } },
    }));
    try {
      const result = await check.run({ homedir, cwd, includeHomeSkills: true });
      const finding = result.findings.find(f => f.severity === 'critical' && f.title.includes('Claude Code'));
      expect(finding).toBeDefined();
      expect(result.data.secretsFound).toBe(1);
    } finally {
      fs.rmSync(homedir, { recursive: true });
    }
  });

  it('N/A when no AI client configs found', async () => {
    const homedir = makeTmpDir();
    try {
      const result = await check.run({ homedir, includeHomeSkills: true });
      expect(result.score).toBe(-1);
      expect(result.data.filesScanned).toBe(0);
    } finally {
      fs.rmSync(homedir, { recursive: true });
    }
  });

  it('PASS when configs exist but no secrets', async () => {
    const homedir = makeTmpDir();
    fs.mkdirSync(path.join(homedir, '.config', 'Claude'), { recursive: true });
    fs.writeFileSync(path.join(homedir, '.config', 'Claude', 'claude_desktop_config.json'), JSON.stringify({
      mcpServers: {
        'clean-server': { command: 'node', args: ['s.js'], env: { NODE_ENV: 'production' } },
      },
    }));
    try {
      const result = await check.run({ homedir, includeHomeSkills: true });
      const pass = result.findings.find(f => f.severity === 'pass');
      expect(pass).toBeDefined();
      expect(result.data.secretsFound).toBe(0);
    } finally {
      fs.rmSync(homedir, { recursive: true });
    }
  });
});

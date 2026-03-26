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

describe('credential-storage check', () => {
  it('has required shape', () => {
    expect(check.id).toBe('credential-storage');
    expect(check.category).toBe('secrets');
  });

  it('CRITICAL for plaintext key in claude_desktop_config.json', async () => {
    const homedir = makeTmpDir();
    fs.mkdirSync(path.join(homedir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(homedir, '.claude', 'claude_desktop_config.json'), JSON.stringify({
      mcpServers: {
        'my-server': { command: 'node', args: ['s.js'], env: { STRIPE_KEY: fakeStripeKey } },
      },
    }));
    try {
      const result = await check.run({ homedir });
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
      const result = await check.run({ homedir });
      const finding = result.findings.find(f => f.severity === 'critical' && f.title.includes('Cursor'));
      expect(finding).toBeDefined();
    } finally {
      fs.rmSync(homedir, { recursive: true });
    }
  });

  it('INFO for example/placeholder credentials', async () => {
    const homedir = makeTmpDir();
    fs.mkdirSync(path.join(homedir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(homedir, '.claude', 'claude_desktop_config.json'), JSON.stringify({
      mcpServers: {
        'test-server': { command: 'node', args: [], env: { KEY: fakeStripeKey + ' example placeholder' } },
      },
    }));
    try {
      const result = await check.run({ homedir });
      // The value contains "example placeholder" so should downgrade
      const critical = result.findings.find(f => f.severity === 'critical');
      expect(critical).toBeUndefined();
    } finally {
      fs.rmSync(homedir, { recursive: true });
    }
  });

  it('N/A when no AI client configs found', async () => {
    const homedir = makeTmpDir();
    try {
      const result = await check.run({ homedir });
      expect(result.score).toBe(-1);
      expect(result.data.filesScanned).toBe(0);
    } finally {
      fs.rmSync(homedir, { recursive: true });
    }
  });

  it('PASS when configs exist but no secrets', async () => {
    const homedir = makeTmpDir();
    fs.mkdirSync(path.join(homedir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(homedir, '.claude', 'claude_desktop_config.json'), JSON.stringify({
      mcpServers: {
        'clean-server': { command: 'node', args: ['s.js'], env: { NODE_ENV: 'production' } },
      },
    }));
    try {
      const result = await check.run({ homedir });
      const pass = result.findings.find(f => f.severity === 'pass');
      expect(pass).toBeDefined();
      expect(result.data.secretsFound).toBe(0);
    } finally {
      fs.rmSync(homedir, { recursive: true });
    }
  });
});

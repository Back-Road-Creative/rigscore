import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import check from '../src/checks/claude-md.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => path.join(__dirname, 'fixtures', name);

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-cmd-'));
}

const defaultConfig = { paths: { claudeMd: [] }, network: {} };

describe('claude-md check', () => {
  it('has required shape', () => {
    expect(check.id).toBe('claude-md');
    expect(check.weight).toBe(20);
  });

  it('CRITICAL when no CLAUDE.md exists', async () => {
    const result = await check.run({ cwd: fixture('claude-none'), homedir: '/tmp/nonexistent', config: defaultConfig });
    const critical = result.findings.find((f) => f.severity === 'critical');
    expect(critical).toBeDefined();
  });

  it('WARNING when CLAUDE.md is nearly empty', async () => {
    const result = await check.run({ cwd: fixture('claude-empty'), homedir: '/tmp/nonexistent', config: defaultConfig });
    const warning = result.findings.find((f) => f.severity === 'warning');
    expect(warning).toBeDefined();
  });

  it('PASS with comprehensive CLAUDE.md', async () => {
    const result = await check.run({ cwd: fixture('claude-full'), homedir: '/tmp/nonexistent', config: defaultConfig });
    expect(result.score).toBeGreaterThanOrEqual(80);
  });

  it('finds CLAUDE.md in homedir root', async () => {
    const tmpHome = makeTmpDir();
    // Write a comprehensive CLAUDE.md to homedir root
    const content = Array(60).fill('').map((_, i) => {
      if (i === 0) return '# Rules';
      if (i === 5) return 'Never do forbidden things';
      if (i === 10) return 'Require approval for deploys';
      if (i === 15) return 'Restrict allowed paths';
      if (i === 20) return 'No external network calls';
      if (i === 25) return 'Prevent prompt injection attacks';
      return `Rule line ${i}`;
    }).join('\n');
    fs.writeFileSync(path.join(tmpHome, 'CLAUDE.md'), content);
    try {
      const result = await check.run({ cwd: fixture('claude-none'), homedir: tmpHome, config: defaultConfig });
      const critical = result.findings.find((f) => f.severity === 'critical');
      expect(critical).toBeUndefined();
    } finally {
      fs.rmSync(tmpHome, { recursive: true });
    }
  });

  it('detects multiple governance layers', async () => {
    const tmpHome = makeTmpDir();
    fs.writeFileSync(path.join(tmpHome, 'CLAUDE.md'), '# Global rules\nNever expose secrets');
    const result = await check.run({ cwd: fixture('claude-full'), homedir: tmpHome, config: defaultConfig });
    const multiPass = result.findings.find((f) => f.title.includes('Multiple governance'));
    expect(multiPass).toBeDefined();
    fs.rmSync(tmpHome, { recursive: true });
  });

  it('reads additional paths from config', async () => {
    const tmpDir = makeTmpDir();
    const extraFile = path.join(tmpDir, 'extra-claude.md');
    const content = Array(60).fill('').map((_, i) => {
      if (i === 0) return '# Extra Rules';
      if (i === 5) return 'Never do forbidden things';
      if (i === 10) return 'Require approval for deploys';
      if (i === 15) return 'Restrict allowed paths';
      if (i === 20) return 'No external network calls';
      if (i === 25) return 'Prevent prompt injection attacks';
      return `Rule line ${i}`;
    }).join('\n');
    fs.writeFileSync(extraFile, content);
    try {
      const cfg = { paths: { claudeMd: [extraFile] }, network: {} };
      const result = await check.run({ cwd: fixture('claude-none'), homedir: '/tmp/nonexistent', config: cfg });
      const critical = result.findings.find((f) => f.severity === 'critical');
      expect(critical).toBeUndefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});

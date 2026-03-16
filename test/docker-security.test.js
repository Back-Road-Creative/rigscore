import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import check from '../src/checks/docker-security.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => path.join(__dirname, 'fixtures', name);

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-docker-'));
}

const defaultConfig = { paths: { dockerCompose: [] }, network: {} };

describe('docker-security check', () => {
  it('has required shape', () => {
    expect(check.id).toBe('docker-security');
    expect(check.weight).toBe(15);
  });

  it('CRITICAL when socket mounted and privileged', async () => {
    const result = await check.run({ cwd: fixture('docker-socket'), homedir: '/tmp', config: defaultConfig });
    const criticals = result.findings.filter((f) => f.severity === 'critical');
    expect(criticals.length).toBeGreaterThanOrEqual(2);
  });

  it('PASS with proper isolation', async () => {
    const result = await check.run({ cwd: fixture('docker-clean'), homedir: '/tmp', config: defaultConfig });
    const critical = result.findings.find((f) => f.severity === 'critical');
    expect(critical).toBeUndefined();
  });

  it('INFO when no Docker files', async () => {
    const result = await check.run({ cwd: fixture('docker-none'), homedir: '/tmp', config: defaultConfig });
    const info = result.findings.find((f) => f.severity === 'info');
    expect(info).toBeDefined();
    expect(result.score).toBe(-1);
  });

  it('WARNING when cap_drop ALL is missing', async () => {
    const tmpDir = makeTmpDir();
    const compose = `services:\n  app:\n    image: node:18\n`;
    fs.writeFileSync(path.join(tmpDir, 'docker-compose.yml'), compose);
    try {
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp', config: defaultConfig });
      const warning = result.findings.find((f) => f.severity === 'warning' && f.title.includes('cap_drop'));
      expect(warning).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('WARNING when no user directive in compose service', async () => {
    const tmpDir = makeTmpDir();
    const compose = `services:\n  app:\n    image: node:18\n`;
    fs.writeFileSync(path.join(tmpDir, 'docker-compose.yml'), compose);
    try {
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp', config: defaultConfig });
      const warning = result.findings.find((f) => f.severity === 'warning' && f.title.includes('user directive'));
      expect(warning).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('INFO when no memory limit', async () => {
    const tmpDir = makeTmpDir();
    const compose = `services:\n  app:\n    image: node:18\n`;
    fs.writeFileSync(path.join(tmpDir, 'docker-compose.yml'), compose);
    try {
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp', config: defaultConfig });
      const info = result.findings.find((f) => f.severity === 'info' && f.title.includes('memory limit'));
      expect(info).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('reads additional compose paths from config', async () => {
    const tmpDir = makeTmpDir();
    const externalDir = makeTmpDir();
    const compose = `services:\n  app:\n    image: node:18\n    privileged: true\n`;
    fs.writeFileSync(path.join(externalDir, 'docker-compose.yml'), compose);
    const cfg = { paths: { dockerCompose: [path.join(externalDir, 'docker-compose.yml')] }, network: {} };
    try {
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp', config: cfg });
      const critical = result.findings.find((f) => f.severity === 'critical' && f.title.includes('privileged'));
      expect(critical).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
      fs.rmSync(externalDir, { recursive: true });
    }
  });
});

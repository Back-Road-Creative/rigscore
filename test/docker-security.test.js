import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import check from '../src/checks/docker-security.js';
import { WEIGHTS } from '../src/constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => path.join(__dirname, 'fixtures', name);

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-docker-'));
}

const defaultConfig = { paths: { dockerCompose: [] }, network: {} };

describe('docker-security check', () => {
  it('has required shape', () => {
    expect(check.id).toBe('docker-security');
    expect(WEIGHTS[check.id]).toBe(8);
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

  it('CRITICAL when privileged service in override compose file', async () => {
    const tmpDir = makeTmpDir();
    const base = `services:\n  app:\n    image: node:18\n`;
    const override = `services:\n  app:\n    privileged: true\n`;
    fs.writeFileSync(path.join(tmpDir, 'docker-compose.yml'), base);
    const overridePath = path.join(tmpDir, 'docker-compose.override.yml');
    fs.writeFileSync(overridePath, override);
    const cfg = { paths: { dockerCompose: [overridePath] }, network: {} };
    try {
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp', config: cfg });
      const critical = result.findings.find((f) => f.severity === 'critical' && f.title.includes('privileged'));
      expect(critical).toBeDefined();
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

  it('WARNING for pipe-to-shell in RUN instruction', async () => {
    const result = await check.run({ cwd: fixture('docker-run-unsafe'), homedir: '/tmp', config: defaultConfig });
    const warning = result.findings.find((f) => f.severity === 'warning' && f.title.includes('pipe-to-shell'));
    expect(warning).toBeDefined();
  });

  it('WARNING for chmod 777 in RUN instruction', async () => {
    const result = await check.run({ cwd: fixture('docker-run-unsafe'), homedir: '/tmp', config: defaultConfig });
    const warning = result.findings.find((f) => f.severity === 'warning' && f.title.includes('chmod 777'));
    expect(warning).toBeDefined();
  });

  it('WARNING for EXPOSE 22', async () => {
    const result = await check.run({ cwd: fixture('docker-run-unsafe'), homedir: '/tmp', config: defaultConfig });
    const warning = result.findings.find((f) => f.severity === 'warning' && f.title.includes('SSH port'));
    expect(warning).toBeDefined();
  });

  it('INFO for apt-get without --no-install-recommends', async () => {
    const result = await check.run({ cwd: fixture('docker-run-unsafe'), homedir: '/tmp', config: defaultConfig });
    const info = result.findings.find((f) => f.severity === 'info' && f.title.includes('no-install-recommends'));
    expect(info).toBeDefined();
  });

  it('INFO for apk add without --no-cache', async () => {
    const result = await check.run({ cwd: fixture('docker-run-unsafe'), homedir: '/tmp', config: defaultConfig });
    const info = result.findings.find((f) => f.severity === 'info' && f.title.includes('no-cache'));
    expect(info).toBeDefined();
  });

  it('WARNING when Dockerfile COPYs sensitive files (.env, *.pem, *.key, id_rsa)', async () => {
    const tmpDir = makeTmpDir();
    const dockerfile = [
      'FROM node:18',
      'COPY .env .',
      'COPY server.pem /certs/',
      'COPY id_rsa /root/.ssh/',
      'USER node',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, 'Dockerfile'), dockerfile);
    try {
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp', config: defaultConfig });
      const warnings = result.findings.filter(
        (f) => f.severity === 'warning' && f.title.includes('copies sensitive file'),
      );
      expect(warnings.length).toBeGreaterThanOrEqual(3);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('WARNING when Dockerfile ADDs credentials.json', async () => {
    const tmpDir = makeTmpDir();
    const dockerfile = [
      'FROM node:18',
      'ADD credentials.json /app/',
      'USER node',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, 'Dockerfile'), dockerfile);
    try {
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp', config: defaultConfig });
      const warning = result.findings.find(
        (f) => f.severity === 'warning' && f.title.includes('copies sensitive file'),
      );
      expect(warning).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('returns data.hasPrivilegedContainer', async () => {
    const result = await check.run({ cwd: fixture('docker-socket'), homedir: '/tmp', config: defaultConfig });
    expect(result.data).toBeDefined();
    expect(result.data.hasPrivilegedContainer).toBe(true);
  });

  it('data.hasPrivilegedContainer is false for clean config', async () => {
    const result = await check.run({ cwd: fixture('docker-clean'), homedir: '/tmp', config: defaultConfig });
    expect(result.data).toBeDefined();
    expect(result.data.hasPrivilegedContainer).toBe(false);
  });
});

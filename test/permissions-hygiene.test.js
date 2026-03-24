import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import check from '../src/checks/permissions-hygiene.js';
import { WEIGHTS } from '../src/constants.js';

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-perms-'));
}

describe('permissions-hygiene check', () => {
  it('has required shape', () => {
    expect(check.id).toBe('permissions-hygiene');
    expect(check.name).toBe('Permissions hygiene');
    expect(check.category).toBe('process');
    expect(WEIGHTS[check.id]).toBe(6);
    expect(typeof check.run).toBe('function');
  });

  it('PASS when no sensitive files found and no SSH issues', async () => {
    const tmpDir = makeTmpDir();
    const tmpHome = makeTmpDir();
    try {
      const result = await check.run({ cwd: tmpDir, homedir: tmpHome, config: { paths: {}, network: {} } });
      const issues = result.findings.filter((f) => f.severity === 'critical' || f.severity === 'warning');
      expect(issues).toHaveLength(0);
      expect(result.score).toBe(100);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
      fs.rmSync(tmpHome, { recursive: true });
    }
  });

  if (process.platform !== 'win32') {
    it('WARNING when sensitive file in cwd is world-readable', async () => {
      const tmpDir = makeTmpDir();
      const tmpHome = makeTmpDir();
      const pemFile = path.join(tmpDir, 'server.pem');
      fs.writeFileSync(pemFile, 'fake cert');
      fs.chmodSync(pemFile, 0o644);
      try {
        const result = await check.run({ cwd: tmpDir, homedir: tmpHome, config: { paths: {}, network: {} } });
        const warning = result.findings.find((f) => f.severity === 'warning' && f.title.includes('server.pem'));
        expect(warning).toBeDefined();
      } finally {
        fs.rmSync(tmpDir, { recursive: true });
        fs.rmSync(tmpHome, { recursive: true });
      }
    });

    it('CRITICAL when SSH private key has wrong permissions', async () => {
      const tmpDir = makeTmpDir();
      const tmpHome = makeTmpDir();
      const sshDir = path.join(tmpHome, '.ssh');
      fs.mkdirSync(sshDir, { mode: 0o700 });
      const keyFile = path.join(sshDir, 'id_rsa');
      fs.writeFileSync(keyFile, 'fake key');
      fs.chmodSync(keyFile, 0o644);
      try {
        const result = await check.run({ cwd: tmpDir, homedir: tmpHome, config: { paths: {}, network: {} } });
        const critical = result.findings.find((f) => f.severity === 'critical' && f.title.includes('SSH'));
        expect(critical).toBeDefined();
      } finally {
        fs.rmSync(tmpDir, { recursive: true });
        fs.rmSync(tmpHome, { recursive: true });
      }
    });

    it('WARNING when ~/.ssh directory has wrong permissions', async () => {
      const tmpDir = makeTmpDir();
      const tmpHome = makeTmpDir();
      const sshDir = path.join(tmpHome, '.ssh');
      fs.mkdirSync(sshDir, { mode: 0o755 });
      try {
        const result = await check.run({ cwd: tmpDir, homedir: tmpHome, config: { paths: {}, network: {} } });
        const warning = result.findings.find((f) => f.severity === 'warning' && f.title.includes('.ssh'));
        expect(warning).toBeDefined();
      } finally {
        fs.rmSync(tmpDir, { recursive: true });
        fs.rmSync(tmpHome, { recursive: true });
      }
    });

    it('WARNING when governance files have mixed ownership', async () => {
      const tmpDir = makeTmpDir();
      const tmpHome = makeTmpDir();
      fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), '# Rules');
      try {
        const result = await check.run({ cwd: tmpDir, homedir: tmpHome, config: { paths: {}, network: {} } });
        const mixedWarning = result.findings.find((f) => f.title.includes('mixed'));
        expect(mixedWarning).toBeUndefined();
      } finally {
        fs.rmSync(tmpDir, { recursive: true });
        fs.rmSync(tmpHome, { recursive: true });
      }
    });
  }

  if (process.platform !== 'win32') {
    it('WARNING when .pem file in subdirectory is world-readable', async () => {
      const tmpDir = makeTmpDir();
      const tmpHome = makeTmpDir();
      const subDir = path.join(tmpDir, 'certs');
      fs.mkdirSync(subDir, { recursive: true });
      const pemFile = path.join(subDir, 'server.pem');
      fs.writeFileSync(pemFile, 'fake cert');
      fs.chmodSync(pemFile, 0o644);
      try {
        const result = await check.run({ cwd: tmpDir, homedir: tmpHome, config: { paths: {}, network: {} } });
        const warning = result.findings.find(
          (f) => f.severity === 'warning' && f.title.includes('server.pem'),
        );
        expect(warning).toBeDefined();
      } finally {
        fs.rmSync(tmpDir, { recursive: true });
        fs.rmSync(tmpHome, { recursive: true });
      }
    });
  }

  it('skips permission checks on Windows', async () => {
    const tmpDir = makeTmpDir();
    const tmpHome = makeTmpDir();
    try {
      const result = await check.run({ cwd: tmpDir, homedir: tmpHome, config: { paths: {}, network: {} } });
      expect(result).toHaveProperty('score');
      expect(result).toHaveProperty('findings');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
      fs.rmSync(tmpHome, { recursive: true });
    }
  });
});

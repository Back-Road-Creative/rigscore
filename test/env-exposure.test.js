import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import check from '../src/checks/env-exposure.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => path.join(__dirname, 'fixtures', name);

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-env-'));
}

describe('env-exposure check', () => {
  it('has required shape', () => {
    expect(check.id).toBe('env-exposure');
    expect(check.weight).toBe(10);
    expect(typeof check.run).toBe('function');
  });

  it('CRITICAL when .env exists but not in .gitignore', async () => {
    const result = await check.run({ cwd: fixture('env-exposed'), homedir: '/tmp' });
    expect(result.score).toBeLessThan(100);
    const critical = result.findings.find((f) => f.severity === 'critical');
    expect(critical).toBeDefined();
  });

  it('PASS when .env is in .gitignore', async () => {
    const result = await check.run({ cwd: fixture('env-gitignored'), homedir: '/tmp' });
    const critical = result.findings.find((f) => f.severity === 'critical');
    expect(critical).toBeUndefined();
  });

  it('CRITICAL when hardcoded key found in config file', async () => {
    const tmpDir = makeTmpDir();
    const prefix = 'sk-ant-';
    const suffix = 'api03-abcdefghij1234567890';
    fs.writeFileSync(path.join(tmpDir, 'config.js'), `const key = "${prefix}${suffix}";\n`);
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), '.env\n');

    try {
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp' });
      const critical = result.findings.find((f) => f.severity === 'critical');
      expect(critical).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('PASS when no .env and no hardcoded keys', async () => {
    const result = await check.run({ cwd: fixture('env-clean'), homedir: '/tmp' });
    const pass = result.findings.find((f) => f.severity === 'pass');
    expect(pass).toBeDefined();
  });

  it('PASS when .sops.yaml detected', async () => {
    const tmpDir = makeTmpDir();
    fs.writeFileSync(path.join(tmpDir, '.sops.yaml'), 'creation_rules:\n  - age: age1xxx\n');
    try {
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp' });
      const sopsPass = result.findings.find((f) => f.severity === 'pass' && f.title.includes('SOPS'));
      expect(sopsPass).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('CRITICAL trumps comment INFO when same key appears in comment and real code', async () => {
    const tmpDir = makeTmpDir();
    const prefix = ['sk', 'live'].join('_');
    const suffix = 'abcdefghijklmnopqrstuvwx';
    const key = `${prefix}_${suffix}`;
    const lines = [
      `// const old = "${key}"`,
      '',
      '',
      '',
      `const key = "${key}";`,
    ];
    fs.writeFileSync(path.join(tmpDir, 'config.js'), lines.join('\n') + '\n');
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), '.env\n');

    try {
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp' });
      const critical = result.findings.find((f) => f.severity === 'critical');
      expect(critical).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('PASS when .env is gitignored despite negation for .env.example', async () => {
    const tmpDir = makeTmpDir();
    fs.writeFileSync(path.join(tmpDir, '.env'), 'SECRET=foo\n');
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), '.env\n!.env.example\n');

    try {
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp' });
      const pass = result.findings.find((f) => f.severity === 'pass' && f.title.includes('gitignored'));
      expect(pass).toBeDefined();
      const critical = result.findings.find((f) => f.severity === 'critical' && f.title.includes('.env'));
      expect(critical).toBeUndefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  if (process.platform !== 'win32') {
    it('WARNING when .env file is world-readable', async () => {
      const tmpDir = makeTmpDir();
      fs.writeFileSync(path.join(tmpDir, '.env'), 'SECRET=foo');
      fs.chmodSync(path.join(tmpDir, '.env'), 0o644);
      fs.writeFileSync(path.join(tmpDir, '.gitignore'), '.env\n');
      try {
        const result = await check.run({ cwd: tmpDir, homedir: '/tmp' });
        const warning = result.findings.find((f) => f.severity === 'warning' && f.title.includes('world-readable'));
        expect(warning).toBeDefined();
      } finally {
        fs.rmSync(tmpDir, { recursive: true });
      }
    });
  }
});

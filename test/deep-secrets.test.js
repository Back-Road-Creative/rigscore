import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import check from '../src/checks/deep-secrets.js';

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-deep-'));
}

const defaultConfig = {};

describe('deep-secrets check', () => {
  it('has required shape', () => {
    expect(check.id).toBe('deep-secrets');
    expect(check.weight).toBe(10);
    expect(typeof check.run).toBe('function');
  });

  it('returns N/A when --deep flag is not set', async () => {
    const tmpDir = makeTmpDir();
    try {
      fs.writeFileSync(path.join(tmpDir, 'app.js'), 'const x = 1;');
      const result = await check.run({ cwd: tmpDir, deep: false, config: defaultConfig });
      expect(result.score).toBe(-1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('PASS when source files have no secrets', async () => {
    const tmpDir = makeTmpDir();
    try {
      fs.writeFileSync(path.join(tmpDir, 'app.js'), 'const x = 1;\nconsole.log(x);');
      fs.writeFileSync(path.join(tmpDir, 'utils.py'), 'def hello():\n    print("hello")');
      const result = await check.run({ cwd: tmpDir, deep: true, config: defaultConfig });
      expect(result.score).toBe(100);
      const pass = result.findings.find(f => f.severity === 'pass');
      expect(pass).toBeDefined();
      expect(pass.title).toContain('2 files checked');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('CRITICAL when hardcoded secret found in source', async () => {
    const tmpDir = makeTmpDir();
    try {
      // Build key dynamically to avoid self-detection
      const key = ['sk', 'ant', 'abcdefghij1234567890'].join('-');
      fs.writeFileSync(path.join(tmpDir, 'config.js'), `const API_KEY = "${key}";`);
      const result = await check.run({ cwd: tmpDir, deep: true, config: defaultConfig });
      expect(result.score).toBe(0);
      const critical = result.findings.find(f => f.severity === 'critical');
      expect(critical).toBeDefined();
      expect(critical.title).toContain('config.js');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('INFO when secret is in a comment', async () => {
    const tmpDir = makeTmpDir();
    try {
      const key = ['sk', 'ant', 'abcdefghij1234567890'].join('-');
      fs.writeFileSync(path.join(tmpDir, 'app.js'), `// Example key: ${key}`);
      const result = await check.run({ cwd: tmpDir, deep: true, config: defaultConfig });
      const info = result.findings.find(f => f.severity === 'info' && f.title.includes('comment'));
      expect(info).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('skips node_modules and .git directories', async () => {
    const tmpDir = makeTmpDir();
    try {
      const key = ['sk', 'ant', 'abcdefghij1234567890'].join('-');
      fs.mkdirSync(path.join(tmpDir, 'node_modules'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'node_modules', 'lib.js'), `const key = "${key}";`);
      fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, '.git', 'config.js'), `const key = "${key}";`);
      fs.writeFileSync(path.join(tmpDir, 'clean.js'), 'const x = 1;');
      const result = await check.run({ cwd: tmpDir, deep: true, config: defaultConfig });
      expect(result.score).toBe(100);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('scans subdirectories', async () => {
    const tmpDir = makeTmpDir();
    try {
      const key = ['ghp', 'abcdefghijklmnopqrstuvwxyz1234567890'].join('_');
      fs.mkdirSync(path.join(tmpDir, 'src', 'utils'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'src', 'utils', 'api.js'), `const TOKEN = "${key}";`);
      const result = await check.run({ cwd: tmpDir, deep: true, config: defaultConfig });
      expect(result.score).toBe(0);
      const critical = result.findings.find(f => f.severity === 'critical');
      expect(critical).toBeDefined();
      expect(critical.title).toContain('src/utils/api.js');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('respects maxFiles config', async () => {
    const tmpDir = makeTmpDir();
    try {
      // Create 5 files but set maxFiles to 2
      for (let i = 0; i < 5; i++) {
        fs.writeFileSync(path.join(tmpDir, `file${i}.js`), 'const x = 1;');
      }
      const result = await check.run({ cwd: tmpDir, deep: true, config: { deepScan: { maxFiles: 2 } } });
      const capped = result.findings.find(f => f.title.includes('capped'));
      expect(capped).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('skips test directories (test/, tests/, __tests__/)', async () => {
    const tmpDir = makeTmpDir();
    try {
      const key = ['sk', 'ant', 'abcdefghij1234567890'].join('-');
      for (const dir of ['test', 'tests', '__tests__']) {
        fs.mkdirSync(path.join(tmpDir, dir), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, dir, 'patterns.js'), `const key = "${key}";`);
      }
      fs.writeFileSync(path.join(tmpDir, 'clean.js'), 'const x = 1;');
      const result = await check.run({ cwd: tmpDir, deep: true, config: defaultConfig });
      expect(result.score).toBe(100);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('skips .test.js and .spec.js files in source directories', async () => {
    const tmpDir = makeTmpDir();
    try {
      const key = ['sk', 'ant', 'abcdefghij1234567890'].join('-');
      fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'src', 'api.test.js'), `const key = "${key}";`);
      fs.writeFileSync(path.join(tmpDir, 'src', 'api.spec.ts'), `const key = "${key}";`);
      fs.writeFileSync(path.join(tmpDir, 'src', 'api.js'), 'const x = 1;');
      const result = await check.run({ cwd: tmpDir, deep: true, config: defaultConfig });
      expect(result.score).toBe(100);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('includes .env.production files', async () => {
    const tmpDir = makeTmpDir();
    try {
      const key = ['sk', 'ant', 'abcdefghij1234567890'].join('-');
      fs.writeFileSync(path.join(tmpDir, '.env.production'), `API_KEY=${key}`);
      const result = await check.run({ cwd: tmpDir, deep: true, config: defaultConfig });
      expect(result.score).toBe(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});

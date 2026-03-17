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
    expect(check.weight).toBe(20);
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

  it('skips .env.example files', async () => {
    const tmpDir = makeTmpDir();
    fs.writeFileSync(path.join(tmpDir, '.env.example'), 'SECRET=changeme');
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), '.env\n');
    try {
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp' });
      const critical = result.findings.find((f) => f.severity === 'critical' && f.title.includes('.env'));
      expect(critical).toBeUndefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});

// --- Individual CONFIG_FILE detection tests ---
describe('env-exposure: per-config-file detection', () => {
  const fakeKey = 'AIzaSy' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ12345678';

  const configFiles = [
    'CLAUDE.md',
    '.mcp.json',
    '.cursorrules',
    '.windsurfrules',
    '.clinerules',
    '.continuerules',
    '.aider.conf.yml',
    'copilot-instructions.md',
    'AGENTS.md',
    'config.ts',
    'secrets.json',
    'application.yml',
    'settings.py',
    'settings.js',
  ];

  for (const file of configFiles) {
    it(`detects hardcoded key in ${file}`, async () => {
      const tmpDir = makeTmpDir();
      fs.writeFileSync(path.join(tmpDir, file), `api_key: "${fakeKey}"`);
      try {
        const result = await check.run({ cwd: tmpDir, homedir: '/tmp' });
        const critical = result.findings.find((f) => f.severity === 'critical' && f.title.includes(file));
        expect(critical).toBeDefined();
      } finally {
        fs.rmSync(tmpDir, { recursive: true });
      }
    });
  }

  it('detects hardcoded key in .github/copilot-instructions.md', async () => {
    const tmpDir = makeTmpDir();
    const ghDir = path.join(tmpDir, '.github');
    fs.mkdirSync(ghDir, { recursive: true });
    fs.writeFileSync(path.join(ghDir, 'copilot-instructions.md'), `token: "${fakeKey}"`);
    try {
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp' });
      const critical = result.findings.find((f) => f.severity === 'critical' && f.title.includes('copilot-instructions.md'));
      expect(critical).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('detects hardcoded key in .claude/settings.json', async () => {
    const tmpDir = makeTmpDir();
    const claudeDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), `{"key": "${fakeKey}"}`);
    try {
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp' });
      const critical = result.findings.find((f) => f.severity === 'critical' && f.title.includes('settings.json'));
      expect(critical).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});

// --- ENV_GITIGNORE_PATTERN tests ---
describe('env-exposure: gitignore pattern coverage', () => {
  const patterns = [
    '.env',
    '.env*',
    '*.env',
    '**/.env',
    '.env.*',
    '.env.local',
    '.env.*.local',
  ];

  for (const pattern of patterns) {
    it(`PASS when .gitignore contains only "${pattern}"`, async () => {
      const tmpDir = makeTmpDir();
      fs.writeFileSync(path.join(tmpDir, '.env'), 'SECRET=foo');
      fs.writeFileSync(path.join(tmpDir, '.gitignore'), pattern + '\n');
      try {
        const result = await check.run({ cwd: tmpDir, homedir: '/tmp' });
        const pass = result.findings.find((f) => f.severity === 'pass' && f.title.includes('gitignored'));
        expect(pass).toBeDefined();
      } finally {
        fs.rmSync(tmpDir, { recursive: true });
      }
    });
  }

  it('CRITICAL when .gitignore has no env pattern', async () => {
    const tmpDir = makeTmpDir();
    fs.writeFileSync(path.join(tmpDir, '.env'), 'SECRET=foo');
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'node_modules\n*.log\n');
    try {
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp' });
      const critical = result.findings.find((f) => f.severity === 'critical' && f.title.includes('NOT in .gitignore'));
      expect(critical).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('CRITICAL when negation pattern un-ignores .env', async () => {
    const tmpDir = makeTmpDir();
    fs.writeFileSync(path.join(tmpDir, '.env'), 'SECRET=foo');
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), '.env\n!.env\n');
    try {
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp' });
      const critical = result.findings.find((f) => f.severity === 'critical' && f.title.includes('NOT in .gitignore'));
      expect(critical).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});

// --- Base64-encoded secret detection ---
describe('env-exposure: base64-encoded secrets', () => {
  it('WARNING when config file contains base64-encoded API key', async () => {
    const tmpDir = makeTmpDir();
    // Build fake key dynamically to avoid push protection triggers
    const prefix = 'sk-ant-';
    const suffix = 'api03-abcdefghij1234567890abcdefghij';
    const fakeKey = prefix + suffix;
    const encoded = Buffer.from(fakeKey).toString('base64');
    fs.writeFileSync(path.join(tmpDir, 'config.json'), `{"token": "${encoded}"}`);
    try {
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp' });
      const warning = result.findings.find((f) => f.severity === 'warning' && f.title.includes('Base64-encoded'));
      expect(warning).toBeDefined();
      expect(warning.title).toContain('config.json');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('no base64 finding for non-secret base64 content', async () => {
    const tmpDir = makeTmpDir();
    // Encode something innocuous that doesn't match key patterns
    const encoded = Buffer.from('this is just a normal long string that does not match any key patterns at all really').toString('base64');
    fs.writeFileSync(path.join(tmpDir, 'config.json'), `{"data": "${encoded}"}`);
    try {
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp' });
      const warning = result.findings.find((f) => f.title.includes('Base64-encoded'));
      expect(warning).toBeUndefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});

// --- Windows code path ---
describe('env-exposure: Windows platform code path', () => {
  it('emits SKIPPED for .env permissions on Windows', async () => {
    const origPlatform = process.platform;
    const tmpDir = makeTmpDir();
    fs.writeFileSync(path.join(tmpDir, '.env'), 'SECRET=foo');
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), '.env\n');
    try {
      Object.defineProperty(process, 'platform', { value: 'win32', writable: true });
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp' });
      const skipped = result.findings.find((f) => f.severity === 'skipped' && f.title.includes('Windows'));
      expect(skipped).toBeDefined();
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform, writable: true });
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});

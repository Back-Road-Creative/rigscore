import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import check from '../src/checks/env-exposure.js';
import { WEIGHTS } from '../src/constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => path.join(__dirname, 'fixtures', name);

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-env-'));
}

describe('env-exposure check', () => {
  it('has required shape', () => {
    expect(check.id).toBe('env-exposure');
    expect(WEIGHTS[check.id]).toBe(8);
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

  it('WARNING when .env.example contains a real secret', async () => {
    const tmpDir = makeTmpDir();
    const prefix = 'sk-ant-';
    const suffix = 'api03-abcdefghij1234567890';
    fs.writeFileSync(path.join(tmpDir, '.env.example'), `API_KEY=${prefix}${suffix}\n`);
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), '.env\n');
    try {
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp' });
      const warning = result.findings.find(
        (f) => f.severity === 'warning' && f.title.includes('.env.example'),
      );
      expect(warning).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('PASS when .env.example has only placeholders', async () => {
    const tmpDir = makeTmpDir();
    fs.writeFileSync(path.join(tmpDir, '.env.example'), 'API_KEY=your_key_here\nDATABASE_URL=changeme\n');
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), '.env\n');
    try {
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp' });
      const warning = result.findings.find(
        (f) => f.severity === 'warning' && f.title.includes('.env.example'),
      );
      expect(warning).toBeUndefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('CRITICAL when GCP service account file detected', async () => {
    const tmpDir = makeTmpDir();
    // Build GCP service account JSON — dual-field detection requires both keys
    const gcpContent = JSON.stringify({
      type: 'service_account',
      project_id: 'my-project',
      private_key: 'MIIEvgIBADANBgkqhkiG9w0BAQEFAASC',
    });
    fs.writeFileSync(path.join(tmpDir, 'credentials.json'), gcpContent);
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), '.env\n');
    try {
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp' });
      const critical = result.findings.find(
        (f) => f.severity === 'critical' && f.title.includes('GCP service account'),
      );
      expect(critical).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('WARNING when shell history contains secrets', async () => {
    const tmpDir = makeTmpDir();
    const homeDir = makeTmpDir();
    const prefix = 'sk-ant-';
    const suffix = 'api03-abcdefghij1234567890';
    fs.writeFileSync(path.join(homeDir, '.bash_history'),
      `ls\ncd project\nexport ANTHROPIC_API_KEY=${prefix}${suffix}\nnpm start\n`);
    try {
      const result = await check.run({ cwd: tmpDir, homedir: homeDir });
      const finding = result.findings.find(f => f.title?.includes('bash_history'));
      expect(finding).toBeDefined();
      expect(finding.severity).toBe('warning');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
      fs.rmSync(homeDir, { recursive: true });
    }
  });

  it('WARNING for secrets in zsh_history', async () => {
    const tmpDir = makeTmpDir();
    const homeDir = makeTmpDir();
    const prefix = 'sk-ant-';
    const suffix = 'api03-abcdefghij1234567890';
    fs.writeFileSync(path.join(homeDir, '.zsh_history'),
      `git push\nANTHROPIC_API_KEY=${prefix}${suffix} npm run\n`);
    try {
      const result = await check.run({ cwd: tmpDir, homedir: homeDir });
      const finding = result.findings.find(f => f.title?.includes('zsh_history'));
      expect(finding).toBeDefined();
      expect(finding.severity).toBe('warning');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
      fs.rmSync(homeDir, { recursive: true });
    }
  });

  it('no history finding when history is clean', async () => {
    const tmpDir = makeTmpDir();
    const homeDir = makeTmpDir();
    fs.writeFileSync(path.join(homeDir, '.bash_history'), 'ls\ncd project\nnpm start\n');
    try {
      const result = await check.run({ cwd: tmpDir, homedir: homeDir });
      const finding = result.findings.find(f => f.title?.includes('history'));
      expect(finding).toBeUndefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
      fs.rmSync(homeDir, { recursive: true });
    }
  });

  it('no history finding when no history files exist', async () => {
    const tmpDir = makeTmpDir();
    const homeDir = makeTmpDir();
    try {
      const result = await check.run({ cwd: tmpDir, homedir: homeDir });
      const finding = result.findings.find(f => f.title?.includes('history'));
      expect(finding).toBeUndefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
      fs.rmSync(homeDir, { recursive: true });
    }
  });

  it('PASS in a monorepo subdir when parent .gitignore path-ignores the .env (issue: exact-string match fails)', async () => {
    // Real-world monorepo bug: parent `.gitignore` lists `apps/backend/.env`
    // (path-prefixed entry, no top-level `.env` line). When the scan runs with
    // cwd = apps/backend, git considers `.env` ignored, but the prior
    // exact-string match against the local `.gitignore` (which doesn't exist
    // here) returned false and emitted a critical false positive.
    const repoRoot = makeTmpDir();
    const sub = path.join(repoRoot, 'apps', 'backend');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'apps/backend/.env\n');
    fs.writeFileSync(path.join(sub, '.env'), 'SECRET=foo\n');

    // Initialize a real git repo so `git check-ignore` works against it.
    const gitOpts = {
      cwd: repoRoot,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
      },
      stdio: 'ignore',
    };
    execFileSync('git', ['init', '-q'], gitOpts);
    execFileSync('git', ['config', 'user.email', 'test@example.com'], gitOpts);
    execFileSync('git', ['config', 'user.name', 'test'], gitOpts);
    execFileSync('git', ['add', '.gitignore'], gitOpts);
    execFileSync('git', ['commit', '-q', '-m', 'init'], gitOpts);

    try {
      const result = await check.run({ cwd: sub, homedir: '/tmp' });
      const critical = result.findings.find(
        (f) => f.severity === 'critical' && f.title?.includes('.gitignore'),
      );
      expect(critical).toBeUndefined();
      const pass = result.findings.find(
        (f) => f.severity === 'pass' && f.title?.includes('gitignored'),
      );
      expect(pass).toBeDefined();
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
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

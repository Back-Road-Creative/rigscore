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

  it('PASS when .env is gitignored and an unrelated !venv negation exists (env substring, not path token)', async () => {
    const tmpDir = makeTmpDir();
    fs.writeFileSync(path.join(tmpDir, '.env'), 'SECRET=foo\n');
    // `!venv/keep.txt` contains the substring `env` but does NOT un-ignore any
    // `.env` file — the dangerous-negation guard must not fire on it.
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), '.env\n!venv/keep.txt\n');
    try {
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp' });
      const critical = result.findings.find(
        (f) => f.severity === 'critical' && f.title.includes('.env'),
      );
      expect(critical).toBeUndefined();
      const pass = result.findings.find(
        (f) => f.severity === 'pass' && f.title.includes('gitignored'),
      );
      expect(pass).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('PASS when .env is gitignored alongside other unrelated env-substring negations', async () => {
    for (const negation of ['!environment/', '!prevent.md', '!.eslintrc.env-notes']) {
      const tmpDir = makeTmpDir();
      fs.writeFileSync(path.join(tmpDir, '.env'), 'SECRET=foo\n');
      fs.writeFileSync(path.join(tmpDir, '.gitignore'), `.env\n${negation}\n`);
      try {
        const result = await check.run({ cwd: tmpDir, homedir: '/tmp' });
        const critical = result.findings.find(
          (f) => f.severity === 'critical' && f.title.includes('.env'),
        );
        expect(critical, `negation ${negation} must not trip the guard`).toBeUndefined();
      } finally {
        fs.rmSync(tmpDir, { recursive: true });
      }
    }
  });

  it('CRITICAL preserved for dangerous negations that un-ignore a real .env family file', async () => {
    // Each of these `!` lines un-ignores an actual `.env`-family file and must
    // still be surfaced as not-ignored (CRITICAL), even though `.env` is otherwise
    // gitignored.
    for (const negation of ['!.env', '!.env.local', '!config/.env', '!secrets/.env']) {
      const tmpDir = makeTmpDir();
      fs.writeFileSync(path.join(tmpDir, '.env'), 'SECRET=foo\n');
      fs.writeFileSync(path.join(tmpDir, '.gitignore'), `.env\n${negation}\n`);
      try {
        const result = await check.run({ cwd: tmpDir, homedir: '/tmp' });
        const critical = result.findings.find(
          (f) => f.severity === 'critical' && f.title.includes('.env'),
        );
        expect(critical, `negation ${negation} must trip the guard`).toBeDefined();
      } finally {
        fs.rmSync(tmpDir, { recursive: true });
      }
    }
  });

  it('PASS for un-ignore-safe example/sample/template negations (guard not over-narrowed)', async () => {
    for (const negation of ['!.env.example', '!.env.sample', '!.env.template']) {
      const tmpDir = makeTmpDir();
      fs.writeFileSync(path.join(tmpDir, '.env'), 'SECRET=foo\n');
      fs.writeFileSync(path.join(tmpDir, '.gitignore'), `.env\n${negation}\n`);
      try {
        const result = await check.run({ cwd: tmpDir, homedir: '/tmp' });
        const critical = result.findings.find(
          (f) => f.severity === 'critical' && f.title.includes('.env'),
        );
        expect(critical, `safe negation ${negation} must not trip the guard`).toBeUndefined();
      } finally {
        fs.rmSync(tmpDir, { recursive: true });
      }
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

  it('CRITICAL when a secret sits in a .vscode/mcp.json server env map (servers key, default scan)', async () => {
    const tmpDir = makeTmpDir();
    const prefix = 'sk-ant-';
    const suffix = 'api03-abcdefghij1234567890';
    // VS Code declares servers under `servers`, NOT `mcpServers` — the exact
    // sibling-door env-exposure missed while `.mcp.json` was a double-CRITICAL.
    const cfg = { servers: { db: { command: 'node', env: { ANTHROPIC_API_KEY: `${prefix}${suffix}` } } } };
    fs.mkdirSync(path.join(tmpDir, '.vscode'));
    fs.writeFileSync(path.join(tmpDir, '.vscode', 'mcp.json'), JSON.stringify(cfg));
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), '.env\n');
    try {
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp' });
      const critical = result.findings.find(
        (f) => f.severity === 'critical' && f.title.includes('.vscode/mcp.json'),
      );
      expect(critical).toBeDefined();
      expect(result.score).toBe(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('CRITICAL when a secret sits in a .gemini/settings.json MCP server env (default scan)', async () => {
    const tmpDir = makeTmpDir();
    const prefix = 'sk-ant-';
    const suffix = 'api03-abcdefghij1234567890';
    const cfg = { mcpServers: { g: { command: 'node', env: { KEY: `${prefix}${suffix}` } } } };
    fs.mkdirSync(path.join(tmpDir, '.gemini'));
    fs.writeFileSync(path.join(tmpDir, '.gemini', 'settings.json'), JSON.stringify(cfg));
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), '.env\n');
    try {
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp' });
      const critical = result.findings.find(
        (f) => f.severity === 'critical' && f.title.includes('.gemini/settings.json'),
      );
      expect(critical).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('CRITICAL when a secret sits in an opencode.json MCP server environment map (mcp key, default scan)', async () => {
    const tmpDir = makeTmpDir();
    const prefix = 'sk-ant-';
    const suffix = 'api03-abcdefghij1234567890';
    // opencode nests servers under `mcp` and env under `environment` — mcpServersIn
    // resolves the server key from the registry, so neither is a blind spot.
    const cfg = { mcp: { oc: { command: 'node', environment: { KEY: `${prefix}${suffix}` } } } };
    fs.writeFileSync(path.join(tmpDir, 'opencode.json'), JSON.stringify(cfg));
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), '.env\n');
    try {
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp' });
      const critical = result.findings.find(
        (f) => f.severity === 'critical' && f.title.includes('opencode.json'),
      );
      expect(critical).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('no false positive for a clean .vscode/mcp.json with no secret in its env map', async () => {
    const tmpDir = makeTmpDir();
    const cfg = { servers: { db: { command: 'node', env: { LOG_LEVEL: 'debug', PORT: '8080' } } } };
    fs.mkdirSync(path.join(tmpDir, '.vscode'));
    fs.writeFileSync(path.join(tmpDir, '.vscode', 'mcp.json'), JSON.stringify(cfg));
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), '.env\n');
    try {
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp' });
      const critical = result.findings.find((f) => f.severity === 'critical');
      expect(critical).toBeUndefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('finding title names the specific unignored env file when multiple exist', async () => {
    // Initialize a git repo so isInGitignore via `git check-ignore` works
    // against a real .gitignore (matches how the check actually queries).
    const tmpDir = makeTmpDir();
    try {
      execFileSync('git', ['init', '-q'], { cwd: tmpDir });
      // Three env files: .env is gitignored, .env.production is NOT.
      fs.writeFileSync(path.join(tmpDir, '.gitignore'), '.env\n');
      fs.writeFileSync(path.join(tmpDir, '.env'), 'SECRET=ok\n');
      fs.writeFileSync(path.join(tmpDir, '.env.production'), 'SECRET=leaked\n');
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp' });
      const critical = result.findings.find(
        (f) => f.severity === 'critical' && f.findingId === 'env-exposure/env-not-gitignored',
      );
      expect(critical).toBeDefined();
      expect(critical.title).toContain('.env.production');
      expect(critical.title).not.toMatch(/^\.env found/);
      expect(critical.evidence).toContain('.env.production');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});

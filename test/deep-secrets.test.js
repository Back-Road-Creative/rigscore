import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import check, { labelForPattern } from '../src/checks/deep-secrets.js';
import { KEY_PATTERNS, WEIGHTS } from '../src/constants.js';

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-deep-'));
}

const defaultConfig = {};

describe('deep-secrets check', () => {
  it('has required shape', () => {
    expect(check.id).toBe('deep-secrets');
    expect(WEIGHTS[check.id]).toBe(8);
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
      // Match the stable finding id, not the human title (which now names either cap cause).
      const capped = result.findings.find(f => f.findingId === 'deep-secrets/file-cap-reached');
      expect(capped).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('scans test directories for non-test files (test/, tests/, __tests__/)', async () => {
    const tmpDir = makeTmpDir();
    try {
      const key = ['sk', 'ant', 'abcdefghij1234567890'].join('-');
      // helpers.js is NOT a .test. or .spec. file, so should be scanned
      fs.mkdirSync(path.join(tmpDir, 'test'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'test', 'helpers.js'), `const key = "${key}";`);
      fs.writeFileSync(path.join(tmpDir, 'clean.js'), 'const x = 1;');
      const result = await check.run({ cwd: tmpDir, deep: true, config: defaultConfig });
      expect(result.score).toBe(0);
      const critical = result.findings.find(f => f.severity === 'critical');
      expect(critical).toBeDefined();
      expect(critical.title).toContain('test/helpers.js');
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

  it('CRITICAL when GCP service account JSON detected (dual-field)', async () => {
    const tmpDir = makeTmpDir();
    try {
      const gcpContent = JSON.stringify({
        type: 'service_account',
        project_id: 'my-project',
        private_key: 'MIIEvgIBADANBgkqhkiG9w0BAQEFAASC',
      });
      fs.writeFileSync(path.join(tmpDir, 'service-account.json'), gcpContent);
      const result = await check.run({ cwd: tmpDir, deep: true, config: defaultConfig });
      expect(result.score).toBe(0);
      const critical = result.findings.find(
        (f) => f.severity === 'critical' && f.title.includes('GCP service account'),
      );
      expect(critical).toBeDefined();
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

  // C5: blanket `entry.name.startsWith('.')` dir skip was removed. The
  // walker must recurse into `config/` and find `config/.env.production`
  // even though `.env.production` is dotfile-named.
  it('C5: walks into subdirs and flags secrets in `config/.env.production`', async () => {
    const tmpDir = makeTmpDir();
    try {
      fs.mkdirSync(path.join(tmpDir, 'config'));
      const key = ['sk', 'ant', 'deepdotfilescan0000000'].join('-');
      fs.writeFileSync(path.join(tmpDir, 'config', '.env.production'), `API_KEY=${key}\n`);
      const result = await check.run({ cwd: tmpDir, deep: true, config: defaultConfig });
      expect(result.score).toBe(0);
      const critical = result.findings.find(f => f.severity === 'critical');
      expect(critical).toBeDefined();
      expect(critical.title).toContain('.env.production');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  // Regression: the per-file line loop used to `break` on any match,
  // including an INFO match from a comment line. If a comment match
  // came BEFORE a real critical secret, the critical was swallowed and
  // only the info was reported — silently downgrading a real leak.
  it('escalates to CRITICAL when a real secret follows a comment match in the same file', async () => {
    const tmpDir = makeTmpDir();
    try {
      const oldKey = ['sk', 'ant', 'api03', 'AAAAAAAAAAAAAAAA'].join('-');
      const newKey = ['sk', 'ant', 'api03', 'BBBBBBBBBBBBBBBB'].join('-');
      const content = [
        `// Old API key: ${oldKey}`,
        '',
        `const key = "${newKey}";`,
      ].join('\n');
      fs.writeFileSync(path.join(tmpDir, 'config.js'), content);
      const result = await check.run({ cwd: tmpDir, deep: true, config: defaultConfig });
      const critical = result.findings.find(f => f.severity === 'critical');
      expect(critical).toBeDefined();
      expect(critical.title).toContain('config.js');
      // And the info-only finding for the comment line must NOT shadow it.
      expect(result.score).toBe(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('C5: does NOT recurse into SKIP_DIRS like .git / .venv / .next', async () => {
    const tmpDir = makeTmpDir();
    try {
      fs.mkdirSync(path.join(tmpDir, '.git'));
      fs.mkdirSync(path.join(tmpDir, '.venv'));
      fs.mkdirSync(path.join(tmpDir, '.next'));
      const key = ['sk', 'ant', 'shouldnotbefoundxxxxxx'].join('-');
      fs.writeFileSync(path.join(tmpDir, '.git', 'config.js'), `const k = "${key}";`);
      fs.writeFileSync(path.join(tmpDir, '.venv', 'config.py'), `KEY = "${key}"`);
      fs.writeFileSync(path.join(tmpDir, '.next', 'app.js'), `const k = "${key}";`);
      fs.writeFileSync(path.join(tmpDir, 'real.js'), 'const ok = true;');
      const result = await check.run({ cwd: tmpDir, deep: true, config: defaultConfig });
      // No secrets found — the SKIP_DIRS filter worked.
      expect(result.score).toBe(100);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  // The rigscore GitHub Action checks its OWN source out to a
  // `.rigscore-action-src/` subdirectory of the caller's scan root (actions/checkout
  // forces `path:` under $GITHUB_WORKSPACE, so it cannot be a true sibling). With
  // skipHidden:false the deep walk would descend into it and scan rigscore's own
  // files AS IF they were the caller's — polluting the caller's SARIF with phantom
  // findings about files they don't own. The vendored dir must be skipped by name.
  it('does NOT scan the vendored .rigscore-action-src/ checkout, but DOES find caller secrets', async () => {
    const tmpDir = makeTmpDir();
    try {
      const key = ['sk', 'ant', 'abcdefghij1234567890'].join('-');
      // Action's own vendored checkout — a secret-shaped string here must NOT surface.
      fs.mkdirSync(path.join(tmpDir, '.rigscore-action-src', 'src', 'checks'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, '.rigscore-action-src', 'src', 'checks', 'credential-storage.js'),
        `const example = "${key}";`,
      );
      // The caller's OWN source — a real secret here must still be detected.
      fs.writeFileSync(path.join(tmpDir, 'config.js'), `const API_KEY = "${key}";`);
      const result = await check.run({ cwd: tmpDir, deep: true, config: defaultConfig });

      // No finding may cite the vendored checkout.
      const vendored = result.findings.filter(f => JSON.stringify(f).includes('.rigscore-action-src'));
      expect(vendored).toEqual([]);

      // The caller's own secret is still caught.
      const critical = result.findings.find(f => f.severity === 'critical');
      expect(critical).toBeDefined();
      expect(critical.title).toContain('config.js');
      expect(result.score).toBe(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('finding detail uses a stable provider label, never the raw regex source', async () => {
    const tmpDir = makeTmpDir();
    try {
      // AKIA + 16 uppercase/digit chars matches the AWS access key pattern.
      const fakeKey = 'AKIA' + 'ABCDEFGHIJKLMNOP';
      fs.writeFileSync(path.join(tmpDir, 'leaky.js'), `const k = "${fakeKey}";`);
      const result = await check.run({ cwd: tmpDir, deep: true, config: defaultConfig });
      const secret = result.findings.find((f) => f.severity === 'critical' && f.title.includes('leaky.js'));
      expect(secret).toBeDefined();
      expect(secret.detail).toBe('Detected provider: AWS access key');
      // Must not contain raw regex metacharacters from the pattern source
      expect(secret.detail).not.toMatch(/\\b|\[0-9|\{16\}|\(\?:/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('labelForPattern returns a label for every KEY_PATTERN (no fallback leaks)', () => {
    // Every pattern in the canonical list should have a mapped label —
    // a "credential" fallback would mean an unrecognized pattern slipped
    // into KEY_PATTERNS without a corresponding PATTERN_LABEL_RULES entry.
    for (const pattern of KEY_PATTERNS) {
      const label = labelForPattern(pattern);
      expect(label).not.toBe('credential');
      expect(label.length).toBeGreaterThan(0);
    }
  });
});

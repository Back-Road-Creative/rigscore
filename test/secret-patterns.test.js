import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import check from '../src/checks/env-exposure.js';

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-secrets-'));
}

// Build fake keys dynamically to avoid GitHub push protection
const fakeStripeKey = ['sk', 'live', 'abcdefghijklmnopqrstuvwx'].join('_');
const fakeFirebaseKey = 'AIzaSy' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ12345678';
const fakeSendGridKey = 'SG.' + 'abcdefghijklmnopqrstuv' + '.' + 'abcdefghijklmnopqrstuv';

const defaultConfig = { paths: {}, network: {} };

describe('expanded secret patterns', () => {
  it('detects Stripe live secret key', async () => {
    const tmpDir = makeTmpDir();
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ key: fakeStripeKey }));
    try {
      const result = await check.run({ cwd: tmpDir });
      const critical = result.findings.find((f) => f.severity === 'critical' && f.title.includes('config.json'));
      expect(critical).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('detects SendGrid API key', async () => {
    const tmpDir = makeTmpDir();
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ key: fakeSendGridKey }));
    try {
      const result = await check.run({ cwd: tmpDir });
      const critical = result.findings.find((f) => f.severity === 'critical' && f.title.includes('config.json'));
      expect(critical).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('detects Firebase/Google API key', async () => {
    const tmpDir = makeTmpDir();
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ key: fakeFirebaseKey }));
    try {
      const result = await check.run({ cwd: tmpDir });
      const critical = result.findings.find((f) => f.severity === 'critical' && f.title.includes('config.json'));
      expect(critical).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('detects keys in secrets.yaml', async () => {
    const tmpDir = makeTmpDir();
    fs.writeFileSync(path.join(tmpDir, 'secrets.yaml'), `api_key: ${fakeStripeKey}`);
    try {
      const result = await check.run({ cwd: tmpDir });
      const critical = result.findings.find((f) => f.severity === 'critical' && f.title.includes('secrets.yaml'));
      expect(critical).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('detects keys in credentials.json', async () => {
    const tmpDir = makeTmpDir();
    fs.writeFileSync(path.join(tmpDir, 'credentials.json'), JSON.stringify({ key: fakeFirebaseKey }));
    try {
      const result = await check.run({ cwd: tmpDir });
      const critical = result.findings.find((f) => f.severity === 'critical' && f.title.includes('credentials.json'));
      expect(critical).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('downgrades example/placeholder keys to INFO', async () => {
    const tmpDir = makeTmpDir();
    fs.writeFileSync(path.join(tmpDir, 'config.json'), `"key": "${fakeStripeKey}" # example placeholder`);
    try {
      const result = await check.run({ cwd: tmpDir });
      const critical = result.findings.find((f) => f.severity === 'critical');
      expect(critical).toBeUndefined();
      const info = result.findings.find((f) => f.severity === 'info' && f.title.includes('Example'));
      expect(info).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('downgrades commented keys to INFO', async () => {
    const tmpDir = makeTmpDir();
    fs.writeFileSync(path.join(tmpDir, 'config.js'), `// const key = "${fakeStripeKey}"`);
    try {
      const result = await check.run({ cwd: tmpDir });
      const critical = result.findings.find((f) => f.severity === 'critical');
      expect(critical).toBeUndefined();
      const info = result.findings.find((f) => f.severity === 'info' && f.title.includes('comment'));
      expect(info).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('detects npm access token', async () => {
    const tmpDir = makeTmpDir();
    const fakeNpmToken = 'npm_' + 'a'.repeat(36);
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ key: fakeNpmToken }));
    try {
      const result = await check.run({ cwd: tmpDir });
      const critical = result.findings.find((f) => f.severity === 'critical' && f.title.includes('config.json'));
      expect(critical).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('detects PyPI API token', async () => {
    const tmpDir = makeTmpDir();
    const fakePypiToken = 'pypi-' + 'a'.repeat(16);
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ key: fakePypiToken }));
    try {
      const result = await check.run({ cwd: tmpDir });
      const critical = result.findings.find((f) => f.severity === 'critical' && f.title.includes('config.json'));
      expect(critical).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('detects Hugging Face token', async () => {
    const tmpDir = makeTmpDir();
    const fakeHfToken = 'hf_' + 'a'.repeat(34);
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ key: fakeHfToken }));
    try {
      const result = await check.run({ cwd: tmpDir });
      const critical = result.findings.find((f) => f.severity === 'critical' && f.title.includes('config.json'));
      expect(critical).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('detects MongoDB connection string', async () => {
    const tmpDir = makeTmpDir();
    const fakeMongoUri = 'mongodb+srv://user:pass@cluster0.mongodb.net/db';
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ key: fakeMongoUri }));
    try {
      const result = await check.run({ cwd: tmpDir });
      const critical = result.findings.find((f) => f.severity === 'critical' && f.title.includes('config.json'));
      expect(critical).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('detects Vercel token', async () => {
    const tmpDir = makeTmpDir();
    const fakeVercelToken = 'vercel_' + 'a'.repeat(24);
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ key: fakeVercelToken }));
    try {
      const result = await check.run({ cwd: tmpDir });
      const critical = result.findings.find((f) => f.severity === 'critical' && f.title.includes('config.json'));
      expect(critical).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  // --- Missing KEY_PATTERN tests for mutation coverage ---

  it('detects Anthropic API key (sk-ant-)', async () => {
    const tmpDir = makeTmpDir();
    const key = 'sk-ant-' + 'abcDEF12345_' + 'x'.repeat(10);
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ key }));
    try {
      const result = await check.run({ cwd: tmpDir });
      const critical = result.findings.find((f) => f.severity === 'critical');
      expect(critical).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('detects AWS access key (AKIA)', async () => {
    const tmpDir = makeTmpDir();
    const key = 'AKIA' + 'ABCDEFGHIJ123456';
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ key }));
    try {
      const result = await check.run({ cwd: tmpDir });
      const critical = result.findings.find((f) => f.severity === 'critical');
      expect(critical).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('detects GitHub PAT (ghp_)', async () => {
    const tmpDir = makeTmpDir();
    const key = 'ghp_' + 'a'.repeat(36);
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ key }));
    try {
      const result = await check.run({ cwd: tmpDir });
      const critical = result.findings.find((f) => f.severity === 'critical');
      expect(critical).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('detects GitHub OAuth token (gho_)', async () => {
    const tmpDir = makeTmpDir();
    const key = 'gho_' + 'b'.repeat(36);
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ key }));
    try {
      const result = await check.run({ cwd: tmpDir });
      const critical = result.findings.find((f) => f.severity === 'critical');
      expect(critical).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('detects Slack bot token (xoxb-)', async () => {
    const tmpDir = makeTmpDir();
    const key = 'xoxb-' + '1234567890-abcdef';
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ key }));
    try {
      const result = await check.run({ cwd: tmpDir });
      const critical = result.findings.find((f) => f.severity === 'critical');
      expect(critical).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('detects Slack user token (xoxp-)', async () => {
    const tmpDir = makeTmpDir();
    const key = 'xoxp-' + '9876543210-abcdef';
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ key }));
    try {
      const result = await check.run({ cwd: tmpDir });
      const critical = result.findings.find((f) => f.severity === 'critical');
      expect(critical).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('detects OpenAI-style key (sk-)', async () => {
    const tmpDir = makeTmpDir();
    const key = 'sk-' + 'a'.repeat(48);
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ key }));
    try {
      const result = await check.run({ cwd: tmpDir });
      const critical = result.findings.find((f) => f.severity === 'critical');
      expect(critical).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('detects GitLab PAT (glpat-)', async () => {
    const tmpDir = makeTmpDir();
    const key = 'glpat-' + 'abcDEF_123456789012345';
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ key }));
    try {
      const result = await check.run({ cwd: tmpDir });
      const critical = result.findings.find((f) => f.severity === 'critical');
      expect(critical).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('detects Stripe test secret key (sk_test_)', async () => {
    const tmpDir = makeTmpDir();
    const key = ['sk', 'test', 'a'.repeat(24)].join('_');
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ key }));
    try {
      const result = await check.run({ cwd: tmpDir });
      const critical = result.findings.find((f) => f.severity === 'critical');
      expect(critical).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('detects Stripe restricted key (rk_live_)', async () => {
    const tmpDir = makeTmpDir();
    const key = ['rk', 'live', 'a'.repeat(24)].join('_');
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ key }));
    try {
      const result = await check.run({ cwd: tmpDir });
      const critical = result.findings.find((f) => f.severity === 'critical');
      expect(critical).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('detects Stripe publishable key (pk_live_)', async () => {
    const tmpDir = makeTmpDir();
    const key = ['pk', 'live', 'a'.repeat(24)].join('_');
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ key }));
    try {
      const result = await check.run({ cwd: tmpDir });
      const critical = result.findings.find((f) => f.severity === 'critical');
      expect(critical).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('detects Twilio key (SK + 32 hex)', async () => {
    const tmpDir = makeTmpDir();
    const key = 'SK' + 'a1b2c3d4e5f6'.repeat(3).slice(0, 32);
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ key }));
    try {
      const result = await check.run({ cwd: tmpDir });
      const critical = result.findings.find((f) => f.severity === 'critical');
      expect(critical).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('detects DigitalOcean token (dop_v1_)', async () => {
    const tmpDir = makeTmpDir();
    const key = 'dop_v1_' + 'a'.repeat(64);
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ key }));
    try {
      const result = await check.run({ cwd: tmpDir });
      const critical = result.findings.find((f) => f.severity === 'critical');
      expect(critical).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('detects Mailgun key (key-)', async () => {
    const tmpDir = makeTmpDir();
    const key = 'key-' + 'abcdef0123456789'.repeat(2);
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ key }));
    try {
      const result = await check.run({ cwd: tmpDir });
      const critical = result.findings.find((f) => f.severity === 'critical');
      expect(critical).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  // --- Comment prefix detection ---

  it('downgrades key after # comment to INFO', async () => {
    const tmpDir = makeTmpDir();
    fs.writeFileSync(path.join(tmpDir, 'config.json'), `# api_key: ${fakeFirebaseKey}`);
    try {
      const result = await check.run({ cwd: tmpDir });
      const critical = result.findings.find((f) => f.severity === 'critical');
      expect(critical).toBeUndefined();
      const info = result.findings.find((f) => f.severity === 'info' && f.title.includes('comment'));
      expect(info).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('downgrades key after <!-- comment to INFO', async () => {
    const tmpDir = makeTmpDir();
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), `<!-- token: ${fakeFirebaseKey} -->`);
    try {
      const result = await check.run({ cwd: tmpDir });
      const critical = result.findings.find((f) => f.severity === 'critical');
      expect(critical).toBeUndefined();
      const info = result.findings.find((f) => f.severity === 'info' && f.title.includes('comment'));
      expect(info).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});

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

  it('does NOT flag generic sk- prefix as CRITICAL', async () => {
    const tmpDir = makeTmpDir();
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ key: 'sk-abcdefghij1234567890abc' }));
    try {
      const result = await check.run({ cwd: tmpDir });
      const critical = result.findings.find((f) => f.severity === 'critical');
      expect(critical).toBeUndefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('detects sk-proj- prefixed OpenAI key as CRITICAL', async () => {
    const tmpDir = makeTmpDir();
    const fakeOpenAIKey = 'sk-proj-abcdefghij1234567890abc';
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ key: fakeOpenAIKey }));
    try {
      const result = await check.run({ cwd: tmpDir });
      const critical = result.findings.find((f) => f.severity === 'critical');
      expect(critical).toBeDefined();
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

  it('detects Cloudflare API token', async () => {
    const tmpDir = makeTmpDir();
    const fakeToken = 'cf_' + 'a'.repeat(37);
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ key: fakeToken }));
    try {
      const result = await check.run({ cwd: tmpDir });
      const critical = result.findings.find((f) => f.severity === 'critical' && f.title.includes('config.json'));
      expect(critical).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('detects Railway token', async () => {
    const tmpDir = makeTmpDir();
    const fakeToken = 'railway_' + 'a'.repeat(24);
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ key: fakeToken }));
    try {
      const result = await check.run({ cwd: tmpDir });
      const critical = result.findings.find((f) => f.severity === 'critical' && f.title.includes('config.json'));
      expect(critical).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('detects PlanetScale token', async () => {
    const tmpDir = makeTmpDir();
    const fakeToken = 'pscale_tkn_' + 'a'.repeat(30);
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ key: fakeToken }));
    try {
      const result = await check.run({ cwd: tmpDir });
      const critical = result.findings.find((f) => f.severity === 'critical' && f.title.includes('config.json'));
      expect(critical).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('detects Neon API key', async () => {
    const tmpDir = makeTmpDir();
    const fakeToken = 'neon_' + 'a'.repeat(30);
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ key: fakeToken }));
    try {
      const result = await check.run({ cwd: tmpDir });
      const critical = result.findings.find((f) => f.severity === 'critical' && f.title.includes('config.json'));
      expect(critical).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('detects Linear API key', async () => {
    const tmpDir = makeTmpDir();
    const fakeToken = 'lin_api_' + 'a'.repeat(40);
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ key: fakeToken }));
    try {
      const result = await check.run({ cwd: tmpDir });
      const critical = result.findings.find((f) => f.severity === 'critical' && f.title.includes('config.json'));
      expect(critical).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('detects Replicate API token', async () => {
    const tmpDir = makeTmpDir();
    const fakeToken = 'r8_' + 'a'.repeat(37);
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ key: fakeToken }));
    try {
      const result = await check.run({ cwd: tmpDir });
      const critical = result.findings.find((f) => f.severity === 'critical' && f.title.includes('config.json'));
      expect(critical).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('detects AGE encryption key', async () => {
    const tmpDir = makeTmpDir();
    // AGE-SECRET-KEY-1 followed by 58 uppercase alphanumeric chars
    const fakeAgeKey = 'AGE-SECRET-KEY-1' + 'A'.repeat(58);
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ key: fakeAgeKey }));
    try {
      const result = await check.run({ cwd: tmpDir });
      const critical = result.findings.find((f) => f.severity === 'critical' && f.title.includes('config.json'));
      expect(critical).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('detects Datadog API key', async () => {
    const tmpDir = makeTmpDir();
    const fakeDatadogKey = 'ddapi_' + 'a'.repeat(32);
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ key: fakeDatadogKey }));
    try {
      const result = await check.run({ cwd: tmpDir });
      const critical = result.findings.find((f) => f.severity === 'critical' && f.title.includes('config.json'));
      expect(critical).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('detects 1Password CLI reference', async () => {
    const tmpDir = makeTmpDir();
    const fake1pRef = 'op://vault/item/field';
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ key: fake1pRef }));
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
});

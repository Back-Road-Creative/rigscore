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
});

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import check from '../src/checks/git-hooks.js';

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-hooks-'));
}

const defaultConfig = { paths: { hookDirs: [] }, network: {} };

function setupHook(tmpDir, content, mode = 0o755) {
  const hooksDir = path.join(tmpDir, '.git', 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  const hookPath = path.join(hooksDir, 'pre-commit');
  fs.writeFileSync(hookPath, content);
  fs.chmodSync(hookPath, mode);
}

describe('expanded hook validation', () => {
  it('detects sleep-only hook as no-op', async () => {
    const tmpDir = makeTmpDir();
    setupHook(tmpDir, '#!/bin/sh\nsleep 1\nexit 0');
    try {
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp', config: defaultConfig });
      const warning = result.findings.find((f) => f.severity === 'warning' && f.title.includes('no-op'));
      expect(warning).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('detects date-only hook as no-op', async () => {
    const tmpDir = makeTmpDir();
    setupHook(tmpDir, '#!/bin/sh\ndate\nexit 0');
    try {
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp', config: defaultConfig });
      const warning = result.findings.find((f) => f.severity === 'warning' && f.title.includes('no-op'));
      expect(warning).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('detects whoami+hostname hook as no-op', async () => {
    const tmpDir = makeTmpDir();
    setupHook(tmpDir, '#!/bin/sh\nwhoami\nhostname');
    try {
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp', config: defaultConfig });
      const warning = result.findings.find((f) => f.severity === 'warning' && f.title.includes('no-op'));
      expect(warning).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('INFO when hook has content but no recognized substance', async () => {
    const tmpDir = makeTmpDir();
    setupHook(tmpDir, '#!/bin/sh\ncustom_internal_tool --mode=fast');
    try {
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp', config: defaultConfig });
      const info = result.findings.find((f) => f.severity === 'info' && f.title.includes('substance'));
      expect(info).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('PASS when hook has recognized lint patterns', async () => {
    const tmpDir = makeTmpDir();
    setupHook(tmpDir, '#!/bin/sh\nnpx lint-staged');
    try {
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp', config: defaultConfig });
      const pass = result.findings.find((f) => f.severity === 'pass' && f.title.includes('Pre-commit'));
      expect(pass).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('PASS when hook has secret scanning pattern', async () => {
    const tmpDir = makeTmpDir();
    setupHook(tmpDir, '#!/bin/sh\ngitleaks detect --source . --verbose');
    try {
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp', config: defaultConfig });
      const pass = result.findings.find((f) => f.severity === 'pass' && f.title.includes('Pre-commit'));
      expect(pass).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('PASS when hook has conditional exit', async () => {
    const tmpDir = makeTmpDir();
    setupHook(tmpDir, '#!/bin/sh\nif grep -r "TODO" src/; then exit 1; fi');
    try {
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp', config: defaultConfig });
      const pass = result.findings.find((f) => f.severity === 'pass' && f.title.includes('Pre-commit'));
      expect(pass).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});

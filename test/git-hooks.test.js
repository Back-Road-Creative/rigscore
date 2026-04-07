import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import check from '../src/checks/git-hooks.js';
import { WEIGHTS } from '../src/constants.js';

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-git-'));
}

const defaultConfig = { paths: { hookDirs: [] }, network: {} };

describe('git-hooks check', () => {
  it('has required shape', () => {
    expect(check.id).toBe('git-hooks');
    expect(WEIGHTS[check.id]).toBe(2);
  });

  it('WARNING when no hooks exist', async () => {
    const tmpDir = makeTmpDir();
    fs.mkdirSync(path.join(tmpDir, '.git', 'hooks'), { recursive: true });
    try {
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp', config: defaultConfig });
      const warning = result.findings.find((f) => f.severity === 'warning');
      expect(warning).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('PASS when pre-commit hook exists', async () => {
    const tmpDir = makeTmpDir();
    const hooksDir = path.join(tmpDir, '.git', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, 'pre-commit'), '#!/bin/sh\nnpx lint-staged');
    fs.chmodSync(path.join(hooksDir, 'pre-commit'), 0o755);
    try {
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp', config: defaultConfig });
      const pass = result.findings.find((f) => f.severity === 'pass');
      expect(pass).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('PASS when husky is installed', async () => {
    const tmpDir = makeTmpDir();
    fs.mkdirSync(path.join(tmpDir, '.git', 'hooks'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.husky'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.husky', 'pre-commit'), '#!/bin/sh\nnpx lint-staged');
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
      devDependencies: { husky: '^9.0.0', 'lint-staged': '^15.0.0' },
    }));
    try {
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp', config: defaultConfig });
      const pass = result.findings.find((f) => f.severity === 'pass');
      expect(pass).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('PASS when Claude Code hooks detected', async () => {
    const tmpDir = makeTmpDir();
    fs.mkdirSync(path.join(tmpDir, '.git', 'hooks'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.claude', 'settings.json'), JSON.stringify({
      hooks: { PreToolUse: [{ command: 'echo test' }] },
    }));
    try {
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp', config: defaultConfig });
      const pass = result.findings.find((f) => f.severity === 'pass' && f.title.includes('Claude Code hooks'));
      expect(pass).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('PASS when pushurl guard detected', async () => {
    const tmpDir = makeTmpDir();
    fs.mkdirSync(path.join(tmpDir, '.git', 'hooks'), { recursive: true });
    const gitConfig = '[remote "origin"]\n\turl = git@github.com:user/repo.git\n\tpushurl = no_push\n';
    fs.writeFileSync(path.join(tmpDir, '.git', 'config'), gitConfig);
    try {
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp', config: defaultConfig });
      const pass = result.findings.find((f) => f.severity === 'pass' && f.title.includes('Push URL guard'));
      expect(pass).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('WARNING when hooks exist but lack secret scanning', async () => {
    const tmpDir = makeTmpDir();
    const hooksDir = path.join(tmpDir, '.git', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    // Hook with lint but no secret scanning
    fs.writeFileSync(path.join(hooksDir, 'pre-commit'), '#!/bin/sh\nnpx eslint .');
    fs.chmodSync(path.join(hooksDir, 'pre-commit'), 0o755);
    try {
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp', config: defaultConfig });
      const warning = result.findings.find((f) => f.severity === 'warning' && f.title.includes('secret scanning'));
      expect(warning).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('no secret scanning WARNING when gitleaks is in hook', async () => {
    const tmpDir = makeTmpDir();
    const hooksDir = path.join(tmpDir, '.git', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, 'pre-commit'), '#!/bin/sh\ngitleaks protect --staged');
    fs.chmodSync(path.join(hooksDir, 'pre-commit'), 0o755);
    try {
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp', config: defaultConfig });
      const warning = result.findings.find((f) => f.severity === 'warning' && f.title.includes('secret scanning'));
      expect(warning).toBeUndefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('PASS when external hook directory from config exists', async () => {
    const tmpDir = makeTmpDir();
    const hookDir = makeTmpDir();
    fs.mkdirSync(path.join(tmpDir, '.git', 'hooks'), { recursive: true });
    const cfg = { paths: { hookDirs: [hookDir] }, network: {} };
    try {
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp', config: cfg });
      const pass = result.findings.find((f) => f.severity === 'pass' && f.title.includes('External hook'));
      expect(pass).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
      fs.rmSync(hookDir, { recursive: true });
    }
  });
});

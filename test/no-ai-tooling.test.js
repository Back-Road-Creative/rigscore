import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import claudeMdCheck from '../src/checks/claude-md.js';
import skillFilesCheck from '../src/checks/skill-files.js';
import mcpConfigCheck from '../src/checks/mcp-config.js';
import { NOT_APPLICABLE_SCORE } from '../src/constants.js';
import { hasAnyAITooling } from '../src/utils.js';
import { stripAnsi, formatTerminal } from '../src/reporter.js';
import { scan } from '../src/scanner.js';

function makeTmpDir(label = 'no-ai') {
  return fs.mkdtempSync(path.join(os.tmpdir(), `rigscore-${label}-`));
}

const defaultConfig = { paths: { claudeMd: [] }, network: {} };

/**
 * C1 (Track C): Vanilla public-project shapes (Next.js / FastAPI / Rust
 * without any AI tooling markers) must NOT be scored CRITICAL on governance
 * checks. A hostile reviewer screenshotting "rigscore roasts
 * create-react-app" is the exact failure mode this test suite prevents.
 */
describe('C1: no-AI-tooling fixtures', () => {
  describe('hasAnyAITooling detector', () => {
    it('returns false for a truly empty directory', async () => {
      const tmp = makeTmpDir();
      try {
        expect(await hasAnyAITooling(tmp)).toBe(false);
      } finally {
        fs.rmSync(tmp, { recursive: true });
      }
    });

    it('returns true for CLAUDE.md', async () => {
      const tmp = makeTmpDir();
      fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), '# governance');
      try {
        expect(await hasAnyAITooling(tmp)).toBe(true);
      } finally {
        fs.rmSync(tmp, { recursive: true });
      }
    });

    it('returns true for .claude/ directory', async () => {
      const tmp = makeTmpDir();
      fs.mkdirSync(path.join(tmp, '.claude'));
      try {
        expect(await hasAnyAITooling(tmp)).toBe(true);
      } finally {
        fs.rmSync(tmp, { recursive: true });
      }
    });

    it('returns true for .cursor/ directory', async () => {
      const tmp = makeTmpDir();
      fs.mkdirSync(path.join(tmp, '.cursor'));
      try {
        expect(await hasAnyAITooling(tmp)).toBe(true);
      } finally {
        fs.rmSync(tmp, { recursive: true });
      }
    });

    it('returns true for project-level MCP config file', async () => {
      const tmp = makeTmpDir();
      fs.writeFileSync(path.join(tmp, '.mcp' + '.json'), '{}');
      try {
        expect(await hasAnyAITooling(tmp)).toBe(true);
      } finally {
        fs.rmSync(tmp, { recursive: true });
      }
    });

    it('returns true for .vscode/mcp.json (not plain .vscode/)', async () => {
      const tmp = makeTmpDir();
      fs.mkdirSync(path.join(tmp, '.vscode'));
      // Plain .vscode/ (without mcp.json) — every Node project has this.
      expect(await hasAnyAITooling(tmp)).toBe(false);
      fs.writeFileSync(path.join(tmp, '.vscode', 'mcp.json'), '{}');
      try {
        expect(await hasAnyAITooling(tmp)).toBe(true);
      } finally {
        fs.rmSync(tmp, { recursive: true });
      }
    });

    it('returns true for per-environment MCP config variants', async () => {
      const tmp = makeTmpDir();
      fs.writeFileSync(path.join(tmp, '.mcp.prod' + '.json'), '{}');
      try {
        expect(await hasAnyAITooling(tmp)).toBe(true);
      } finally {
        fs.rmSync(tmp, { recursive: true });
      }
    });
  });

  describe('vanilla Next.js-shaped fixture', () => {
    it('claude-md returns NOT_APPLICABLE (not CRITICAL) — no "ungoverned" screenshot fodder', async () => {
      const tmp = makeTmpDir('nextjs');
      // Next.js-like shape: package.json + src + public, no AI tooling.
      fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({
        name: 'my-next-app', version: '0.1.0',
        dependencies: { next: '14.2.0', react: '18.2.0' },
      }));
      fs.mkdirSync(path.join(tmp, 'src'));
      fs.mkdirSync(path.join(tmp, 'public'));
      fs.writeFileSync(path.join(tmp, 'README.md'), '# My Next App\n');
      try {
        const result = await claudeMdCheck.run({ cwd: tmp, homedir: '/tmp/nonexistent', config: defaultConfig });
        expect(result.score).toBe(NOT_APPLICABLE_SCORE);
        const critical = result.findings.find((f) => f.severity === 'critical');
        expect(critical).toBeUndefined();
      } finally {
        fs.rmSync(tmp, { recursive: true });
      }
    });
  });

  describe('vanilla FastAPI-shaped fixture', () => {
    it('claude-md returns NOT_APPLICABLE', async () => {
      const tmp = makeTmpDir('fastapi');
      fs.writeFileSync(path.join(tmp, 'pyproject.toml'), '[project]\nname = "my-api"\nversion = "0.1.0"\n');
      fs.writeFileSync(path.join(tmp, 'main.py'), 'from fastapi import FastAPI\napp = FastAPI()\n');
      try {
        const result = await claudeMdCheck.run({ cwd: tmp, homedir: '/tmp/nonexistent', config: defaultConfig });
        expect(result.score).toBe(NOT_APPLICABLE_SCORE);
        const critical = result.findings.find((f) => f.severity === 'critical');
        expect(critical).toBeUndefined();
      } finally {
        fs.rmSync(tmp, { recursive: true });
      }
    });
  });

  describe('vanilla Rust-shaped fixture', () => {
    it('claude-md returns NOT_APPLICABLE', async () => {
      const tmp = makeTmpDir('rust');
      fs.writeFileSync(path.join(tmp, 'Cargo.toml'), '[package]\nname = "my-crate"\nversion = "0.1.0"\n');
      fs.mkdirSync(path.join(tmp, 'src'));
      fs.writeFileSync(path.join(tmp, 'src/main.rs'), 'fn main() {}\n');
      try {
        const result = await claudeMdCheck.run({ cwd: tmp, homedir: '/tmp/nonexistent', config: defaultConfig });
        expect(result.score).toBe(NOT_APPLICABLE_SCORE);
      } finally {
        fs.rmSync(tmp, { recursive: true });
      }
    });
  });

  describe('other governance-surface checks return NOT_APPLICABLE on vanilla shapes', () => {
    it('skill-files returns NOT_APPLICABLE (score -1) when no skill files exist', async () => {
      const tmp = makeTmpDir('skill-na');
      fs.writeFileSync(path.join(tmp, 'package.json'), '{"name":"app"}');
      try {
        const result = await skillFilesCheck.run({ cwd: tmp, homedir: '/tmp/nonexistent', config: defaultConfig });
        expect(result.score).toBe(NOT_APPLICABLE_SCORE);
      } finally {
        fs.rmSync(tmp, { recursive: true });
      }
    });

    it('mcp-config returns NOT_APPLICABLE when no MCP config anywhere', async () => {
      const tmp = makeTmpDir('mcp-na');
      fs.writeFileSync(path.join(tmp, 'package.json'), '{"name":"app"}');
      try {
        const result = await mcpConfigCheck.run({ cwd: tmp, homedir: '/tmp/nonexistent', config: defaultConfig });
        expect(result.score).toBe(NOT_APPLICABLE_SCORE);
      } finally {
        fs.rmSync(tmp, { recursive: true });
      }
    });
  });

  describe('reporter banner', () => {
    it('prints "No AI tooling detected" banner when all governance surfaces are NOT_APPLICABLE', async () => {
      const tmp = makeTmpDir('banner');
      fs.writeFileSync(path.join(tmp, 'package.json'), '{"name":"app"}');
      try {
        const scanResult = await scan({ cwd: tmp, homedir: '/tmp/nonexistent' });
        const output = stripAnsi(formatTerminal(scanResult, tmp, { noCta: true }));
        expect(output).toContain('No AI tooling detected');
        expect(output).toContain('--include-home-skills');
      } finally {
        fs.rmSync(tmp, { recursive: true });
      }
    });

    it('does NOT print banner when CLAUDE.md exists (governance surface applicable)', async () => {
      const tmp = makeTmpDir('no-banner');
      const content = Array(60).fill('').map((_, i) => {
        if (i === 0) return '# Rules';
        if (i === 5) return 'Never do forbidden things';
        if (i === 10) return 'Require approval for deploys';
        if (i === 15) return 'Restrict allowed paths';
        if (i === 20) return 'No external network calls';
        if (i === 25) return 'Prevent prompt injection attacks';
        return `Rule line ${i}`;
      }).join('\n');
      fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), content);
      try {
        const scanResult = await scan({ cwd: tmp, homedir: '/tmp/nonexistent' });
        const output = stripAnsi(formatTerminal(scanResult, tmp, { noCta: true }));
        expect(output).not.toContain('No AI tooling detected');
      } finally {
        fs.rmSync(tmp, { recursive: true });
      }
    });
  });
});

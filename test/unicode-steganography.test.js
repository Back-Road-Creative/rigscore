import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import check from '../src/checks/unicode-steganography.js';

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-unicode-'));
}

describe('unicode-steganography check', () => {
  it('has required shape', () => {
    expect(check.id).toBe('unicode-steganography');
    expect(check.category).toBe('governance');
  });

  it('CRITICAL for bidi override in CLAUDE.md', async () => {
    const tmpDir = makeTmpDir();
    // Right-to-left override U+202E
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), 'Normal text \u202Eevil hidden');
    try {
      const result = await check.run({ cwd: tmpDir });
      const finding = result.findings.find(f => f.severity === 'critical' && f.title.includes('Bidirectional'));
      expect(finding).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('WARNING for zero-width chars in .mcp.json', async () => {
    const tmpDir = makeTmpDir();
    fs.writeFileSync(path.join(tmpDir, '.mcp.json'), '{"mcpServers": {"test\u200B": {}}}');
    try {
      const result = await check.run({ cwd: tmpDir });
      const finding = result.findings.find(f => f.severity === 'warning' && f.title.includes('Zero-width'));
      expect(finding).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('WARNING for Cyrillic homoglyphs in .cursorrules', async () => {
    const tmpDir = makeTmpDir();
    // Cyrillic 'а' (U+0430) looks like Latin 'a'
    fs.writeFileSync(path.join(tmpDir, '.cursorrules'), 'Follow rules c\u0430refully');
    try {
      const result = await check.run({ cwd: tmpDir });
      const finding = result.findings.find(f => f.severity === 'warning' && f.title.includes('Homoglyph'));
      expect(finding).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('WARNING for Greek homoglyphs in AGENTS.md', async () => {
    const tmpDir = makeTmpDir();
    // Greek alpha U+03B1
    fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), 'Follow the \u03B1gent rules');
    try {
      const result = await check.run({ cwd: tmpDir });
      const finding = result.findings.find(f => f.severity === 'warning' && f.title.includes('Homoglyph'));
      expect(finding).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('N/A when no governance/config files found', async () => {
    const tmpDir = makeTmpDir();
    try {
      const result = await check.run({ cwd: tmpDir });
      expect(result.score).toBe(-1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('PASS for clean ASCII files', async () => {
    const tmpDir = makeTmpDir();
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), '# Rules\nBe helpful and concise.\n');
    try {
      const result = await check.run({ cwd: tmpDir });
      const pass = result.findings.find(f => f.severity === 'pass');
      expect(pass).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('detects multiple issue types in one file', async () => {
    const tmpDir = makeTmpDir();
    // Both bidi override AND zero-width
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), 'text \u202E reversed \u200B hidden');
    try {
      const result = await check.run({ cwd: tmpDir });
      const bidi = result.findings.find(f => f.title?.includes('Bidirectional'));
      const zw = result.findings.find(f => f.title?.includes('Zero-width'));
      expect(bidi).toBeDefined();
      expect(zw).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});

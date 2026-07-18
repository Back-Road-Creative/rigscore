import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { shouldTrigger } from '../src/watcher.js';
import { discoverProjects } from '../src/scanner.js';
import { repoMcpRelPaths } from '../src/clients.js';
import unicodeSteg from '../src/checks/unicode-steganography.js';

// RS-8: watcher INFRA_FILES, scanner PROJECT_MARKERS and unicode-steganography
// CONFIG_FILES all hardcoded a short list instead of deriving from the client
// registry, so a newly-registered client's committed config was an invisible
// blind spot for --watch rescans, --recursive project discovery, and codepoint
// steganography scanning alike.

let tmpDir;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-rds-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

describe('watcher INFRA_FILES registry-derived (RS-8)', () => {
  it('triggers on committed MCP configs beyond .mcp.json', () => {
    expect(shouldTrigger('.gemini/settings.json')).toBe(true);
    expect(shouldTrigger('opencode.json')).toBe(true);
    expect(shouldTrigger('.warp/.mcp.json')).toBe(true);
    // still the original surface
    expect(shouldTrigger('.mcp.json')).toBe(true);
  });

  it('does NOT rescan on a vendored dependency .mcp.json (over-broad endsWith fix)', () => {
    expect(shouldTrigger('node_modules/some-pkg/.mcp.json')).toBe(false);
    expect(shouldTrigger('node_modules/a/b/.gemini/settings.json')).toBe(false);
    expect(shouldTrigger('venv/lib/.mcp.json')).toBe(false);
    expect(shouldTrigger('__pycache__/.mcp.json')).toBe(false);
  });
});

describe('scanner PROJECT_MARKERS registry-derived (RS-8)', () => {
  function makeProject(root, name, files) {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), body);
  }

  it('recognizes a directory marked only by a newly-registered governance file', async () => {
    makeProject(tmpDir, 'proj-gemini', { 'GEMINI.md': '# rules' });
    makeProject(tmpDir, 'proj-qwen', { 'QWEN.md': '# rules' });
    makeProject(tmpDir, 'proj-opencode', { 'opencode.json': '{}' });
    makeProject(tmpDir, 'proj-empty', { 'notes.txt': 'nothing' });
    const projects = await discoverProjects(tmpDir, 1);
    expect(projects.some((p) => p.endsWith('proj-gemini'))).toBe(true);
    expect(projects.some((p) => p.endsWith('proj-qwen'))).toBe(true);
    expect(projects.some((p) => p.endsWith('proj-opencode'))).toBe(true);
    expect(projects.some((p) => p.endsWith('proj-empty'))).toBe(false);
  });
});

describe('unicode-steganography CONFIG_FILES registry-derived (RS-8)', () => {
  it('codepoint-scans a committed MCP config outside the original 4 paths', async () => {
    // A registered but previously-unscanned config (repo-relative, base cwd).
    const rel = repoMcpRelPaths().find((p) => p === '.gemini/settings.json');
    expect(rel).toBeDefined();
    const full = path.join(tmpDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    // U+202E RIGHT-TO-LEFT OVERRIDE embedded in a value.
    fs.writeFileSync(full, '{"mcpServers": {"x": {"env": {"K": "a‮b"}}}}');
    const res = await unicodeSteg.run({ cwd: tmpDir });
    const ids = res.findings.map((f) => f.findingId);
    expect(ids).toContain('unicode-steganography/bidi-override');
    expect(res.data.filesScanned).toBeGreaterThan(0);
  });
});

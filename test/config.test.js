import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { loadConfig } from '../src/config.js';

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-config-'));
}

describe('loadConfig', () => {
  it('returns defaults when no config file exists', async () => {
    const tmpDir = makeTmpDir();
    try {
      const config = await loadConfig(tmpDir, tmpDir);
      expect(config).toHaveProperty('paths');
      expect(config).toHaveProperty('network');
      expect(config.paths.claudeMd).toEqual([]);
      expect(config.paths.dockerCompose).toEqual([]);
      expect(config.paths.mcpConfig).toEqual([]);
      expect(config.paths.hookDirs).toEqual([]);
      expect(config.paths.skillFiles).toEqual([]);
      expect(config.network.safeHosts).toEqual(['127.0.0.1', 'localhost', '::1']);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('loads .rigscorerc.json from cwd', async () => {
    const tmpDir = makeTmpDir();
    const rc = {
      paths: { claudeMd: ['/extra/CLAUDE.md'] },
      network: { safeHosts: ['127.0.0.1', 'localhost', '::1', '10.0.0.5'] },
    };
    fs.writeFileSync(path.join(tmpDir, '.rigscorerc.json'), JSON.stringify(rc));
    try {
      const config = await loadConfig(tmpDir, '/tmp/nonexistent');
      expect(config.paths.claudeMd).toEqual(['/extra/CLAUDE.md']);
      expect(config.network.safeHosts).toEqual(['127.0.0.1', 'localhost', '::1', '10.0.0.5']);
      expect(config.paths.dockerCompose).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('loads .rigscorerc.json from homedir when not in cwd', async () => {
    const cwdDir = makeTmpDir();
    const homeDir = makeTmpDir();
    const rc = { paths: { hookDirs: ['/opt/hooks'] } };
    fs.writeFileSync(path.join(homeDir, '.rigscorerc.json'), JSON.stringify(rc));
    try {
      const config = await loadConfig(cwdDir, homeDir);
      expect(config.paths.hookDirs).toEqual(['/opt/hooks']);
    } finally {
      fs.rmSync(cwdDir, { recursive: true });
      fs.rmSync(homeDir, { recursive: true });
    }
  });

  it('cwd config takes precedence over homedir config', async () => {
    const cwdDir = makeTmpDir();
    const homeDir = makeTmpDir();
    fs.writeFileSync(path.join(cwdDir, '.rigscorerc.json'), JSON.stringify({ paths: { claudeMd: ['/cwd/CLAUDE.md'] } }));
    fs.writeFileSync(path.join(homeDir, '.rigscorerc.json'), JSON.stringify({ paths: { claudeMd: ['/home/CLAUDE.md'] } }));
    try {
      const config = await loadConfig(cwdDir, homeDir);
      expect(config.paths.claudeMd).toEqual(['/cwd/CLAUDE.md']);
    } finally {
      fs.rmSync(cwdDir, { recursive: true });
      fs.rmSync(homeDir, { recursive: true });
    }
  });

  it('handles malformed JSON gracefully', async () => {
    const tmpDir = makeTmpDir();
    fs.writeFileSync(path.join(tmpDir, '.rigscorerc.json'), 'not valid json{{{');
    try {
      const config = await loadConfig(tmpDir, '/tmp/nonexistent');
      expect(config.paths.claudeMd).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('concatenates and deduplicates network.safeHosts', async () => {
    const tmpDir = makeTmpDir();
    const rc = { network: { safeHosts: ['10.0.0.5', 'localhost'] } };
    fs.writeFileSync(path.join(tmpDir, '.rigscorerc.json'), JSON.stringify(rc));
    try {
      const config = await loadConfig(tmpDir, '/tmp/nonexistent');
      // Should have defaults + user-specified, deduplicated
      expect(config.network.safeHosts).toContain('127.0.0.1');
      expect(config.network.safeHosts).toContain('::1');
      expect(config.network.safeHosts).toContain('10.0.0.5');
      expect(config.network.safeHosts).toContain('localhost');
      // No duplicates
      const unique = new Set(config.network.safeHosts);
      expect(unique.size).toBe(config.network.safeHosts.length);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('ignores unknown keys gracefully', async () => {
    const tmpDir = makeTmpDir();
    const rc = { paths: { claudeMd: ['/a'], unknownKey: 'value' }, extra: true };
    fs.writeFileSync(path.join(tmpDir, '.rigscorerc.json'), JSON.stringify(rc));
    try {
      const config = await loadConfig(tmpDir, '/tmp/nonexistent');
      expect(config.paths.claudeMd).toEqual(['/a']);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});

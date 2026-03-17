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
    const localPath = './extra/CLAUDE.md';
    const rc = {
      paths: { claudeMd: [localPath] },
      network: { safeHosts: ['127.0.0.1', 'localhost', '::1', '10.0.0.5'] },
    };
    fs.writeFileSync(path.join(tmpDir, '.rigscorerc.json'), JSON.stringify(rc));
    try {
      const config = await loadConfig(tmpDir, '/tmp/nonexistent');
      expect(config.paths.claudeMd).toEqual([localPath]);
      expect(config.network.safeHosts).toEqual(['127.0.0.1', 'localhost', '::1', '10.0.0.5']);
      expect(config.paths.dockerCompose).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('loads .rigscorerc.json from homedir when not in cwd', async () => {
    const cwdDir = makeTmpDir();
    const homeDir = makeTmpDir();
    const rc = { paths: { hookDirs: ['./hooks'] } };
    fs.writeFileSync(path.join(homeDir, '.rigscorerc.json'), JSON.stringify(rc));
    try {
      const config = await loadConfig(cwdDir, homeDir);
      expect(config.paths.hookDirs).toEqual(['./hooks']);
    } finally {
      fs.rmSync(cwdDir, { recursive: true });
      fs.rmSync(homeDir, { recursive: true });
    }
  });

  it('cwd config takes precedence over homedir config', async () => {
    const cwdDir = makeTmpDir();
    const homeDir = makeTmpDir();
    fs.writeFileSync(path.join(cwdDir, '.rigscorerc.json'), JSON.stringify({ paths: { claudeMd: ['./cwd/CLAUDE.md'] } }));
    fs.writeFileSync(path.join(homeDir, '.rigscorerc.json'), JSON.stringify({ paths: { claudeMd: ['./home/CLAUDE.md'] } }));
    try {
      const config = await loadConfig(cwdDir, homeDir);
      expect(config.paths.claudeMd).toEqual(['./cwd/CLAUDE.md']);
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

  it('ignores unknown keys gracefully', async () => {
    const tmpDir = makeTmpDir();
    const rc = { paths: { claudeMd: ['/a'], unknownKey: 'value' }, extra: true };
    fs.writeFileSync(path.join(tmpDir, '.rigscorerc.json'), JSON.stringify(rc));
    try {
      const config = await loadConfig(tmpDir, '/tmp/nonexistent');
      // '/a' is absolute and outside tmpDir, so it gets filtered out
      expect(config.paths.claudeMd).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('filters out absolute path traversal (/etc/passwd)', async () => {
    const tmpDir = makeTmpDir();
    const rc = { paths: { claudeMd: ['/etc/passwd'] } };
    fs.writeFileSync(path.join(tmpDir, '.rigscorerc.json'), JSON.stringify(rc));
    try {
      const config = await loadConfig(tmpDir, '/tmp/nonexistent');
      expect(config.paths.claudeMd).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('filters out relative path traversal (../../../etc/passwd)', async () => {
    const tmpDir = makeTmpDir();
    const rc = { paths: { claudeMd: ['../../../etc/passwd'] } };
    fs.writeFileSync(path.join(tmpDir, '.rigscorerc.json'), JSON.stringify(rc));
    try {
      const config = await loadConfig(tmpDir, '/tmp/nonexistent');
      expect(config.paths.claudeMd).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('keeps local paths (./local/CLAUDE.md)', async () => {
    const tmpDir = makeTmpDir();
    const rc = { paths: { claudeMd: ['./local/CLAUDE.md'] } };
    fs.writeFileSync(path.join(tmpDir, '.rigscorerc.json'), JSON.stringify(rc));
    try {
      const config = await loadConfig(tmpDir, '/tmp/nonexistent');
      expect(config.paths.claudeMd).toEqual(['./local/CLAUDE.md']);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});

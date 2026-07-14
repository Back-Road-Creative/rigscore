import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { loadConfig } from '../src/config.js';
import { ConfigParseError } from '../src/utils.js';

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-extends-'));
}

// A homedir that has no ~/.rigscorerc.json, so only the project config matters.
const NO_HOME = '/tmp/nonexistent-home-dir';

describe('config extends', () => {
  it('1. project extends a local base — extending file wins, arrays concat', async () => {
    const dir = makeTmpDir();
    try {
      fs.writeFileSync(
        path.join(dir, 'base.json'),
        JSON.stringify({ profile: 'minimal', network: { safeHosts: ['a.com'] } }),
      );
      fs.writeFileSync(
        path.join(dir, '.rigscorerc.json'),
        JSON.stringify({ extends: './base.json', profile: 'default', network: { safeHosts: ['b.com'] } }),
      );
      const config = await loadConfig(dir, NO_HOME);
      // Scalar: the file that extends wins over the base it extends.
      expect(config.profile).toBe('default');
      // Arrays concat (existing policy) — BOTH the base's and the file's hosts land.
      expect(config.network.safeHosts).toContain('a.com');
      expect(config.network.safeHosts).toContain('b.com');
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('2. array extends — later entries override earlier (ESLint convention)', async () => {
    const dir = makeTmpDir();
    try {
      fs.writeFileSync(path.join(dir, 'x.json'), JSON.stringify({ profile: 'minimal' }));
      fs.writeFileSync(path.join(dir, 'y.json'), JSON.stringify({ profile: 'default' }));
      fs.writeFileSync(
        path.join(dir, '.rigscorerc.json'),
        JSON.stringify({ extends: ['./x.json', './y.json'] }),
      );
      const config = await loadConfig(dir, NO_HOME);
      expect(config.profile).toBe('default'); // y (later) wins over x
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('3. nested extends (a -> b) resolves b\'s values depth-first', async () => {
    const dir = makeTmpDir();
    try {
      fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify({ profile: 'minimal' }));
      fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ extends: './b.json' }));
      fs.writeFileSync(path.join(dir, '.rigscorerc.json'), JSON.stringify({ extends: './a.json' }));
      const config = await loadConfig(dir, NO_HOME);
      expect(config.profile).toBe('minimal');
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('4. cycle a -> b -> a throws ConfigParseError naming the cycle', async () => {
    const dir = makeTmpDir();
    try {
      fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ extends: './b.json' }));
      fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify({ extends: './a.json' }));
      fs.writeFileSync(path.join(dir, '.rigscorerc.json'), JSON.stringify({ extends: './a.json' }));
      await expect(loadConfig(dir, NO_HOME)).rejects.toThrow(ConfigParseError);
      await expect(loadConfig(dir, NO_HOME)).rejects.toThrow(/cycle/i);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('5. URL extends is rejected — no egress', async () => {
    const dir = makeTmpDir();
    try {
      fs.writeFileSync(
        path.join(dir, '.rigscorerc.json'),
        JSON.stringify({ extends: 'https://evil.example/base.json' }),
      );
      await expect(loadConfig(dir, NO_HOME)).rejects.toThrow(ConfigParseError);
      await expect(loadConfig(dir, NO_HOME)).rejects.toThrow(/local path|URL/i);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('6. missing extends target throws ConfigParseError', async () => {
    const dir = makeTmpDir();
    try {
      fs.writeFileSync(
        path.join(dir, '.rigscorerc.json'),
        JSON.stringify({ extends: './does-not-exist.json' }),
      );
      await expect(loadConfig(dir, NO_HOME)).rejects.toThrow(ConfigParseError);
      await expect(loadConfig(dir, NO_HOME)).rejects.toThrow(/not found/i);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });
});

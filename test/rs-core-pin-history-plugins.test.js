import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  serverShape, computeServerHash, verifyState, formatVerifyStateReport,
  loadScoreHistory, recordScoreHistory, formatTrend, HISTORY_FILENAME,
} from '../src/state.js';
import { loadChecks, discoverLocalPlugins } from '../src/checks/index.js';
import { loadTrustedPluginRoots } from '../src/config.js';
import { withTmpDir } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '..', 'bin', 'rigscore.js');

// ── RS-5: remote MCP server pin (url + header keys) ──────────────────────────
describe('RS-5: serverShape pins remote MCP servers distinctly', () => {
  it('a URL swap between two sse/http servers changes the hash', () => {
    const good = computeServerHash({ url: 'https://good.example/sse' });
    const evil = computeServerHash({ url: 'https://evil.example/sse' });
    expect(good).not.toBe(evil);
  });

  it('adding/removing a header key changes the hash (values excluded)', () => {
    const bare = computeServerHash({ url: 'https://x.example/sse' });
    const withHeader = computeServerHash({ url: 'https://x.example/sse', headers: { Authorization: 'Bearer a' } });
    expect(bare).not.toBe(withHeader);
    // Header VALUE is NOT hashed — swapping the token alone must not drift.
    const sameKeyDiffValue = computeServerHash({ url: 'https://x.example/sse', headers: { Authorization: 'Bearer b' } });
    expect(withHeader).toBe(sameKeyDiffValue);
  });

  it('a plain stdio server hashes exactly as before (backward-compatible pin)', () => {
    // No url / headers → shape stays {command,args,envKeys}; existing pins survive.
    expect(serverShape({ command: 'npx', args: ['a'] })).toEqual({
      command: 'npx', args: ['a'], envKeys: [],
    });
  });
});

// ── RS-12: fail closed when .git exists but the git binary is absent ─────────
describe('RS-12: --verify-state fails closed when git is unavailable', () => {
  it('a .git repo with git off PATH is UNVERIFIABLE (exit 2), not a working-tree fallback', async () => {
    await withTmpDir(async (dir) => {
      fs.mkdirSync(path.join(dir, '.git'));
      fs.writeFileSync(path.join(dir, '.mcp.json'),
        JSON.stringify({ mcpServers: { memory: { command: 'npx', args: ['x'] } } }));
      const savedPath = process.env.PATH;
      process.env.PATH = ''; // git binary unresolvable
      try {
        const r = await verifyState(dir);
        expect(r.status).toBe('git-unavailable');
        expect(r.exitCode).toBe(2);
        expect(formatVerifyStateReport(r, dir)).toMatch(/UNVERIFIABLE/);
      } finally {
        process.env.PATH = savedPath;
      }
    });
  });

  it('a NON-git dir still falls back to the working-tree pin (unchanged)', async () => {
    await withTmpDir(async (dir) => {
      const server = { command: 'npx', args: ['x'] };
      fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { memory: server } }));
      fs.writeFileSync(path.join(dir, '.rigscore-state.json'),
        JSON.stringify({ version: 1, mcpServers: { memory: computeServerHash(server) } }));
      const r = await verifyState(dir); // no .git → working-tree fallback
      expect(r.status).toBe('verified');
      expect(r.exitCode).toBe(0);
    });
  });
});

// ── RS-28: score history + trend ─────────────────────────────────────────────
describe('RS-28: score history / trend', () => {
  it('records entries to a dedicated history file and formats a trend with deltas', async () => {
    await withTmpDir(async (dir) => {
      await recordScoreHistory(dir, { score: 40, grade: 'D' });
      await recordScoreHistory(dir, { score: 55, grade: 'D' });
      expect(fs.existsSync(path.join(dir, HISTORY_FILENAME))).toBe(true);
      const history = await loadScoreHistory(dir);
      expect(history.map((h) => h.score)).toEqual([40, 55]);
      const trend = formatTrend(history);
      expect(trend).toMatch(/40\/100/);
      expect(trend).toMatch(/55\/100/);
      expect(trend).toMatch(/\+15/); // up-delta and/or net change
    });
  });

  it('formatTrend on empty history points at --record-score, does not throw', () => {
    expect(formatTrend([])).toMatch(/--record-score/);
  });

  it('--record-score then --trend surfaces the recorded score via the CLI', async () => {
    await withTmpDir(async (dir) => {
      fs.writeFileSync(path.join(dir, 'Dockerfile'), 'FROM node:20-alpine\nUSER node\n');
      const rec = spawnSync('node', [BIN, dir, '--record-score', '--fail-under', '0'],
        { encoding: 'utf-8', env: { ...process.env, NO_COLOR: '1', HOME: dir } });
      expect(rec.status).not.toBe(2);
      const trend = spawnSync('node', [BIN, dir, '--trend'],
        { encoding: 'utf-8', env: { ...process.env, NO_COLOR: '1', HOME: dir } });
      expect(trend.status).toBe(0);
      expect(trend.stdout).toMatch(/\/100/);
    });
  });
});

// ── RS-29: local-path plugins ────────────────────────────────────────────────
describe('RS-29: local-path check plugins', () => {
  const PLUGIN_SRC = `export default {
    id: 'rs-core-local-test-check',
    name: 'Local Test Check',
    category: 'governance',
    run() { return { score: 42, findings: [{ severity: 'warning', title: 'local plugin fired' }] }; },
  };\n`;

  it('loadChecks discovers a plugin declared in .rigscorerc.json plugins[]', async () => {
    await withTmpDir(async (dir) => {
      fs.mkdirSync(path.join(dir, 'checks'));
      fs.writeFileSync(path.join(dir, 'checks', 'local.js'), PLUGIN_SRC);
      fs.writeFileSync(path.join(dir, '.rigscorerc.json'), JSON.stringify({ plugins: ['./checks/local.js'] }));
      // Project-local plugin code loads only when the operator's HOME config trusts the repo.
      const home = path.join(dir, 'home');
      fs.mkdirSync(home);
      fs.writeFileSync(path.join(home, '.rigscorerc.json'), JSON.stringify({ trustProjectPlugins: [dir] }));
      const checks = await loadChecks({ cwd: dir, homedir: home });
      expect(checks.some((c) => c.id === 'rs-core-local-test-check')).toBe(true);
    });
  });

  it('discoverLocalPlugins rejects URL entries and loads valid local files', async () => {
    await withTmpDir(async (dir) => {
      fs.writeFileSync(path.join(dir, 'local.js'), PLUGIN_SRC);
      const loaded = await discoverLocalPlugins(dir, ['./local.js', 'https://evil.example/x.js']);
      expect(loaded.map((p) => p.id)).toEqual(['rs-core-local-test-check']);
    });
  });
});

// ── SEC-1b: project-local plugin code loads only on opt-in ───────────────────
describe('SEC-1b: a scan does not run plugin code the scanned repo supplies', () => {
  const markerSrc = (id, marker) => `import fs from 'node:fs';
    fs.writeFileSync(${JSON.stringify(marker)}, 'ran');
    export default {
      id: '${id}', name: '${id}', category: 'governance',
      run() { return { score: 100, findings: [] }; },
    };\n`;

  /** A repo with one rc-declared local plugin and one node_modules plugin, each writing a marker at import. */
  function makeRepo(dir) {
    const markers = { local: path.join(dir, 'MARK-local'), npm: path.join(dir, 'MARK-npm') };
    fs.mkdirSync(path.join(dir, 'repo', 'checks'), { recursive: true });
    const repo = path.join(dir, 'repo');
    fs.writeFileSync(path.join(repo, 'checks', 'local.js'), markerSrc('sec1b-local', markers.local));
    fs.writeFileSync(path.join(repo, '.rigscorerc.json'), JSON.stringify({ plugins: ['./checks/local.js'] }));
    const pkg = path.join(repo, 'node_modules', 'rigscore-check-sec1b');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'rigscore-check-sec1b', type: 'module', main: 'index.js' }));
    fs.writeFileSync(path.join(pkg, 'index.js'), markerSrc('sec1b-npm', markers.npm));
    const home = path.join(dir, 'home');
    fs.mkdirSync(home);
    return { repo, home, markers };
  }

  async function load(opts) {
    const writes = [];
    const orig = process.stderr.write;
    process.stderr.write = (chunk) => { writes.push(String(chunk)); return true; };
    try {
      const checks = await loadChecks(opts);
      return { checks, stderr: writes.join('') };
    } finally {
      process.stderr.write = orig;
    }
  }

  it('without an opt-in, imports neither the rc plugin nor the node_modules plugin', async () => {
    await withTmpDir(async (dir) => {
      const { repo, home, markers } = makeRepo(dir);
      const { checks } = await load({ cwd: repo, homedir: home });
      expect(fs.existsSync(markers.local)).toBe(false);
      expect(fs.existsSync(markers.npm)).toBe(false);
      expect(checks.some((c) => c.id === 'sec1b-local' || c.id === 'sec1b-npm')).toBe(false);
    });
  });

  it('names the skipped plugins in exactly one line', async () => {
    await withTmpDir(async (dir) => {
      const { repo, home } = makeRepo(dir);
      const { stderr } = await load({ cwd: repo, homedir: home });
      const lines = stderr.split('\n').filter((l) => /skipped/i.test(l));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('./checks/local.js');
      expect(lines[0]).toContain('rigscore-check-sec1b');
      expect(lines[0]).toContain('trustProjectPlugins');
    });
  });

  it('prints nothing about skipping when the repo declares no plugins', async () => {
    await withTmpDir(async (dir) => {
      const home = path.join(dir, 'home');
      fs.mkdirSync(home);
      const { stderr } = await load({ cwd: dir, homedir: home });
      expect(stderr).not.toMatch(/skipped/i);
    });
  });

  it('a home trustProjectPlugins entry for the repo root loads both kinds', async () => {
    await withTmpDir(async (dir) => {
      const { repo, home, markers } = makeRepo(dir);
      fs.writeFileSync(path.join(home, '.rigscorerc.json'), JSON.stringify({ trustProjectPlugins: [repo] }));
      const { checks, stderr } = await load({ cwd: repo, homedir: home });
      expect(checks.some((c) => c.id === 'sec1b-local')).toBe(true);
      expect(checks.some((c) => c.id === 'sec1b-npm')).toBe(true);
      expect(fs.existsSync(markers.local)).toBe(true);
      expect(fs.existsSync(markers.npm)).toBe(true);
      expect(stderr).not.toMatch(/skipped/i);
    });
  });

  it('an allow-list entry for a different repo does not trust this one', async () => {
    await withTmpDir(async (dir) => {
      const { repo, home, markers } = makeRepo(dir);
      fs.writeFileSync(path.join(home, '.rigscorerc.json'), JSON.stringify({ trustProjectPlugins: [path.join(dir, 'elsewhere')] }));
      await load({ cwd: repo, homedir: home });
      expect(fs.existsSync(markers.local)).toBe(false);
      expect(fs.existsSync(markers.npm)).toBe(false);
    });
  });

  it('the scanned repo cannot trust itself via its own .rigscorerc.json', async () => {
    await withTmpDir(async (dir) => {
      const { repo, home, markers } = makeRepo(dir);
      fs.writeFileSync(
        path.join(repo, '.rigscorerc.json'),
        JSON.stringify({ plugins: ['./checks/local.js'], trustProjectPlugins: [repo] }),
      );
      await load({ cwd: repo, homedir: home });
      expect(fs.existsSync(markers.local)).toBe(false);
      expect(fs.existsSync(markers.npm)).toBe(false);
    });
  });

  it('a repo cannot trust itself through an extends base it points at', async () => {
    await withTmpDir(async (dir) => {
      const { repo, home, markers } = makeRepo(dir);
      fs.writeFileSync(path.join(dir, 'base.json'), JSON.stringify({ trustProjectPlugins: [repo] }));
      fs.writeFileSync(
        path.join(repo, '.rigscorerc.json'),
        JSON.stringify({ extends: path.join(dir, 'base.json'), plugins: ['./checks/local.js'] }),
      );
      await load({ cwd: repo, homedir: home });
      expect(fs.existsSync(markers.local)).toBe(false);
      expect(fs.existsSync(markers.npm)).toBe(false);
    });
  });

  it('plugins passed explicitly by the embedding caller still load', async () => {
    await withTmpDir(async (dir) => {
      const { repo, home, markers } = makeRepo(dir);
      const { checks } = await load({ cwd: repo, homedir: home, plugins: ['./checks/local.js'] });
      expect(checks.some((c) => c.id === 'sec1b-local')).toBe(true);
      expect(fs.existsSync(markers.local)).toBe(true);
      expect(fs.existsSync(markers.npm)).toBe(false);
    });
  });

  describe('loadTrustedPluginRoots', () => {
    it('returns [] with no home rc, and for a malformed one', async () => {
      await withTmpDir(async (home) => {
        expect(await loadTrustedPluginRoots(home)).toEqual([]);
        fs.writeFileSync(path.join(home, '.rigscorerc.json'), '{ not json');
        expect(await loadTrustedPluginRoots(home)).toEqual([]);
      });
    });

    it('expands ~/ against the home dir, resolves paths, and honours the home extends chain', async () => {
      await withTmpDir(async (home) => {
        fs.writeFileSync(path.join(home, 'base.json'), JSON.stringify({ trustProjectPlugins: ['/srv/a'] }));
        fs.writeFileSync(
          path.join(home, '.rigscorerc.json'),
          JSON.stringify({ extends: './base.json', trustProjectPlugins: ['~/code/b', 7, ''] }),
        );
        const roots = await loadTrustedPluginRoots(home);
        expect(roots).toEqual([path.resolve('/srv/a'), path.join(home, 'code', 'b')]);
      });
    });
  });
});

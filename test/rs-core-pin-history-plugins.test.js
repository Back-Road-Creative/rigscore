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
      const checks = await loadChecks({ cwd: dir });
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

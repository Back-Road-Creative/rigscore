import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../src/index.js';
import { computeServerHash, verifyState, STATE_FILENAME, STATE_VERSION } from '../src/state.js';
import { withTmpDir } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '..', 'bin', 'rigscore.js');
const CLEAN_FIXTURE = path.join(__dirname, 'fixtures', 'verify-state-clean');
const DRIFT_FIXTURE = path.join(__dirname, 'fixtures', 'verify-state-drift');
const MEMORY = { command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory@1.0.0'], transport: 'stdio' };

function seed(dir, servers, pinned) {
  fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: servers }));
  if (pinned) {
    fs.writeFileSync(path.join(dir, STATE_FILENAME), JSON.stringify({ version: STATE_VERSION, mcpServers: pinned }));
  }
}

/** Pin every server in `servers` — the state a prior `rigscore` scan would have written. */
const pinAll = (servers) => Object.fromEntries(
  Object.entries(servers).map(([n, s]) => [n, computeServerHash(s)]),
);

const runCli = (dir) => spawnSync('node', [BIN, '--verify-state', dir], {
  encoding: 'utf-8',
  env: { ...process.env, NO_COLOR: '1' },
});

describe('--verify-state — CLI gate', () => {
  it('exits 0 when every pinned server still matches its pin', () => {
    const res = runCli(CLEAN_FIXTURE);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/PASS/);
    expect(res.stdout).toMatch(/memory/);
  });
  it('exits non-zero on a mutated command, naming the server and both hashes', () => {
    const res = runCli(DRIFT_FIXTURE);
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/DRIFT/);
    expect(res.stdout).toMatch(/memory/);
    // Both hashes + the current shape must be shown — "drift" alone is not actionable.
    expect(res.stdout).toContain(computeServerHash(MEMORY).slice(0, 16));
    expect(res.stdout).toContain('current command: node');
  });
  it('never rewrites the state file (a rewrite would erase the evidence)', () => {
    const statePath = path.join(DRIFT_FIXTURE, STATE_FILENAME);
    const before = fs.readFileSync(statePath, 'utf-8');
    runCli(DRIFT_FIXTURE);
    expect(fs.readFileSync(statePath, 'utf-8')).toBe(before);
  });
  it('registers --verify-state as a boolean flag, default false', () => {
    expect(parseArgs([]).verifyState).toBe(false);
    expect(parseArgs(['--verify-state']).verifyState).toBe(true);
  });
});

describe('verifyState() — drift classification', () => {
  it('flags a changed command / args / envKeys as drift, reusing the pin hash function', async () => {
    for (const mutation of [
      { ...MEMORY, command: 'node' },
      { ...MEMORY, args: [...MEMORY.args, '--allow-all'] },
      { ...MEMORY, env: { GITHUB_TOKEN: 'x' } },
    ]) {
      await withTmpDir(async (dir) => {
        seed(dir, { memory: mutation }, pinAll({ memory: MEMORY }));
        const r = await verifyState(dir);
        expect(r).toMatchObject({ status: 'drift', exitCode: 1 });
        expect(r.changed.map((c) => c.name)).toEqual(['memory']);
        // One hashing path only: the reported hashes ARE computeServerHash's.
        expect(r.changed[0].currentHash).toBe(computeServerHash(mutation));
        expect(r.changed[0].pinnedHash).toBe(computeServerHash(MEMORY));
      });
    }
  });
  it('passes when the shape is untouched', async () => {
    await withTmpDir(async (dir) => {
      seed(dir, { memory: MEMORY }, pinAll({ memory: MEMORY }));
      const r = await verifyState(dir);
      expect(r).toMatchObject({ status: 'verified', exitCode: 0 });
      expect(r.matched).toEqual(['memory']);
    });
  });
  it('exits 2 when MCP servers exist but nothing is pinned — the gate cannot verify', async () => {
    await withTmpDir(async (dir) => {
      seed(dir, { memory: MEMORY }, null);
      expect(await verifyState(dir)).toMatchObject({ status: 'unpinned', exitCode: 2 });
    });
  });
  it('exits 0 when there is nothing to pin (no .mcp.json, no state file)', async () => {
    await withTmpDir(async (dir) => {
      expect(await verifyState(dir)).toMatchObject({ status: 'not-applicable', exitCode: 0 });
    });
  });
  it('exits 2 on a corrupt state file rather than silently passing', async () => {
    await withTmpDir(async (dir) => {
      seed(dir, { memory: MEMORY }, null);
      fs.writeFileSync(path.join(dir, STATE_FILENAME), '{ not json');
      expect(await verifyState(dir)).toMatchObject({ status: 'corrupt', exitCode: 2 });
    });
  });
  it('reports an ADDED server without failing — a new server is re-approved, not rug-pulled', async () => {
    await withTmpDir(async (dir) => {
      seed(dir, { memory: MEMORY, fresh: { command: 'uvx', args: ['x'] } }, pinAll({ memory: MEMORY }));
      const r = await verifyState(dir);
      expect(r).toMatchObject({ status: 'verified', exitCode: 0 });
      expect(r.added.map((a) => a.name)).toEqual(['fresh']);
    });
  });
  it('reports a REMOVED server without failing — a deleted server cannot execute', async () => {
    await withTmpDir(async (dir) => {
      seed(dir, {}, pinAll({ memory: MEMORY }));
      const r = await verifyState(dir);
      expect(r).toMatchObject({ status: 'verified', exitCode: 0 });
      expect(r.removed.map((x) => x.name)).toEqual(['memory']);
    });
  });
  it('still fails on drift when a server is added in the same commit', async () => {
    await withTmpDir(async (dir) => {
      seed(dir, { memory: { ...MEMORY, command: 'node' }, fresh: { command: 'uvx' } }, pinAll({ memory: MEMORY }));
      const r = await verifyState(dir);
      expect(r.exitCode).toBe(1);
      expect(r.added.map((a) => a.name)).toEqual(['fresh']);
    });
  });
});

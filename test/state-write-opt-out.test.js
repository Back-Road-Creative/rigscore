import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../src/index.js';
import { scan } from '../src/scanner.js';
import check from '../src/checks/mcp-config.js';
import { computeServerHash, verifyState, STATE_FILENAME, STATE_VERSION } from '../src/state.js';
import { withTmpDir } from './helpers.js';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'rigscore.js');
const defaultConfig = { paths: { mcpConfig: [] }, network: { safeHosts: ['127.0.0.1', 'localhost', '::1'] } };
const SERVER = { command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory@1.0.0'], env: {} };
const DISABLED = 'mcp-config/state-write-disabled';

const statePath = (dir) => path.join(dir, STATE_FILENAME);
const seedMcp = (dir, servers = { memory: SERVER }) =>
  fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: servers }));
const pin = (dir, servers) =>
  fs.writeFileSync(statePath(dir), JSON.stringify({
    version: STATE_VERSION,
    mcpServers: Object.fromEntries(Object.entries(servers).map(([n, s]) => [n, computeServerHash(s)])),
  }));

const scanMcp = (cwd, options = {}) =>
  scan({ cwd, homedir: '/tmp/nonexistent', checkFilter: 'mcp-config', ...options });
const mcpFindings = (result) => result.results.find((r) => r.id === 'mcp-config').findings;
// Spawn the real CLI with an isolated HOME so home-dir client configs can't perturb the run.
const runCli = (dir, args, home) => spawnSync('node', [BIN, dir, '--check', 'mcp-config', ...args], {
  encoding: 'utf-8',
  env: { ...process.env, NO_COLOR: '1', HOME: home, USERPROFILE: home },
});

describe('--no-state-write — opting out of the TOFU pin write', () => {
  it('parseArgs recognizes --no-state-write (default: off)', () => {
    expect(parseArgs([]).noStateWrite).toBe(false);
    expect(parseArgs(['--no-state-write']).noStateWrite).toBe(true);
  });

  it('a scan with the opt-out writes NO state file and DISCLOSES that pinning is off', async () => {
    await withTmpDir(async (dir) => {
      seedMcp(dir);
      const result = await scanMcp(dir, { writeState: false });

      expect(fs.existsSync(statePath(dir))).toBe(false);
      const disclosure = mcpFindings(result).find((f) => f.findingId === DISABLED);
      expect(disclosure).toBeDefined();
      // WARNING, not INFO: INFO is hidden unless --verbose, and a scan that
      // stopped pinning must not look like a scan that is pinning.
      expect(disclosure.severity).toBe('warning');
    });
  });

  it('end-to-end: the CLI flag suppresses the write and prints the disclosure', async () => {
    await withTmpDir(async (home) => {
      await withTmpDir(async (dir) => {
        seedMcp(dir);
        const res = runCli(dir, ['--no-state-write'], home);
        expect(fs.existsSync(statePath(dir))).toBe(false);
        expect(res.stdout).toMatch(/pinning/i);
        expect(res.stdout).toMatch(/--no-state-write/);
      });
    });
  });

  it('the disclosure is INFO — not a false alarm — when every server is already pinned', async () => {
    await withTmpDir(async (dir) => {
      seedMcp(dir);
      pin(dir, { memory: SERVER });
      const before = fs.readFileSync(statePath(dir), 'utf-8');

      const result = await scanMcp(dir, { writeState: false });
      const disclosure = mcpFindings(result).find((f) => f.findingId === DISABLED);
      // The pin is current: the write would have been skipped anyway, so the
      // flag cost this run nothing. Say so, don't cry wolf.
      expect(disclosure.severity).toBe('info');
      expect(fs.readFileSync(statePath(dir), 'utf-8')).toBe(before);
    });
  });
});

describe('--no-state-write does not disable anything else', () => {
  it('DEFAULT (no flag): a scan still establishes the TOFU pin', async () => {
    await withTmpDir(async (dir) => {
      seedMcp(dir);
      const result = await scanMcp(dir);
      expect(JSON.parse(fs.readFileSync(statePath(dir), 'utf-8')).mcpServers.memory)
        .toBe(computeServerHash(SERVER));
      expect(mcpFindings(result).find((f) => f.findingId === DISABLED)).toBeUndefined();
    });
  });

  it('end-to-end DEFAULT: the CLI still writes the pin when the flag is absent', async () => {
    await withTmpDir(async (home) => {
      await withTmpDir(async (dir) => {
        seedMcp(dir);
        runCli(dir, [], home);
        expect(fs.existsSync(statePath(dir))).toBe(true);
      });
    });
  });

  it('drift is still DETECTED and still NOT re-pinned under the opt-out (PR #252 invariant)', async () => {
    await withTmpDir(async (dir) => {
      seedMcp(dir);
      pin(dir, { memory: SERVER });
      const originalPin = fs.readFileSync(statePath(dir), 'utf-8');

      // Rug-pull: same server name, new command.
      seedMcp(dir, { memory: { ...SERVER, command: 'node' } });
      const result = await check.run({ cwd: dir, homedir: '/tmp/nonexistent', config: defaultConfig, writeState: false });

      expect(result.findings.find((f) => f.findingId === 'mcp-config/server-hash-drift')).toBeDefined();
      expect(fs.readFileSync(statePath(dir), 'utf-8')).toBe(originalPin);
      expect((await verifyState(dir)).status).toBe('drift');
    });
  });

  it('--verify-state is unaffected: it still fails a repo the opt-out left unpinned', async () => {
    await withTmpDir(async (dir) => {
      seedMcp(dir);
      await scanMcp(dir, { writeState: false });
      // No pin was created, so the read-only CI gate refuses to report success.
      const report = await verifyState(dir);
      expect(report.status).toBe('unpinned');
      expect(report.exitCode).toBe(2);
    });
  });

  it('--verify-state still verifies a pinned repo after an opt-out scan', async () => {
    await withTmpDir(async (dir) => {
      seedMcp(dir);
      pin(dir, { memory: SERVER });
      await scanMcp(dir, { writeState: false });
      const report = await verifyState(dir);
      expect(report.status).toBe('verified');
      expect(report.exitCode).toBe(0);
    });
  });

  it('the other mcp-config findings still fire under the opt-out', async () => {
    await withTmpDir(async (dir) => {
      seedMcp(dir, { bad: { command: 'npx', args: ['-y', 'server-filesystem', '/'], env: {} } });
      const result = await check.run({ cwd: dir, homedir: '/tmp/nonexistent', config: defaultConfig, writeState: false });
      expect(result.findings.find((f) => f.findingId === 'mcp-config/broad-filesystem-access')).toBeDefined();
      expect(result.findings.find((f) => f.findingId === 'mcp-config/unpinned-npx-package')).toBeDefined();
    });
  });
});

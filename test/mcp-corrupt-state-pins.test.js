import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import check from '../src/checks/mcp-config.js';
import { computeServerHash, STATE_FILENAME, STATE_VERSION } from '../src/state.js';
import { withTmpDir } from './helpers.js';

const defaultConfig = { paths: { mcpConfig: [] }, network: { safeHosts: ['127.0.0.1', 'localhost', '::1'] } };
const CORRUPT = 'mcp-config/state-file-corrupted';
const SERVER = { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem@1.0.0'], env: {} };
const RUNTIME_PINS = {
  filesystem: { runtimeToolHash: 'a'.repeat(64), runtimeToolPinnedAt: '2026-01-01T00:00:00.000Z' },
};

// The realistic trigger: a git MERGE CONFLICT in the pin (two branches both re-pinned)
// leaves conflict markers behind, and the file stops parsing.
const CONFLICTED = '<<<<<<< HEAD\n{ "version": 1 }\n=======\n{ "version": 1 }\n>>>>>>> theirs\n';

const statePath = (dir) => path.join(dir, STATE_FILENAME);
const readState = (dir) => JSON.parse(fs.readFileSync(statePath(dir), 'utf-8'));
const seedMcp = (dir) =>
  fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { filesystem: SERVER } }));
const goodPin = () => JSON.stringify({
  version: STATE_VERSION,
  mcpServers: { filesystem: computeServerHash(SERVER) },
  servers: RUNTIME_PINS,
}, null, 2);

const scan = (dir) => check.run({ cwd: dir, homedir: '/tmp/nonexistent', config: defaultConfig });
const corruptFinding = (result) => result.findings.find((f) => f.findingId === CORRUPT);

/** A temp dir that IS a git repo, with a `commit()` to snapshot its current contents at HEAD. */
async function withTmpGitRepo(callback) {
  await withTmpDir(async (dir) => {
    const git = (...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf-8' });
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');
    await callback(dir, () => { git('add', '-A'); git('commit', '-qm', 'seed', '--no-verify'); });
  });
}

// A scan re-mints the config-shape pin (`mcpServers`) from `.mcp.json` — deliberate, and
// cheap to redo. The runtime tool pins (`servers[name].runtimeToolHash`) are NOT: rigscore
// refuses to execute an MCP server, so only a human with that server's `tools/list` output
// can recreate them. Dropping them silently turns OFF CVE-2025-54136 rug-pull detection
// (`rigscore mcp-verify <name>` then exits 3) — so a corrupt state file must try HEAD first,
// and must SAY which of the two outcomes the operator got.
describe('a corrupt state file never silently destroys the runtime tool pins', () => {
  it('recovers the pins from the copy committed at HEAD, and says so (INFO)', async () => {
    await withTmpGitRepo(async (dir, commit) => {
      seedMcp(dir);
      fs.writeFileSync(statePath(dir), goodPin());
      commit(); // HEAD now carries the human-reviewed runtime tool pin.

      fs.writeFileSync(statePath(dir), CONFLICTED); // merge conflict — unparseable
      const result = await scan(dir);

      const finding = corruptFinding(result);
      expect(finding).toBeDefined();
      expect(finding.severity).toBe('info');
      expect(finding.remediation).toMatch(/recover/i);

      // The pins survived the scan — mcp-verify still has a baseline to compare against.
      const state = readState(dir);
      expect(state.servers.filesystem.runtimeToolHash).toBe(RUNTIME_PINS.filesystem.runtimeToolHash);
      expect(state.mcpServers.filesystem).toBe(computeServerHash(SERVER));
    });
  });

  it('WARNS that the pins are lost when no committed copy can supply them', async () => {
    await withTmpGitRepo(async (dir, commit) => {
      seedMcp(dir);
      commit(); // .mcp.json is committed; the pin never was.

      fs.writeFileSync(statePath(dir), CONFLICTED);
      const result = await scan(dir);

      const finding = corruptFinding(result);
      expect(finding).toBeDefined();
      // WARNING, not INFO: INFO is hidden unless --verbose, and rug-pull detection is now
      // OFF for any server that was pinned. "No action needed" would be a lie.
      expect(finding.severity).toBe('warning');
      expect(finding.title).toMatch(/lost/i);
      // A scan cannot regenerate these — the remediation must hand over the re-pin recipe.
      expect(finding.remediation).toMatch(/mcp-pin/);
      expect(finding.remediation).toMatch(/mcp-hash/);

      expect(readState(dir).servers).toBeUndefined();
    });
  });

  it('outside a git repo there is nothing to recover from — same WARNING, and no throw', async () => {
    await withTmpDir(async (dir) => {
      seedMcp(dir);
      fs.writeFileSync(statePath(dir), CONFLICTED);

      const result = await scan(dir);
      const finding = corruptFinding(result);
      expect(finding).toBeDefined();
      expect(finding.severity).toBe('warning');
      expect(finding.title).toMatch(/lost/i);
      expect(finding.remediation).toMatch(/mcp-pin/);

      // The reset still happens — the scan stays usable, it just stops lying about the cost.
      expect(readState(dir).mcpServers.filesystem).toBe(computeServerHash(SERVER));
    });
  });

  it('keeps the finding id stable across both arms (SARIF ruleIds are a public contract)', async () => {
    await withTmpDir(async (dir) => {
      seedMcp(dir);
      fs.writeFileSync(statePath(dir), CONFLICTED);
      const ids = (await scan(dir)).findings.map((f) => f.findingId);
      expect(ids).toContain(CORRUPT);
      expect(ids.filter((id) => id && id.startsWith('mcp-config/state-file'))).toEqual([CORRUPT]);
    });
  });
});

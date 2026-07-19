/**
 * Codex CLI reads a COMMITTED `.codex/config.toml` as well as the `$HOME` one, and its
 * `[mcp_servers.<name>]` tables are ordinary servers — command/args/env. Registering only
 * the home copy made the committed file a total blind spot: no rug-pull pin (CVE-2025-54136),
 * no AI-BOM component, no env-secret scan. An attacker could add or mutate a server in a
 * reviewed-once repo file and nothing drifted.
 *
 * The registration was blocked on one thing: `repoMcpRelPaths()` means "exactly what the pin
 * covers", and every repo-level consumer read JSON only. These tests hold the three consumers
 * to the format-dispatching `readMcpConfig()` seam, so the declared path is genuinely covered.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import check from '../src/checks/mcp-config.js';
import { computeServerHash, verifyState, STATE_FILENAME } from '../src/state.js';
import { repoMcpRelPaths, repoMcpEnvValues } from '../src/clients.js';
import { readJsonSafe, readFileSafe } from '../src/utils.js';
import { formatCycloneDx } from '../src/cyclonedx.js';
import { withTmpDir } from './helpers.js';

const defaultConfig = { paths: { mcpConfig: [] }, network: { safeHosts: ['127.0.0.1', 'localhost', '::1'] } };

const REL = '.codex/config.toml';
const CLEAN = { command: 'npx', args: ['-y', 'mcp-docs@1.0.0'], env: { API_TOKEN: 'sk-live-codexrepotoken' } };

/** The same server, as Codex really writes it: a `[mcp_servers.<name>]` table. */
const toml = (command) => `[mcp_servers.docs]
command = "${command}"
args = ["-y", "mcp-docs@1.0.0"]
env = { API_TOKEN = "sk-live-codexrepotoken" }
`;

function write(dir, rel, body) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body));
}

const scan = (dir) => check.run({ cwd: dir, homedir: path.join(dir, 'nohome'), config: defaultConfig });
const readPin = (dir) => JSON.parse(fs.readFileSync(path.join(dir, STATE_FILENAME), 'utf-8')).mcpServers;

describe('committed .codex/config.toml is a first-class repo-level MCP config', () => {
  it('is declared in the pin SSOT', () => {
    expect(repoMcpRelPaths()).toContain(REL);
  });

  it('a scan mints a pin for the servers its TOML declares', async () => {
    await withTmpDir(async (dir) => {
      write(dir, REL, toml('npx'));
      await scan(dir);
      expect(readPin(dir)).toEqual({ docs: computeServerHash(CLEAN) });
    });
  });

  it('a rug-pulled server is DETECTED by --verify-state (drift, exit 1)', async () => {
    await withTmpDir(async (dir) => {
      write(dir, REL, toml('npx'));
      await scan(dir); // trust-on-first-use pin
      write(dir, REL, toml('bash')); // attacker swaps the command in the committed file
      const r = await verifyState(dir);
      expect(r.status).toBe('drift');
      expect(r.exitCode).toBe(1);
      expect(r.changed.map(c => c.name)).toEqual(['docs']);
    });
  });

  it('its env values are reachable by repoMcpEnvValues (env-exposure input)', async () => {
    await withTmpDir(async (dir) => {
      write(dir, REL, toml('npx'));
      const found = await repoMcpEnvValues(dir, { readJson: readJsonSafe, readText: readFileSafe });
      expect(found.find(e => e.relPath === REL)?.values).toEqual(['sk-live-codexrepotoken']);
    });
  });

  it('appears in the CycloneDX AI-BOM as an mcp-server component', async () => {
    await withTmpDir(async (dir) => {
      write(dir, REL, toml('npx'));
      const bom = await formatCycloneDx({ score: 90 }, { cwd: dir });
      const server = bom.components.find(c => c['bom-ref'] === 'mcp-server:docs');
      expect(server, '.codex/config.toml server missing from the BOM').toBeDefined();
      expect(server.externalReferences).toContainEqual(
        { type: 'configuration', url: REL, comment: 'MCP server declaration' });
    });
  });

  it('REGRESSION: an existing JSON config hashes EXACTLY as before — no pin invalidation', async () => {
    await withTmpDir(async (dir) => {
      const server = { command: 'node', args: ['fs.js'] };
      write(dir, '.mcp.json', { mcpServers: { fs: server } });
      await scan(dir);
      expect(readPin(dir)).toEqual({ fs: computeServerHash(server) });
      expect((await verifyState(dir)).status).toBe('verified');
    });
  });
});

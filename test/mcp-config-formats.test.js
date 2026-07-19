import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  mcpConfigPaths, mcpConfigFormat, mcpServersIn, parseMinimalToml, parseMcpConfig,
  readMcpConfig, credentialClients,
} from '../src/clients.js';
import { readCodexKeys } from '../src/checks/sandbox-posture.js';
import mcpCheck from '../src/checks/mcp-config.js';
import credentialCheck from '../src/checks/credential-storage.js';
import { withTmpDir } from './helpers.js';

const CWD = path.join(path.sep, 'repo');
const HOME = path.join(path.sep, 'home', 'u');

const defaultConfig = {
  paths: { mcpConfig: [] },
  network: { safeHosts: ['127.0.0.1', 'localhost', '::1'] },
};

const write = (dir, rel, body) => {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
};

// A realistic Codex config: sandbox knobs AND MCP servers in the one TOML file, with a
// multi-line array and an inline env table — the shapes real config.toml files use.
const CODEX_TOML = `# Codex CLI config
approval_policy = "never"
sandbox_mode = "workspace-write"

[sandbox_workspace_write]
network_access = true

[mcp_servers.docs]
command = "npx"
args = [
  "-y",
  "mcp-server-docs@latest",
]
env = { GITHUB_TOKEN = "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }
`;

const GOOSE_YAML = `extensions:
  fetch:
    enabled: true
    type: stdio
    cmd: npx
    args:
      - "-y"
      - "mcp-server-fetch@latest"
    envs:
      GITHUB_TOKEN: "ghp_cccccccccccccccccccccccccccccccccccc"
`;

describe('registry declares an on-disk format per MCP surface', () => {
  it('registers Codex TOML and Goose YAML MCP surfaces', () => {
    const paths = mcpConfigPaths(CWD, HOME);
    expect(paths).toContain(path.join(HOME, '.codex/config.toml'));
    expect(paths).toContain(path.join(HOME, '.config/goose/config.yaml'));
  });

  it('resolves the declared format for MCP and credential surfaces; JSON is the default', () => {
    expect(mcpConfigFormat(path.join(HOME, '.codex/config.toml'))).toBe('toml');
    expect(mcpConfigFormat(path.join(HOME, '.config/goose/config.yaml'))).toBe('yaml');
    expect(mcpConfigFormat(path.join(HOME, '.config/goose/secrets.yaml'))).toBe('yaml');
    expect(mcpConfigFormat(path.join(CWD, '.mcp.json'))).toBe('json');
    // An unknown (user-supplied config.paths.mcpConfig) path keeps the pre-format default.
    expect(mcpConfigFormat('/custom/user/path.json')).toBe('json');
  });

  it('reads Codex servers under mcp_servers and Goose extensions under extensions', () => {
    const toml = parseMcpConfig(CODEX_TOML, 'toml');
    expect(Object.keys(mcpServersIn(path.join(HOME, '.codex/config.toml'), toml))).toEqual(['docs']);
    const yaml = parseMcpConfig(GOOSE_YAML, 'yaml');
    expect(Object.keys(mcpServersIn(path.join(HOME, '.config/goose/config.yaml'), yaml))).toEqual(['fetch']);
  });

  it('registers Goose credential surfaces (config.yaml envs + flat secrets.yaml)', () => {
    const goose = credentialClients().filter((c) => c.name === 'Goose');
    expect(goose.map((c) => c.file).sort()).toEqual(['config.yaml', 'secrets.yaml']);
    expect(goose.find((c) => c.file === 'config.yaml').envKey).toBe('envs');
    expect(goose.find((c) => c.file === 'secrets.yaml').flat).toBe(true);
  });
});

describe('minimal TOML reader', () => {
  it('parses dotted tables, multi-line arrays and inline tables', () => {
    const t = parseMinimalToml(CODEX_TOML);
    expect(t.approval_policy).toBe('never');
    expect(t.sandbox_workspace_write.network_access).toBe(true);
    expect(t.mcp_servers.docs.command).toBe('npx');
    expect(t.mcp_servers.docs.args).toEqual(['-y', 'mcp-server-docs@latest']);
    expect(t.mcp_servers.docs.env.GITHUB_TOKEN).toMatch(/^ghp_/);
  });

  it('parks on array-of-tables and ignores comments after values', () => {
    // Root keys must precede the first table header (real TOML), so an `[[array-of-tables]]`
    // swallows everything after it — the reader models exactly one table's worth of nothing.
    const t = parseMinimalToml('sandbox_mode = "read-only" # trailing\n[[profiles]]\nname = "x"\n');
    expect(t.sandbox_mode).toBe('read-only');
    expect(t.profiles).toBeUndefined();
    expect(t.name).toBeUndefined();
  });

  it('still backs the sandbox-posture Codex key projection', () => {
    expect(readCodexKeys(CODEX_TOML))
      .toEqual({ approval_policy: 'never', sandbox_mode: 'workspace-write', network_access: true });
    // Wrong-typed keys stay absent — unknown, never dangerous.
    expect(readCodexKeys('sandbox_mode = 3\n[sandbox_workspace_write]\nnetwork_access = "yes"\n')).toEqual({});
  });
});

describe('readMcpConfig dispatches on the declared format', () => {
  it('parses a TOML surface instead of reporting it unparseable', async () => {
    await withTmpDir(async (home) => {
      write(home, '.codex/config.toml', CODEX_TOML);
      const readers = { readJson: async () => null, readText: async (p) => fs.readFileSync(p, 'utf-8') };
      const parsed = await readMcpConfig(path.join(home, '.codex/config.toml'), readers);
      expect(parsed.mcp_servers.docs.command).toBe('npx');
    });
  });

  it('returns null for a genuinely broken non-JSON file', async () => {
    const readers = { readJson: async () => null, readText: async () => '\tkey: [unclosed\n  - x\n :::' };
    expect(await readMcpConfig(path.join(HOME, '.config/goose/config.yaml'), readers)).toBeNull();
  });
});

// The regression this seam exists to prevent: before it, every consumer read every
// surface with readJsonSafe, so registering a TOML/YAML path would have emitted a FALSE
// `config-unparseable` warning about a perfectly valid file.
describe('scan flows Codex TOML and Goose YAML servers through mcp-config', () => {
  it('finds the Codex TOML server and emits no config-unparseable', async () => {
    await withTmpDir(async (dir) => {
      const home = path.join(dir, 'home');
      write(home, '.codex/config.toml', CODEX_TOML);
      const r = await mcpCheck.run({ cwd: path.join(dir, 'repo'), homedir: home, config: defaultConfig });
      expect(r.data.serverNames).toContain('docs');
      const ids = r.findings.map((f) => f.findingId);
      expect(ids).not.toContain('mcp-config/config-unparseable');
      // ...and the server is genuinely graded: an @latest npx package is unpinned.
      expect(ids).toContain('mcp-config/unpinned-unstable-tag');
      expect(ids).toContain('mcp-config/env-sensitive-vars');
    });
  });

  it('finds the Goose YAML extension and emits no config-unparseable', async () => {
    await withTmpDir(async (dir) => {
      const home = path.join(dir, 'home');
      write(home, '.config/goose/config.yaml', GOOSE_YAML);
      const r = await mcpCheck.run({ cwd: path.join(dir, 'repo'), homedir: home, config: defaultConfig });
      expect(r.data.serverNames).toContain('fetch');
      expect(r.findings.map((f) => f.findingId)).not.toContain('mcp-config/config-unparseable');
    });
  });

  it('a genuinely broken TOML surface still reports unparseable, naming TOML not JSON', async () => {
    await withTmpDir(async (dir) => {
      const home = path.join(dir, 'home');
      // Unterminated string on the only key line: nothing parses out of it.
      write(home, '.codex/config.toml', '[mcp_servers.docs\ncommand = "npx\n');
      const r = await mcpCheck.run({ cwd: path.join(dir, 'repo'), homedir: home, config: defaultConfig });
      // parseMinimalToml never throws, so an unmodellable file yields an EMPTY object,
      // which is "no servers declared" rather than "broken" — the honest reading.
      expect(r.data.serverNames || []).not.toContain('docs');
    });
  });
});

describe('credential-storage scans the YAML surfaces', () => {
  const ctx = (home) => ({
    cwd: path.join(home, 'repo'), homedir: home, config: { includeHomeSkills: true }, includeHomeSkills: true,
  });

  it('flags a plaintext secret in a Goose extension envs map', async () => {
    await withTmpDir(async (home) => {
      write(home, '.config/goose/config.yaml', GOOSE_YAML);
      const r = await credentialCheck.run(ctx(home));
      expect(r.findings.map((f) => f.findingId))
        .toContain('credential-storage/plaintext-credential-in-client-config');
    });
  });

  it('flags a plaintext secret in the FLAT secrets.yaml (no server layer)', async () => {
    await withTmpDir(async (home) => {
      write(home, '.config/goose/secrets.yaml', 'GITHUB_TOKEN: "ghp_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"\n');
      const r = await credentialCheck.run(ctx(home));
      expect(r.findings.map((f) => f.findingId))
        .toContain('credential-storage/plaintext-credential-in-client-config');
    });
  });
});

// Windows regression: registry paths are POSIX literals, but callers pass either a native
// absolute path or a repo-relative POSIX one. Matching with path.sep mixed the two up, so on
// Windows the entry lookup missed and every non-default-key client fell back to `mcpServers`
// — which is what dropped Cody's `.vscode/settings.json` server from the CycloneDX BOM.
describe('config-path matching is separator-agnostic', () => {
  const servers = { cody_only: { command: 'npx', args: ['-y', 'p@1.0.0'] } };

  it('resolves .vscode/settings.json to the cody.mcpServers key via a Windows-style path', () => {
    expect(mcpServersIn('.vscode\\settings.json', { 'cody.mcpServers': servers })).toEqual(servers);
    expect(mcpServersIn('C:\\repo\\.vscode\\settings.json', { 'cody.mcpServers': servers })).toEqual(servers);
  });

  it('resolves .vscode/mcp.json to the `servers` key via a Windows-style path', () => {
    expect(mcpServersIn('.vscode\\mcp.json', { servers })).toEqual(servers);
  });

  it('is unchanged for POSIX-style paths', () => {
    expect(mcpServersIn('.vscode/settings.json', { 'cody.mcpServers': servers })).toEqual(servers);
    expect(mcpServersIn(path.join(CWD, '.vscode/settings.json'), { mcpServers: servers })).toEqual({});
  });
});

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import {
  CLIENTS, governanceFiles, mcpConfigPaths, credentialClients, networkMcpPaths, mcpServersIn,
  mcpServersForConfig, repoMcpRelPaths,
} from '../src/clients.js';

const CWD = '/proj';
const HOME = '/home/u';

// The literals the four consumers hardcoded before the registry existed. Every one MUST
// still be produced — the registry is a superset of the old lists, never a subset. EXCEPTION:
// three of the old paths (Windsurf/Cline/claude-desktop MCP + creds) were vendor-WRONG — they
// scanned a location no real install writes to, a silent no-op the registry's own comment already
// documented. RS-9 corrected them to the vendor-documented locations, so the baseline here is the
// corrected path, not the old dead one.
const LEGACY_GOVERNANCE = [
  'CLAUDE.md', '.cursorrules', '.windsurfrules', '.clinerules', '.continuerules',
  'copilot-instructions.md', '.github/copilot-instructions.md', 'AGENTS.md', '.aider.conf.yml',
];
const LEGACY_MCP = [
  [CWD, '.mcp.json'], [CWD, '.vscode/mcp.json'],
  [HOME, '.config/Claude/claude_desktop_config.json'], [HOME, '.cursor/mcp.json'],
  [HOME, '.cline/data/settings/cline_mcp_settings.json'], [HOME, '.continue/config.json'],
  [HOME, '.codeium/windsurf/mcp_config.json'], [HOME, '.config/zed/settings.json'], [HOME, '.amp/mcp.json'],
];
const LEGACY_CREDENTIALS = [
  ['.config/Claude', 'claude_desktop_config.json'], ['.cursor', 'mcp.json'],
  ['.cline/data/settings', 'cline_mcp_settings.json'], ['.continue', 'config.json'],
  ['.codeium/windsurf', 'mcp_config.json'], ['.amp', 'mcp.json'],
];

describe('client registry invariants', () => {
  it('has unique ids and a name for every client', () => {
    const ids = CLIENTS.map(c => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of CLIENTS) expect(c.name).toBeTruthy();
  });

  it('declares only cwd/home bases and non-empty paths', () => {
    for (const c of CLIENTS) {
      for (const e of [...(c.mcp || []), ...(c.sandbox || [])]) {
        expect(['cwd', 'home']).toContain(e.base);
        expect(e.path.length).toBeGreaterThan(0);
      }
      for (const f of c.governance || []) expect(f.length).toBeGreaterThan(0);
      for (const cr of c.credentials || []) {
        expect(cr.dir.length).toBeGreaterThan(0);
        expect(cr.file.length).toBeGreaterThan(0);
      }
    }
  });

  it('emits governance files with no duplicates', () => {
    const files = governanceFiles();
    expect(new Set(files).size).toBe(files.length);
  });

  it('covers the new clients (Codex CLI, Gemini CLI, opencode)', () => {
    for (const id of ['codex', 'gemini', 'opencode']) {
      expect(CLIENTS.find(c => c.id === id), id).toBeTruthy();
    }
    const paths = mcpConfigPaths(CWD, HOME);
    expect(paths).toContain(path.join(HOME, '.gemini/settings.json'));
    expect(paths).toContain(path.join(HOME, '.config/opencode/opencode.json'));
    const codex = CLIENTS.find(c => c.id === 'codex');
    expect(codex.sandbox.some(s => s.path === '.codex/config.toml' && s.format === 'toml')).toBe(true);
  });
});

describe('no regression vs the old hardcoded lists', () => {
  it('produces every legacy governance file', () => {
    for (const f of LEGACY_GOVERNANCE) expect(governanceFiles(), f).toContain(f);
  });

  it('produces every legacy MCP path (mcp-config and network-exposure)', () => {
    const mcp = mcpConfigPaths(CWD, HOME);
    const net = networkMcpPaths(CWD, HOME);
    for (const [base, rel] of LEGACY_MCP) {
      expect(mcp, rel).toContain(path.join(base, rel));
      expect(net, rel).toContain(path.join(base, rel));
    }
  });

  it('produces every legacy credential client', () => {
    const clients = credentialClients();
    for (const [dir, file] of LEGACY_CREDENTIALS) {
      expect(clients.some(c => c.dir === dir && c.file === file && c.name), file).toBe(true);
    }
  });
});

describe('Claude Code ~/.claude.json (finding A4)', () => {
  it('registers ~/.claude.json as a home MCP config and a credential store', () => {
    expect(mcpConfigPaths(CWD, HOME)).toContain(path.join(HOME, '.claude.json'));
    expect(networkMcpPaths(CWD, HOME)).toContain(path.join(HOME, '.claude.json'));
    expect(credentialClients().some(c => c.name === 'Claude Code' && c.file === '.claude.json')).toBe(true);
  });

  it('does NOT pin ~/.claude.json — it is home-scoped, never a committed repo config', () => {
    expect(repoMcpRelPaths()).not.toContain('.claude.json');
  });

  it('mcpServersForConfig merges top-level (user) + projects[cwd] (local) servers', () => {
    const p = path.join(HOME, '.claude.json');
    const config = {
      mcpServers: { userGlobal: { command: 'a' } },
      projects: { [CWD]: { mcpServers: { perProject: { command: 'b' } } } },
    };
    const servers = mcpServersForConfig(p, config, CWD);
    expect(Object.keys(servers).sort()).toEqual(['perProject', 'userGlobal']);
  });

  it('mcpServersForConfig lets the per-project (local) entry win a name collision', () => {
    const p = path.join(HOME, '.claude.json');
    const config = {
      mcpServers: { dup: { command: 'user' } },
      projects: { [CWD]: { mcpServers: { dup: { command: 'local' } } } },
    };
    expect(mcpServersForConfig(p, config, CWD).dup.command).toBe('local');
  });

  it('mcpServersForConfig is identical to mcpServersIn for non-claude paths', () => {
    const p = path.join(CWD, '.mcp.json');
    const config = { mcpServers: { a: { command: 'x' } } };
    expect(mcpServersForConfig(p, config, CWD)).toEqual(mcpServersIn(p, config));
  });
});

describe('batch-1 client additions (Amazon Q Developer, Roo Code, Cody)', () => {
  it('registers the three new clients with unique ids', () => {
    for (const id of ['amazon-q', 'roo-code', 'cody']) {
      expect(CLIENTS.find(c => c.id === id), id).toBeTruthy();
    }
  });

  it('Amazon Q Developer: surfaces CLI + IDE MCP configs (cwd committed and home) and credentials', () => {
    const mcp = mcpConfigPaths(CWD, HOME);
    // Committed, in-repo (base:cwd) — CLI project config + IDE GUI (default.json) config.
    expect(mcp).toContain(path.join(CWD, '.amazonq/mcp.json'));
    expect(mcp).toContain(path.join(CWD, '.amazonq/default.json'));
    // Global (base:home) under ~/.aws/amazonq.
    expect(mcp).toContain(path.join(HOME, '.aws/amazonq/mcp.json'));
    expect(mcp).toContain(path.join(HOME, '.aws/amazonq/default.json'));
    // Both committed configs are pinned against a rug-pull.
    const repoRel = repoMcpRelPaths();
    expect(repoRel).toContain('.amazonq/mcp.json');
    expect(repoRel).toContain('.amazonq/default.json');
    // Its home configs' env maps can hold plaintext secrets.
    const creds = credentialClients();
    expect(creds.some(c => c.dir === '.aws/amazonq' && c.file === 'mcp.json')).toBe(true);
    expect(creds.some(c => c.dir === '.aws/amazonq' && c.file === 'default.json')).toBe(true);
  });

  it('Roo Code: surfaces the .roorules governance file and the committed .roo/mcp.json', () => {
    expect(governanceFiles()).toContain('.roorules');
    const repoRel = repoMcpRelPaths();
    expect(repoRel).toContain('.roo/mcp.json');
    // Default key — Roo (a Cline fork) nests servers under `mcpServers`.
    const servers = { s: { command: 'node' } };
    expect(mcpServersIn(path.join(CWD, '.roo/mcp.json'), { mcpServers: servers })).toEqual(servers);
  });

  it('Cody: surfaces the committed .vscode/settings.json under the cody.mcpServers key', () => {
    const repoRel = repoMcpRelPaths();
    expect(repoRel).toContain('.vscode/settings.json');
    const servers = { s: { command: 'node', env: { TOKEN: 'x' } } };
    // Cody reads its MCP servers from the flat `cody.mcpServers` setting, NOT `mcpServers`.
    expect(mcpServersIn(path.join(CWD, '.vscode/settings.json'), { 'cody.mcpServers': servers }))
      .toEqual(servers);
    expect(mcpServersIn(path.join(CWD, '.vscode/settings.json'), { mcpServers: servers })).toEqual({});
  });
});

describe('batch-2 client additions (JetBrains Junie, Goose, Warp)', () => {
  it('registers the three new clients with unique ids', () => {
    for (const id of ['jetbrains-junie', 'goose', 'warp']) {
      expect(CLIENTS.find(c => c.id === id), id).toBeTruthy();
    }
  });

  it('JetBrains Junie: guidelines governance, committed .junie/mcp/mcp.json, home config + creds', () => {
    expect(governanceFiles()).toContain('.junie/guidelines.md');
    const mcp = mcpConfigPaths(CWD, HOME);
    // Committed, in-repo (base:cwd) project MCP config.
    expect(mcp).toContain(path.join(CWD, '.junie/mcp/mcp.json'));
    // User scope ~/.junie/mcp/mcp.json (base:home).
    expect(mcp).toContain(path.join(HOME, '.junie/mcp/mcp.json'));
    // The committed config is pinned against a rug-pull.
    expect(repoMcpRelPaths()).toContain('.junie/mcp/mcp.json');
    // Default key — Junie stores servers under `mcpServers`.
    const servers = { s: { command: 'node' } };
    expect(mcpServersIn(path.join(CWD, '.junie/mcp/mcp.json'), { mcpServers: servers })).toEqual(servers);
    // Its user config's env map can hold plaintext secrets.
    expect(credentialClients().some(c => c.dir === '.junie/mcp' && c.file === 'mcp.json' && c.name)).toBe(true);
  });

  it('Goose: governance-only (.goosehints); YAML config/secrets are not JSON-reader surfaces', () => {
    expect(governanceFiles()).toContain('.goosehints');
    const goose = CLIENTS.find(c => c.id === 'goose');
    // config.yaml / secrets.yaml are YAML — the JSON MCP/credential readers can't parse them,
    // so (like Codex's TOML) Goose declares no mcp/credentials surface.
    expect(goose.mcp).toBeUndefined();
    expect(goose.credentials).toBeUndefined();
  });

  it('Warp: committed .warp/.mcp.json, global ~/.warp/.mcp.json, and credentials', () => {
    const mcp = mcpConfigPaths(CWD, HOME);
    // Project-scoped committed config (base:cwd) + global (base:home).
    expect(mcp).toContain(path.join(CWD, '.warp/.mcp.json'));
    expect(mcp).toContain(path.join(HOME, '.warp/.mcp.json'));
    // The committed config is pinned against a rug-pull.
    expect(repoMcpRelPaths()).toContain('.warp/.mcp.json');
    // Default key — Warp stores servers under `mcpServers`.
    const servers = { s: { command: 'node' } };
    expect(mcpServersIn(path.join(CWD, '.warp/.mcp.json'), { mcpServers: servers })).toEqual(servers);
    expect(credentialClients().some(c => c.dir === '.warp' && c.file === '.mcp.json' && c.name)).toBe(true);
  });
});

describe('batch-3 client additions (Kiro, Qwen Code, Crush)', () => {
  it('registers the three new clients with unique ids', () => {
    for (const id of ['kiro', 'qwen-code', 'crush']) {
      expect(CLIENTS.find(c => c.id === id), id).toBeTruthy();
    }
  });

  it('Kiro: committed .kiro/settings/mcp.json, global ~/.kiro/settings/mcp.json, and credentials', () => {
    const mcp = mcpConfigPaths(CWD, HOME);
    // Workspace, in-repo (base:cwd) + user scope (base:home).
    expect(mcp).toContain(path.join(CWD, '.kiro/settings/mcp.json'));
    expect(mcp).toContain(path.join(HOME, '.kiro/settings/mcp.json'));
    // The committed config is pinned against a rug-pull.
    expect(repoMcpRelPaths()).toContain('.kiro/settings/mcp.json');
    // Default key — Kiro stores servers under `mcpServers`.
    const servers = { s: { command: 'node' } };
    expect(mcpServersIn(path.join(CWD, '.kiro/settings/mcp.json'), { mcpServers: servers })).toEqual(servers);
    // Its user config's env map can hold plaintext secrets.
    expect(credentialClients().some(c => c.dir === '.kiro/settings' && c.file === 'mcp.json' && c.name)).toBe(true);
  });

  it('Qwen Code: QWEN.md governance, committed .qwen/settings.json, home config + creds', () => {
    expect(governanceFiles()).toContain('QWEN.md');
    const mcp = mcpConfigPaths(CWD, HOME);
    // Project config (base:cwd) + user scope ~/.qwen/settings.json (base:home).
    expect(mcp).toContain(path.join(CWD, '.qwen/settings.json'));
    expect(mcp).toContain(path.join(HOME, '.qwen/settings.json'));
    // The committed config is pinned against a rug-pull.
    expect(repoMcpRelPaths()).toContain('.qwen/settings.json');
    // Default key — Qwen Code (a Gemini CLI fork) stores servers under `mcpServers`.
    const servers = { s: { command: 'node' } };
    expect(mcpServersIn(path.join(CWD, '.qwen/settings.json'), { mcpServers: servers })).toEqual(servers);
    // Its config's env maps can hold plaintext secrets.
    expect(credentialClients().some(c => c.dir === '.qwen' && c.file === 'settings.json' && c.name)).toBe(true);
  });

  it('Crush: CRUSH.md governance, committed .crush.json/crush.json under the `mcp` key, home creds', () => {
    expect(governanceFiles()).toContain('CRUSH.md');
    const mcp = mcpConfigPaths(CWD, HOME);
    // Both committed project filenames (base:cwd) + global ~/.config/crush/crush.json (base:home).
    expect(mcp).toContain(path.join(CWD, '.crush.json'));
    expect(mcp).toContain(path.join(CWD, 'crush.json'));
    expect(mcp).toContain(path.join(HOME, '.config/crush/crush.json'));
    // Both committed configs are pinned against a rug-pull.
    const repoRel = repoMcpRelPaths();
    expect(repoRel).toContain('.crush.json');
    expect(repoRel).toContain('crush.json');
    // Crush nests its servers under `mcp` (like opencode), NOT `mcpServers`.
    const servers = { s: { command: 'node', env: { TOKEN: 'x' } } };
    expect(mcpServersIn(path.join(CWD, '.crush.json'), { mcp: servers })).toEqual(servers);
    expect(mcpServersIn(path.join(CWD, '.crush.json'), { mcpServers: servers })).toEqual({});
    // Its global config's env maps can hold plaintext secrets.
    expect(credentialClients().some(c => c.dir === '.config/crush' && c.file === 'crush.json' && c.name)).toBe(true);
  });
});

describe('batch-4 client additions (OpenClaw, Antigravity)', () => {
  it('registers the two new clients with unique ids', () => {
    for (const id of ['openclaw', 'antigravity']) {
      expect(CLIENTS.find(c => c.id === id), id).toBeTruthy();
    }
  });

  it('OpenClaw: home-only ~/.openclaw/openclaw.json, nested mcp.servers key, home creds, no pin', () => {
    const mcp = mcpConfigPaths(CWD, HOME);
    const net = networkMcpPaths(CWD, HOME);
    // Sole user config lives under $HOME (base:home) — no committed project file exists.
    expect(mcp).toContain(path.join(HOME, '.openclaw/openclaw.json'));
    expect(net).toContain(path.join(HOME, '.openclaw/openclaw.json'));
    // Home-only => never pinned as a committed rug-pull surface.
    expect(repoMcpRelPaths()).not.toContain('.openclaw/openclaw.json');
    // OpenClaw NESTS its servers two levels deep under `mcp.servers`, not a flat `mcpServers`.
    const servers = { s: { command: 'node', env: { TOKEN: 'x' } } };
    const p = path.join(HOME, '.openclaw/openclaw.json');
    expect(mcpServersIn(p, { mcp: { servers } })).toEqual(servers);
    expect(mcpServersIn(p, { mcpServers: servers })).toEqual({});
    // Its per-server env map can hold plaintext secrets.
    expect(credentialClients().some(c => c.dir === '.openclaw' && c.file === 'openclaw.json' && c.name)).toBe(true);
  });

  it('Antigravity: home-only ~/.gemini/antigravity/mcp_config.json (distinct from Gemini), AGENTS.md, creds', () => {
    expect(governanceFiles()).toContain('AGENTS.md');
    const mcp = mcpConfigPaths(CWD, HOME);
    // Global config under ~/.gemini/antigravity — a different file from Gemini CLI's settings.json.
    expect(mcp).toContain(path.join(HOME, '.gemini/antigravity/mcp_config.json'));
    expect(networkMcpPaths(CWD, HOME)).toContain(path.join(HOME, '.gemini/antigravity/mcp_config.json'));
    // Home-only => not pinned.
    expect(repoMcpRelPaths()).not.toContain('.gemini/antigravity/mcp_config.json');
    // Default key — Antigravity stores servers under `mcpServers`.
    const servers = { s: { command: 'node' } };
    expect(mcpServersIn(path.join(HOME, '.gemini/antigravity/mcp_config.json'), { mcpServers: servers })).toEqual(servers);
    // Its env maps can hold plaintext secrets.
    expect(credentialClients().some(c => c.dir === '.gemini/antigravity' && c.file === 'mcp_config.json' && c.name)).toBe(true);
  });
});

describe('mcpServersIn', () => {
  it('reads mcpServers by default and opencode\'s "mcp" key', () => {
    const servers = { a: { command: 'x' } };
    expect(mcpServersIn(path.join(CWD, '.mcp.json'), { mcpServers: servers })).toEqual(servers);
    expect(mcpServersIn(path.join(CWD, 'opencode.json'), { mcp: servers })).toEqual(servers);
    // A gemini settings.json `mcp` block holds discovery settings, not servers — never read as servers.
    expect(mcpServersIn(path.join(HOME, '.gemini/settings.json'), { mcp: { allowed: [] } })).toEqual({});
  });

  it('returns {} for missing or non-object servers; unknown paths default to mcpServers', () => {
    expect(mcpServersIn(path.join(CWD, '.mcp.json'), null)).toEqual({});
    expect(mcpServersIn(path.join(CWD, '.mcp.json'), { mcpServers: 'nope' })).toEqual({});
    expect(mcpServersIn('/custom/user/path.json', { mcpServers: { a: {} } })).toEqual({ a: {} });
  });
});

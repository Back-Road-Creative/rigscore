import path from 'node:path';

/**
 * Single source of truth for every AI client rigscore knows about.
 * Imports nothing from rigscore (constants.js imports THIS — a back-import would be circular).
 *
 * Each record declares only the surfaces the client genuinely has:
 *   governance  — instruction files, resolved against the project root
 *   mcp         — JSON configs holding MCP servers: { path, base: 'cwd'|'home', key? }.
 *                 `key` defaults to 'mcpServers' (opencode nests its servers under 'mcp') and
 *                 may be an ARRAY when a client reads more than one key (VS Code documents
 *                 'servers'; 'mcpServers' is the widely copy-pasted alias). Earlier keys win.
 *                 `base: 'cwd'` means COMMITTED, in-repo — those are the configs a PR can
 *                 mutate, so they are exactly the ones the rug-pull pin covers (repoMcpPaths).
 *   credentials — $HOME configs whose MCP servers' env maps can hold plaintext secrets:
 *                 { dir, file, envKey? }. Servers are read through `mcpServersIn()`, so the
 *                 client's own `key` applies (Zed: `context_servers`). `envKey` defaults to
 *                 'env' (opencode nests its variables under 'environment').
 *   sandbox     — config declaring the agent's approval/sandbox boundary: { path, base, format }.
 *                 `format` picks the reader: 'toml' (Codex's approval_policy/sandbox_mode),
 *                 'json' (Claude Code's permissions.deny). Entries are listed in precedence
 *                 order — later files override/extend earlier ones.
 *
 * Paths for the three newest clients are from primary vendor docs:
 *   Codex CLI  developers.openai.com/codex/config-reference — ~/.codex/config.toml and project
 *              .codex/config.toml (approval_policy, sandbox_mode, [sandbox_workspace_write]
 *              network_access); reads AGENTS.md. Its MCP servers live in that TOML, so it has
 *              no `mcp` entry — the JSON readers cannot parse it.
 *   Gemini CLI github.com/google-gemini/gemini-cli — docs/tools/mcp-server.md (~/.gemini/settings.json,
 *              .gemini/settings.json, `mcpServers`), docs/cli/gemini-md.md (GEMINI.md).
 *   opencode   opencode.ai/docs/config (~/.config/opencode/opencode.json, project opencode.json,
 *              servers under `mcp`, env vars under `environment`) and opencode.ai/docs/rules
 *              (AGENTS.md).
 */
export const CLIENTS = [
  { id: 'claude-code', name: 'Claude Code', governance: ['CLAUDE.md'],
    mcp: [{ path: '.mcp.json', base: 'cwd' }],
    sandbox: [{ path: '.claude/settings.json', base: 'cwd', format: 'json' },
      { path: '.claude/settings.local.json', base: 'cwd', format: 'json' }] },
  { id: 'claude-desktop', name: 'Claude Desktop',
    mcp: [{ path: '.claude/claude_desktop_config.json', base: 'home' }],
    credentials: [{ dir: '.claude', file: 'claude_desktop_config.json' }] },
  { id: 'cursor', name: 'Cursor', governance: ['.cursorrules'],
    mcp: [{ path: '.cursor/mcp.json', base: 'home' }],
    credentials: [{ dir: '.cursor', file: 'mcp.json' }] },
  { id: 'windsurf', name: 'Windsurf', governance: ['.windsurfrules'],
    mcp: [{ path: '.windsurf/mcp.json', base: 'home' }],
    credentials: [{ dir: '.windsurf', file: 'mcp.json' }] },
  { id: 'cline', name: 'Cline', governance: ['.clinerules'],
    mcp: [{ path: '.cline/mcp_settings.json', base: 'home' }],
    credentials: [{ dir: '.cline', file: 'mcp_settings.json' }] },
  { id: 'continue', name: 'Continue', governance: ['.continuerules'],
    mcp: [{ path: '.continue/config.json', base: 'home' }],
    credentials: [{ dir: '.continue', file: 'config.json' }] },
  // VS Code's .vscode/mcp.json declares servers under `servers`, NOT `mcpServers`
  // (code.visualstudio.com/docs/copilot/customization/mcp-servers). Reading only the
  // default key made every real VS Code config scan as empty. `mcpServers` stays as a
  // second key: it is the alias people paste in from other clients, and a server sitting
  // in a committed file must never be a scanning or pinning blind spot either way.
  { id: 'copilot', name: 'GitHub Copilot',
    governance: ['copilot-instructions.md', '.github/copilot-instructions.md'],
    mcp: [{ path: '.vscode/mcp.json', base: 'cwd', key: ['servers', 'mcpServers'] }] },
  { id: 'codex', name: 'Codex CLI', governance: ['AGENTS.md'],
    sandbox: [{ path: '.codex/config.toml', base: 'home', format: 'toml' },
      { path: '.codex/config.toml', base: 'cwd', format: 'toml' }] },
  { id: 'aider', name: 'Aider', governance: ['.aider.conf.yml'] },
  { id: 'gemini', name: 'Gemini CLI', governance: ['GEMINI.md'],
    mcp: [{ path: '.gemini/settings.json', base: 'cwd' },
      { path: '.gemini/settings.json', base: 'home' }],
    credentials: [{ dir: '.gemini', file: 'settings.json' }] },
  { id: 'opencode', name: 'opencode', governance: ['AGENTS.md'],
    mcp: [{ path: 'opencode.json', base: 'cwd', key: 'mcp' },
      { path: '.config/opencode/opencode.json', base: 'home', key: 'mcp' }],
    credentials: [{ dir: '.config/opencode', file: 'opencode.json', envKey: 'environment' }] },
  { id: 'amp', name: 'Amp',
    mcp: [{ path: '.amp/mcp.json', base: 'home' }],
    credentials: [{ dir: '.amp', file: 'mcp.json' }] },
  // Zed nests its servers under `context_servers`; `~/.config/zed/settings.json` on both
  // Linux and macOS. Project `.zed/settings.json` is documented as editor/language options
  // only, so it holds no servers. zed-industries/zed docs/src/ai/mcp.md + configuring-zed.md.
  { id: 'zed', name: 'Zed',
    mcp: [{ path: '.config/zed/settings.json', base: 'home', key: 'context_servers' }],
    credentials: [{ dir: '.config/zed', file: 'settings.json' }] },
];

const DEFAULT_MCP_KEY = 'mcpServers';

/** Flattened MCP entries, each with an explicit `key`. */
function mcpEntries() {
  return CLIENTS.flatMap(c => (c.mcp || []).map(m => ({ ...m, key: m.key || DEFAULT_MCP_KEY })));
}

/** Every governance/instruction file any known client reads, de-duplicated. */
export function governanceFiles() {
  return [...new Set(CLIENTS.flatMap(c => c.governance || []))];
}

/** Absolute MCP config paths for every known client. */
export function mcpConfigPaths(cwd, homedir) {
  return mcpEntries().map(m => path.join(m.base === 'cwd' ? cwd : homedir, m.path));
}

/**
 * Absolute paths of the COMMITTED, repo-level MCP configs — every `base: 'cwd'` entry.
 *
 * The single source of truth for "which configs does the CVE-2025-54136 rug-pull pin
 * cover?" Both the minting side (checks/mcp-config.js) and the gate (state.js
 * verifyState) read it, so the two can never disagree about scope — a hardcoded
 * `.mcp.json` on either side is what let a rug-pull in `.gemini/settings.json` or
 * `opencode.json` pass with "0 pinned MCP server(s) verified".
 *
 * Home-dir configs are deliberately excluded: they are per-user, not committed, and
 * cannot be mutated by a pull request.
 *
 * Order is CLIENTS declaration order and is STABLE — server-name collisions across
 * configs are resolved by it (see readRepoServers).
 */
export function repoMcpPaths(cwd) {
  return mcpEntries().filter(m => m.base === 'cwd').map(m => path.join(cwd, m.path));
}

/** Same set — network-exposure historically scanned a subset; it now sees the union. */
export function networkMcpPaths(cwd, homedir) {
  return mcpConfigPaths(cwd, homedir);
}

/** $HOME client configs whose MCP servers' env maps can hold plaintext credentials. */
export function credentialClients() {
  return CLIENTS.flatMap(c => (c.credentials || []).map(cr => ({ name: c.name, ...cr })));
}

/**
 * Read the MCP server map out of a parsed config, honoring the owning client's key.
 * Unknown paths (e.g. user-supplied `config.paths.mcpConfig`) fall back to `mcpServers`.
 */
export function mcpServersIn(configPath, config) {
  if (!config || typeof config !== 'object') return {};
  const entry = mcpEntries().find(m => {
    const rel = path.normalize(m.path);
    return configPath === rel || configPath.endsWith(path.sep + rel);
  });
  // A client may read more than one key (VS Code: `servers`, plus the `mcpServers` alias).
  // Merge them, earliest key winning, so a multi-key client is read the way it runs.
  const out = {};
  for (const key of [entry?.key || DEFAULT_MCP_KEY].flat()) {
    const servers = config[key];
    if (!servers || typeof servers !== 'object') continue;
    for (const [name, server] of Object.entries(servers)) {
      if (!(name in out)) out[name] = server;
    }
  }
  return out;
}

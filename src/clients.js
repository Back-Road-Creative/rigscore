import path from 'node:path';

/**
 * Single source of truth for every AI client rigscore knows about.
 * Imports nothing from rigscore (constants.js imports THIS — a back-import would be circular).
 *
 * Each record declares only the surfaces the client genuinely has:
 *   governance  — instruction files, resolved against the project root
 *   mcp         — JSON configs holding MCP servers: { path, base: 'cwd'|'home', key? }.
 *                 `key` defaults to 'mcpServers' (opencode nests its servers under 'mcp').
 *   credentials — $HOME configs whose `mcpServers[].env` can hold plaintext secrets
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
 *              servers under `mcp`) and opencode.ai/docs/rules (AGENTS.md).
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
  { id: 'copilot', name: 'GitHub Copilot',
    governance: ['copilot-instructions.md', '.github/copilot-instructions.md'],
    mcp: [{ path: '.vscode/mcp.json', base: 'cwd' }] },
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
      { path: '.config/opencode/opencode.json', base: 'home', key: 'mcp' }] },
  { id: 'amp', name: 'Amp',
    mcp: [{ path: '.amp/mcp.json', base: 'home' }],
    credentials: [{ dir: '.amp', file: 'mcp.json' }] },
  { id: 'zed', name: 'Zed', mcp: [{ path: '.config/zed/settings.json', base: 'home' }] },
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

/** Same set — network-exposure historically scanned a subset; it now sees the union. */
export function networkMcpPaths(cwd, homedir) {
  return mcpConfigPaths(cwd, homedir);
}

/** $HOME client configs whose `mcpServers[].env` can hold plaintext credentials. */
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
  const servers = config[entry?.key || DEFAULT_MCP_KEY];
  return servers && typeof servers === 'object' ? servers : {};
}

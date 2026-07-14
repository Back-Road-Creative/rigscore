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
 *                 'json' (Claude Code's permissions.deny), 'gemini' (.gemini/settings.json
 *                 general.defaultApprovalMode), 'opencode' (opencode.json permission block),
 *                 'cursor' (.cursor/permissions.json terminal/mcp allowlists). Entries are
 *                 listed in precedence order — later files override/extend earlier ones.
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
  // Cursor reads a COMMITTED, project-level .cursor/mcp.json (it wins over the ~/.cursor/mcp.json
  // global) — cursor.com/docs/mcp. That committed file is a rug-pull surface, so it needs a
  // base:'cwd' entry too. Windsurf (~/.codeium/windsurf/mcp_config.json) and Cline
  // (~/.cline/data/settings/cline_mcp_settings.json) are global-only — no committed project MCP
  // file exists (cline/cline#2418 is still a proposal) — so neither gets a base:'cwd' entry.
  { id: 'cursor', name: 'Cursor', governance: ['.cursorrules'],
    mcp: [{ path: '.cursor/mcp.json', base: 'cwd' },
      { path: '.cursor/mcp.json', base: 'home' }],
    // .cursor/permissions.json is COMMITTED per-repo (cursor.com/docs/reference/permissions):
    // terminalAllowlist / mcpAllowlist. A "*" (or "*:*") wildcard auto-runs everything.
    sandbox: [{ path: '.cursor/permissions.json', base: 'home', format: 'cursor' },
      { path: '.cursor/permissions.json', base: 'cwd', format: 'cursor' }],
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
    sandbox: [{ path: '.gemini/settings.json', base: 'home', format: 'gemini' },
      { path: '.gemini/settings.json', base: 'cwd', format: 'gemini' }],
    credentials: [{ dir: '.gemini', file: 'settings.json' }] },
  { id: 'opencode', name: 'opencode', governance: ['AGENTS.md'],
    mcp: [{ path: 'opencode.json', base: 'cwd', key: 'mcp' },
      { path: '.config/opencode/opencode.json', base: 'home', key: 'mcp' }],
    sandbox: [{ path: '.config/opencode/opencode.json', base: 'home', format: 'opencode' },
      { path: 'opencode.json', base: 'cwd', format: 'opencode' }],
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
  // Amazon Q Developer (CLI + IDE). MCP servers under `mcpServers`:
  //   docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/command-line-mcp-config-CLI.html
  //   (~/.aws/amazonq/mcp.json global, .amazonq/mcp.json workspace) and mcp-ide.html (the
  //   IDE GUI now writes default.json; legacy mcp.json stays enabled). Project rules live in
  //   the .amazonq/rules/ DIRECTORY of arbitrarily-named markdown files
  //   (context-project-rules.html) — no single governance filename to declare, so it is omitted.
  { id: 'amazon-q', name: 'Amazon Q Developer',
    mcp: [{ path: '.amazonq/mcp.json', base: 'cwd' }, { path: '.amazonq/default.json', base: 'cwd' },
      { path: '.aws/amazonq/mcp.json', base: 'home' }, { path: '.aws/amazonq/default.json', base: 'home' }],
    credentials: [{ dir: '.aws/amazonq', file: 'mcp.json' }, { dir: '.aws/amazonq', file: 'default.json' }] },
  // Roo Code (VS Code extension, Cline-fork family). docs.roocode.com/features/mcp/using-mcp-in-roo
  // — project MCP is a committed `.roo/mcp.json` under `mcpServers`; the global config
  // (mcp_settings.json) lives in VS Code global storage, which has no stable ~/ path, so it and
  // its credentials surface are omitted. docs.roocode.com/features/custom-instructions — the
  // `.roo/rules/` directory of arbitrary files falls back to a single `.roorules` file (declared).
  { id: 'roo-code', name: 'Roo Code', governance: ['.roorules'],
    mcp: [{ path: '.roo/mcp.json', base: 'cwd' }] },
  // Cody (Sourcegraph). sourcegraph.com/docs/cody/capabilities/agentic-context-fetching — MCP
  // servers are read from the `cody.mcpServers` setting (a flat dotted key) in the editor's
  // settings.json; the committed VS Code workspace form is `.vscode/settings.json`. The global
  // user settings.json is at an OS-specific path (no stable ~/), so its credentials surface is
  // omitted; custom commands (.vscode/cody.json) were superseded by the server-side Prompt
  // Library, so there is no local governance file to declare.
  { id: 'cody', name: 'Cody',
    mcp: [{ path: '.vscode/settings.json', base: 'cwd', key: 'cody.mcpServers' }] },
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

// Directory-form rule sets modern clients read by DEFAULT. Unlike the single-file
// names in governanceFiles(), each of these is a DIRECTORY whose files are all
// governance rules — so a repo using ONLY `.cursor/rules/*.mdc` is governed, not
// "ungoverned". `.clinerules` appears in both worlds: the single-file form lives in
// governanceFiles(), the directory form here. Extension policy is vendor-exact:
// Cursor reads only *.mdc, Copilot only *.instructions.md; Windsurf and Cline treat
// every non-dotfile in the dir as a rule (ext: null).
const DEFAULT_GOVERNANCE_DIRS = [
  { dir: '.cursor/rules', ext: '.mdc' },
  { dir: '.windsurf/rules', ext: null },
  { dir: '.clinerules', ext: null },
  { dir: '.github/instructions', ext: '.instructions.md' },
];

/** Built-in directory-form governance rule sets, scanned by default (dir names). */
export function governanceDirDefaults() {
  return DEFAULT_GOVERNANCE_DIRS.map(d => d.dir);
}

/**
 * Does basename `name` count as a rule file inside governance dir `dir`? Known
 * default dirs apply their vendor extension; an unknown (user-configured) dir
 * accepts `.md`/`.mdc`. Dotfiles never count.
 */
export function isGovernanceDirRuleFile(dir, name) {
  const base = String(name).split(/[\\/]/).pop();
  if (!base || base.startsWith('.')) return false;
  const known = DEFAULT_GOVERNANCE_DIRS.find(d => d.dir === dir);
  if (known) return known.ext === null || base.endsWith(known.ext);
  return base.endsWith('.md') || base.endsWith('.mdc');
}

/** Absolute MCP config paths for every known client. */
export function mcpConfigPaths(cwd, homedir) {
  return mcpEntries().map(m => path.join(m.base === 'cwd' ? cwd : homedir, m.path));
}

/**
 * Repo-relative paths of the COMMITTED, repo-level MCP configs — every `base: 'cwd'` entry.
 * The single source of truth for what the CVE-2025-54136 rug-pull pin covers: the minting
 * side (checks/mcp-config.js), the gate (state.js) and the CycloneDX AI-BOM all read it, so
 * they cannot disagree about scope. A hardcoded `.mcp.json` on any of them is what let a
 * rug-pull in `.gemini/settings.json` or `opencode.json` pass with "0 pinned MCP server(s)
 * verified" — and what dropped a Gemini server from the shipped BOM.
 * Order is CLIENTS declaration order and is STABLE — name collisions resolve by it.
 */
export function repoMcpRelPaths() {
  return [...new Set(mcpEntries().filter(m => m.base === 'cwd').map(m => m.path))];
}

/** Same set, absolute against `cwd`. */
export function repoMcpPaths(cwd) {
  return repoMcpRelPaths().map(p => path.join(cwd, p));
}

/**
 * Env-map string values from every committed repo-level MCP config, grouped by
 * relative path. Each config's servers are resolved with mcpServersIn() (its own
 * key — `.vscode/mcp.json` reads `servers`, opencode reads `mcp`) and each server's
 * env map is read from `env` or, for opencode, `environment`. `readJson` is injected
 * (async path -> parsed object | null) so this module needs no filesystem or
 * child_process import. Paths in `skip` are omitted — env-exposure passes its raw-
 * scanned config list so a config covered there is not double-reported.
 * Consolidating the read here keeps MCP-server data out of any child_process-capable
 * module (see test/mcp-runtime-hash.test.js).
 */
export async function repoMcpEnvValues(cwd, readJson, skip = []) {
  const skipSet = new Set(skip);
  const out = [];
  for (const relPath of repoMcpRelPaths()) {
    if (skipSet.has(relPath)) continue;
    const config = await readJson(path.join(cwd, relPath));
    if (!config) continue;
    const values = [];
    for (const server of Object.values(mcpServersIn(relPath, config))) {
      if (!server || typeof server !== 'object') continue;
      for (const envKey of ['env', 'environment']) {
        const env = server[envKey];
        if (!env || typeof env !== 'object') continue;
        for (const value of Object.values(env)) {
          if (typeof value === 'string') values.push(value);
        }
      }
    }
    if (values.length) out.push({ relPath, values });
  }
  return out;
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

import path from 'node:path';
import YAML from 'yaml';

/**
 * Single source of truth for every AI client rigscore knows about.
 * Imports nothing from rigscore (constants.js imports THIS — a back-import would be circular).
 *
 * Each record declares only the surfaces the client genuinely has:
 *   governance  — instruction files, resolved against the project root
 *   mcp         — configs holding MCP servers: { path, base: 'cwd'|'home', key?, format? }.
 *                 `format` declares the ON-DISK LANGUAGE and defaults to 'json'; 'toml'
 *                 (Codex) and 'yaml' (Goose) are read by the same registry-driven loader
 *                 (`readMcpConfig`), so a non-JSON surface is parsed rather than reported
 *                 as `config-unparseable`. Registering a non-JSON path WITHOUT declaring
 *                 its format is the bug that seam exists to prevent.
 *                 `key` defaults to 'mcpServers' (opencode nests its servers under 'mcp') and
 *                 may be an ARRAY when a client reads more than one key (VS Code documents
 *                 'servers'; 'mcpServers' is the widely copy-pasted alias). Earlier keys win.
 *                 A DOTTED key (OpenClaw's 'mcp.servers') is walked as a nested path only when
 *                 no literal key of that exact name exists (keeps Cody's flat 'cody.mcpServers').
 *                 `base: 'cwd'` means COMMITTED, in-repo — those are the configs a PR can
 *                 mutate, so they are exactly the ones the rug-pull pin covers (repoMcpPaths).
 *   credentials — $HOME configs whose MCP servers' env maps can hold plaintext secrets:
 *                 { dir, file, envKey? }. Servers are read through `mcpServersForConfig()`
 *                 (a superset of `mcpServersIn()` that also resolves `~/.claude.json`'s
 *                 per-project `projects[<cwd>].mcpServers`), so the client's own `key`
 *                 applies (Zed: `context_servers`). `envKey` defaults to 'env' (opencode
 *                 nests its variables under 'environment'). `flat: true` marks a file that
 *                 is ITSELF one key→secret map with no server layer (Goose's secrets.yaml);
 *                 it is read as a single pseudo-server whose env map is the whole document.
 *   sandbox     — config declaring the agent's approval/sandbox boundary: { path, base, format }.
 *                 `format` picks the reader: 'toml' (Codex's approval_policy/sandbox_mode),
 *                 'json' (Claude Code's permissions.deny), 'gemini' (.gemini/settings.json
 *                 general.defaultApprovalMode), 'opencode' (opencode.json permission block),
 *                 'cursor' (.cursor/permissions.json terminal/mcp allowlists). Entries are
 *                 listed in precedence order — later files override/extend earlier ones.
 *   skillDirs   — directories of slash-command / skill / prompt files the client reads,
 *                 each { path, base: 'cwd'|'home' }. skill-files scans them for hijack/
 *                 exfil/escalation patterns; the `base:'home'` entries are gated behind
 *                 --include-home-skills (a home skill library is not the project's to fix).
 *
 * Paths for the three newest clients are from primary vendor docs:
 *   Codex CLI  developers.openai.com/codex/config-reference — ~/.codex/config.toml and project
 *              .codex/config.toml (approval_policy, sandbox_mode, [sandbox_workspace_write]
 *              network_access); reads AGENTS.md. Its MCP servers live in that same TOML under
 *              `[mcp_servers.<name>]`, declared with format:'toml'.
 *   Gemini CLI github.com/google-gemini/gemini-cli — docs/tools/mcp-server.md (~/.gemini/settings.json,
 *              .gemini/settings.json, `mcpServers`), docs/cli/gemini-md.md (GEMINI.md).
 *   opencode   opencode.ai/docs/config (~/.config/opencode/opencode.json, project opencode.json,
 *              servers under `mcp`, env vars under `environment`) and opencode.ai/docs/rules
 *              (AGENTS.md).
 */
export const CLIENTS = [
  // `~/.claude.json` is Claude Code's REAL user store (distinct from the committed
  // `.mcp.json` and from `.claude/` settings). It holds MCP servers in two places:
  // a top-level `mcpServers` (user scope) and `projects[<abs-cwd>].mcpServers` (local
  // scope, the default — servers Claude Code loads only for that repo). base:'home' so
  // its top-level servers reach the home-config scanners; the nested per-project map is
  // resolved by mcpServersForConfig() (the flat reader can't express it). NOT base:'cwd'
  // — a home file no PR can mutate, so it is deliberately outside the rug-pull pin.
  // Scopes/precedence: code.claude.com/docs/en/mcp "MCP installation scopes".
  { id: 'claude-code', name: 'Claude Code', governance: ['CLAUDE.md'],
    mcp: [{ path: '.mcp.json', base: 'cwd' },
      { path: '.claude.json', base: 'home' }],
    credentials: [{ dir: '.', file: '.claude.json' }],
    sandbox: [{ path: '.claude/settings.json', base: 'cwd', format: 'json' },
      { path: '.claude/settings.local.json', base: 'cwd', format: 'json' }],
    // `.claude/agents` holds subagent prompt files — the SAME hijack/exfil/escalation surface as
    // skills/commands, so skill-files must scan them too. The home entry is gated behind
    // --include-home-skills like the other home skillDirs.
    skillDirs: [{ path: '.claude/commands', base: 'cwd' }, { path: '.claude/skills', base: 'cwd' },
      { path: '.claude/agents', base: 'cwd' },
      { path: '.claude/commands', base: 'home' }, { path: '.claude/skills', base: 'home' },
      { path: '.claude/agents', base: 'home' }] },
  // Claude Desktop's config is ~/.config/Claude/claude_desktop_config.json on Linux (XDG) and
  // Windows (%APPDATA%\Claude\); macOS uses ~/Library/Application Support/Claude/, which no single
  // home-relative path can express — the Linux/XDG form is registered. The old
  // `.claude/claude_desktop_config.json` pointed at Claude CODE's dir, not Desktop's, so it
  // scanned nothing on any OS.
  { id: 'claude-desktop', name: 'Claude Desktop',
    mcp: [{ path: '.config/Claude/claude_desktop_config.json', base: 'home' }],
    credentials: [{ dir: '.config/Claude', file: 'claude_desktop_config.json' }] },
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
    mcp: [{ path: '.codeium/windsurf/mcp_config.json', base: 'home' }],
    credentials: [{ dir: '.codeium/windsurf', file: 'mcp_config.json' }],
    // Workflows are committed .windsurf/workflows/*.md slash-commands invoked as /<name>
    // (docs.windsurf.com/plugins/cascade/workflows) — project-scoped prompt files skill-files scans.
    skillDirs: [{ path: '.windsurf/workflows', base: 'cwd' }] },
  { id: 'cline', name: 'Cline', governance: ['.clinerules'],
    mcp: [{ path: '.cline/data/settings/cline_mcp_settings.json', base: 'home' }],
    credentials: [{ dir: '.cline/data/settings', file: 'cline_mcp_settings.json' }] },
  { id: 'continue', name: 'Continue', governance: ['.continuerules'],
    mcp: [{ path: '.continue/config.json', base: 'home' }],
    credentials: [{ dir: '.continue', file: 'config.json' }] },
  // VS Code's .vscode/mcp.json declares servers under `servers`, NOT `mcpServers`
  // (code.visualstudio.com/docs/copilot/customization/mcp-servers). Reading only the
  // default key made every real VS Code config scan as empty. `mcpServers` stays as a
  // second key: it is the alias people paste in from other clients, and a server sitting
  // in a committed file must never be a scanning or pinning blind spot either way.
  // Two MCP surfaces: the IDE's committed .vscode/mcp.json (`servers`) and the Copilot CLI's
  // ~/.copilot/mcp-config.json (`mcpServers` — a DIFFERENT top-level key; docs.github.com/en/
  // copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers). COPILOT_HOME can relocate the
  // CLI file, but ~/.copilot is the default; its per-server env maps hold credentials.
  { id: 'copilot', name: 'GitHub Copilot',
    governance: ['copilot-instructions.md', '.github/copilot-instructions.md'],
    mcp: [{ path: '.vscode/mcp.json', base: 'cwd', key: ['servers', 'mcpServers'] },
      { path: '.copilot/mcp-config.json', base: 'home' }],
    credentials: [{ dir: '.copilot', file: 'mcp-config.json' }] },
  // Custom prompts live ONLY in the Codex home dir ~/.codex/prompts (developers.openai.com/
  // codex/custom-prompts — "not shared through your repository"), so skillDirs is home-only.
  // MCP servers live in the SAME config.toml, under `[mcp_servers.<name>]`
  // (developers.openai.com/codex/config-reference § mcp_servers) — command/args/env, the
  // ordinary server shape, just in TOML. BOTH scopes are registered: the committed copy is a
  // reviewable repo file an attacker can mutate, so leaving it off made it a rug-pull blind
  // spot. Its `base:'cwd'` entry enters repoMcpRelPaths(), whose contract is "exactly what
  // the CVE-2025-54136 pin covers" — and that contract holds because every repo-level
  // consumer (state.js readRepoServers, cyclonedx.js, repoMcpEnvValues) now reads through
  // readMcpConfig(), which dispatches on this declared `format`.
  { id: 'codex', name: 'Codex CLI', governance: ['AGENTS.md'],
    mcp: [{ path: '.codex/config.toml', base: 'home', key: 'mcp_servers', format: 'toml' },
      { path: '.codex/config.toml', base: 'cwd', key: 'mcp_servers', format: 'toml' }],
    sandbox: [{ path: '.codex/config.toml', base: 'home', format: 'toml' },
      { path: '.codex/config.toml', base: 'cwd', format: 'toml' }],
    credentials: [{ dir: '.codex', file: 'config.toml', format: 'toml' }],
    skillDirs: [{ path: '.codex/prompts', base: 'home' }] },
  // Aider also reads a repo-root CONVENTIONS.md as coding-convention context
  // (aider.chat/docs/usage/conventions.html), in addition to its .aider.conf.yml.
  { id: 'aider', name: 'Aider', governance: ['.aider.conf.yml', 'CONVENTIONS.md'] },
  { id: 'gemini', name: 'Gemini CLI', governance: ['GEMINI.md'],
    mcp: [{ path: '.gemini/settings.json', base: 'cwd' },
      { path: '.gemini/settings.json', base: 'home' }],
    sandbox: [{ path: '.gemini/settings.json', base: 'home', format: 'gemini' },
      { path: '.gemini/settings.json', base: 'cwd', format: 'gemini' }],
    credentials: [{ dir: '.gemini', file: 'settings.json' }],
    // Custom commands: project .gemini/commands + user ~/.gemini/commands
    // (github.com/google-gemini/gemini-cli docs/cli/custom-commands.md).
    skillDirs: [{ path: '.gemini/commands', base: 'cwd' }, { path: '.gemini/commands', base: 'home' }] },
  { id: 'opencode', name: 'opencode', governance: ['AGENTS.md'],
    mcp: [{ path: 'opencode.json', base: 'cwd', key: 'mcp' },
      { path: '.config/opencode/opencode.json', base: 'home', key: 'mcp' }],
    sandbox: [{ path: '.config/opencode/opencode.json', base: 'home', format: 'opencode' },
      { path: 'opencode.json', base: 'cwd', format: 'opencode' }],
    credentials: [{ dir: '.config/opencode', file: 'opencode.json', envKey: 'environment' }],
    // Custom commands: project .opencode/commands + global ~/.config/opencode/commands
    // (opencode.ai/docs/commands — plural "commands").
    skillDirs: [{ path: '.opencode/commands', base: 'cwd' },
      { path: '.config/opencode/commands', base: 'home' }] },
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
  //   (context-project-rules.html) — governed as a directory-form rule set (see DEFAULT_GOVERNANCE_DIRS).
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
  // JetBrains Junie (the JetBrains AI coding agent). MCP servers under `mcpServers`:
  //   junie.jetbrains.com/docs/junie-cli-mcp-configuration.html — committed project config
  //   .junie/mcp/mcp.json (base:cwd; the docs warn about secrets when it is version-controlled)
  //   plus user scope ~/.junie/mcp/mcp.json (base:home), whose env maps hold credentials. Rules
  //   live in .junie/guidelines.md at the project root (junie.jetbrains.com/docs/guidelines-and-memory.html).
  { id: 'jetbrains-junie', name: 'JetBrains Junie', governance: ['.junie/guidelines.md'],
    mcp: [{ path: '.junie/mcp/mcp.json', base: 'cwd' },
      { path: '.junie/mcp/mcp.json', base: 'home' }],
    credentials: [{ dir: '.junie/mcp', file: 'mcp.json' }] },
  // Goose (Block). block.github.io/goose docs — project rules live in a committed .goosehints
  // file at the repo root (context-engineering/using-goosehints). Its extensions (MCP servers)
  // live under `extensions` in ~/.config/goose/config.yaml, each with its own `envs` map
  // (configuration/config-file); ~/.config/goose/secrets.yaml is a FLAT key→secret map with no
  // server layer, so it is declared `flat`. Both are YAML — declared format:'yaml'. Home only:
  // Goose documents no committed project MCP file, so there is nothing to pin.
  { id: 'goose', name: 'Goose', governance: ['.goosehints'],
    mcp: [{ path: '.config/goose/config.yaml', base: 'home', key: 'extensions', format: 'yaml' }],
    credentials: [{ dir: '.config/goose', file: 'config.yaml', envKey: 'envs', format: 'yaml' },
      { dir: '.config/goose', file: 'secrets.yaml', flat: true, format: 'yaml' }] },
  // Warp. docs.warp.dev/agent-platform/capabilities/mcp — MCP servers under `mcpServers` in a
  // committed project-scoped .warp/.mcp.json (base:cwd; project servers never auto-spawn, they
  // require explicit approval — exactly the rug-pull surface) plus the global ~/.warp/.mcp.json
  // (base:home), whose env maps hold credentials. No committed governance file is documented
  // (docs.warp.dev/terminal/settings/file-locations), so governance is omitted.
  { id: 'warp', name: 'Warp',
    mcp: [{ path: '.warp/.mcp.json', base: 'cwd' },
      { path: '.warp/.mcp.json', base: 'home' }],
    credentials: [{ dir: '.warp', file: '.mcp.json' }] },
  // Kiro (AWS's agentic IDE). MCP servers under `mcpServers`:
  //   kiro.dev/docs/mcp/configuration — committed workspace config .kiro/settings/mcp.json
  //   (base:cwd; a PR can mutate it, so it is a rug-pull surface) plus user scope
  //   ~/.kiro/settings/mcp.json (base:home), whose env maps hold credentials; workspace wins a
  //   merge collision. Steering rules live in the .kiro/steering/ DIRECTORY of arbitrarily-named
  //   markdown files (kiro.dev/docs/steering) — governed as a directory-form rule set
  //   (see DEFAULT_GOVERNANCE_DIRS, like Amazon Q's .amazonq/rules/).
  { id: 'kiro', name: 'Kiro',
    mcp: [{ path: '.kiro/settings/mcp.json', base: 'cwd' },
      { path: '.kiro/settings/mcp.json', base: 'home' }],
    credentials: [{ dir: '.kiro/settings', file: 'mcp.json' }] },
  // Qwen Code (Alibaba's Gemini-CLI fork). MCP servers under `mcpServers`:
  //   qwenlm.github.io/qwen-code-docs/en/users/configuration/settings — committed project
  //   .qwen/settings.json (base:cwd) plus user scope ~/.qwen/settings.json (base:home), whose env
  //   maps hold credentials. Reads QWEN.md for hierarchical context (`context.fileName`). Its
  //   approval boundary is `tools.approvalMode` (NOT Gemini's general.defaultApprovalMode), graded
  //   by the dedicated `qwen` sandbox reader (yolo → unrestricted, plan → restricted).
  { id: 'qwen-code', name: 'Qwen Code', governance: ['QWEN.md'],
    mcp: [{ path: '.qwen/settings.json', base: 'cwd' },
      { path: '.qwen/settings.json', base: 'home' }],
    sandbox: [{ path: '.qwen/settings.json', base: 'home', format: 'qwen' },
      { path: '.qwen/settings.json', base: 'cwd', format: 'qwen' }],
    credentials: [{ dir: '.qwen', file: 'settings.json' }] },
  // Crush (Charm's terminal coding agent). Like opencode, it nests servers under `mcp`:
  //   github.com/charmbracelet/crush — committed project config, read as .crush.json then
  //   crush.json (both base:cwd; either is a rug-pull surface) plus global
  //   ~/.config/crush/crush.json (base:home), whose per-server `env` maps hold credentials. Reads
  //   a project-root CRUSH.md for rules.
  { id: 'crush', name: 'Crush', governance: ['CRUSH.md'],
    mcp: [{ path: '.crush.json', base: 'cwd', key: 'mcp' },
      { path: 'crush.json', base: 'cwd', key: 'mcp' },
      { path: '.config/crush/crush.json', base: 'home', key: 'mcp' }],
    credentials: [{ dir: '.config/crush', file: 'crush.json' }] },
  // OpenClaw. docs.openclaw.ai/gateway/configuration-reference + cli/mcp — the sole user
  // config is ~/.openclaw/openclaw.json (home only; `openclaw mcp` reads/writes just this file,
  // no committed project config exists). Unlike every other JSON client its servers NEST under
  // `mcp.servers` (a two-level path, NOT a flat `mcpServers`), and each server's env map
  // (`mcp.servers.<name>.env`) can hold plaintext secrets — so it declares the nested key plus a
  // home credentials surface. No project-level file, so nothing to pin.
  { id: 'openclaw', name: 'OpenClaw',
    mcp: [{ path: '.openclaw/openclaw.json', base: 'home', key: 'mcp.servers' }],
    credentials: [{ dir: '.openclaw', file: 'openclaw.json' }] },
  // Google Antigravity (the agentic IDE; shares Gemini's config root). MCP servers under
  // `mcpServers` in the global ~/.gemini/antigravity/mcp_config.json — a DISTINCT file from
  // Gemini CLI's ~/.gemini/settings.json (github/github-mcp-server install-antigravity.md;
  // antigravity.google/docs/mcp). Home only — no committed project MCP file is documented, so
  // nothing to pin — but its env maps hold credentials. Reads AGENTS.md for project rules
  // (AGENTS.md → GEMINI.md precedence).
  { id: 'antigravity', name: 'Antigravity', governance: ['AGENTS.md'],
    mcp: [{ path: '.gemini/antigravity/mcp_config.json', base: 'home' }],
    credentials: [{ dir: '.gemini/antigravity', file: 'mcp_config.json' }] },
  // OpenHands (All-Hands-AI). Repository-wide agent instructions live in the committed
  // .openhands/microagents/repo.md (docs.all-hands.dev — repo microagent). Its MCP servers live in
  // a TOML config.toml ([mcp]); the JSON MCP readers can't parse it, so (like Codex/Goose) no mcp
  // entry is declared.
  { id: 'openhands', name: 'OpenHands', governance: ['.openhands/microagents/repo.md'] },
  // Kilo Code (Kilo-Org; a Cline/Roo-family VS Code agent). Project MCP is the COMMITTED
  // .kilocode/mcp.json under `mcpServers` (kilo.ai/docs/automate/mcp/using-in-kilo-code) — a
  // rug-pull surface. The global config lives in VS Code global storage (no stable ~/ path), so it
  // and its credentials surface are omitted (same stance as Roo Code).
  { id: 'kilo-code', name: 'Kilo Code',
    mcp: [{ path: '.kilocode/mcp.json', base: 'cwd' }] },
  // Trae (ByteDance's agentic IDE). Project rules are the committed .trae/rules/project_rules.md
  // (docs.trae.ai/ide/rules). MCP servers are configured in-app with no committed file, so none
  // is declared.
  { id: 'trae', name: 'Trae', governance: ['.trae/rules/project_rules.md'] },
  // Augment Code. Workspace Guidelines live in the committed .augment-guidelines file; Workspace
  // Rules live in the .augment/rules/ DIRECTORY (docs.augmentcode.com/setup-augment/guidelines) —
  // governed as a directory-form rule set (see DEFAULT_GOVERNANCE_DIRS).
  { id: 'augment', name: 'Augment Code', governance: ['.augment-guidelines'] },
  // Replit Agent reads a repo-root replit.md as its project context/governance file
  // (docs.replit.com — replit.md).
  { id: 'replit', name: 'Replit', governance: ['replit.md'] },
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

/**
 * Relative skill/command/prompt directories every known client reads at `base`,
 * de-duplicated. `base: 'cwd'` → project-level dirs (always scanned by skill-files);
 * `base: 'home'` → $HOME dirs, scanned only under --include-home-skills. A client with
 * no `skillDirs` surface contributes nothing. Order is CLIENTS declaration order and is
 * STABLE, so the Claude defaults (`.claude/commands`, `.claude/skills`) come first.
 */
export function skillDirsForBase(base) {
  return [...new Set(
    CLIENTS.flatMap(c => (c.skillDirs || []).filter(d => d.base === base).map(d => d.path)),
  )];
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
  { dir: '.amazonq/rules', ext: '.md' },
  { dir: '.kiro/steering', ext: '.md' },
  // JetBrains AI Assistant (distinct from Junie): project rules are .aiassistant/rules/*.md.
  { dir: '.aiassistant/rules', ext: '.md' },
  // Augment Code Workspace Rules: .augment/rules/*.md (its single-file .augment-guidelines is
  // declared on the `augment` client entry).
  { dir: '.augment/rules', ext: '.md' },
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
 * env map is read from `env` or, for opencode, `environment`. Both READERS are injected
 * (`readJson`, `readText` — same pair readMcpConfig takes) so this module needs no
 * filesystem or child_process import, and so a non-JSON repo surface (Codex's committed
 * `.codex/config.toml`) is parsed by its declared format instead of silently scanning as
 * empty — a credential in a TOML env table is a credential. Paths in `skip` are omitted —
 * env-exposure passes its raw-scanned config list so a config covered there is not
 * double-reported. Consolidating the read here keeps MCP-server data out of any
 * child_process-capable module (see test/mcp-runtime-hash.test.js).
 */
export async function repoMcpEnvValues(cwd, readers, skip = []) {
  const skipSet = new Set(skip);
  const out = [];
  for (const relPath of repoMcpRelPaths()) {
    if (skipSet.has(relPath)) continue;
    const config = await readMcpConfig(path.join(cwd, relPath), readers);
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
 * Resolve a client's server map by `key`. A key is normally a flat top-level key
 * (`mcpServers`, opencode's `mcp`) or a flat DOTTED key present literally (Cody's
 * `cody.mcpServers`, a real VS Code settings.json key). OpenClaw instead NESTS its servers
 * two levels deep under `mcp.servers`, which no flat lookup reaches. So: try the literal key
 * first (leaves Cody and every existing client byte-for-byte unchanged); only when a dotted
 * key has no literal object value do we walk the dotted path.
 */
function resolveServers(config, key) {
  const literal = config[key];
  if (literal && typeof literal === 'object') return literal;
  if (!key.includes('.')) return literal;
  let node = config;
  for (const seg of key.split('.')) {
    if (!node || typeof node !== 'object') return undefined;
    node = node[seg];
  }
  return node;
}

/**
 * Registry paths are declared POSIX-style; a caller's `configPath` may be either an
 * absolute NATIVE path (`path.join(cwd, rel)`) or a repo-relative POSIX one (cyclonedx.js
 * and the mcp-config fixer both pass `repoMcpRelPaths()` entries verbatim). Comparing with
 * `path.sep` mixed those two worlds up on Windows: `path.normalize('.vscode/settings.json')`
 * became `.vscode\settings.json`, which matched neither form of the POSIX literal, so the
 * entry lookup missed and every multi-key or non-default-key client silently fell back to
 * `mcpServers` — that is what dropped Cody's `.vscode/settings.json` server (key
 * `cody.mcpServers`) and VS Code's `servers` key from the AI-BOM on the Windows legs.
 * Comparing POSIX-normalized forms is separator-agnostic and identical on POSIX hosts.
 */
const toPosixPath = (p) => String(p).split('\\').join('/');

/** The registry MCP entry owning `configPath`, or undefined for an unknown path. */
function entryForPath(configPath) {
  const cp = toPosixPath(configPath);
  return mcpEntries().find(m => {
    const rel = toPosixPath(m.path);
    return cp === rel || cp.endsWith('/' + rel);
  });
}

/**
 * The declared on-disk FORMAT for a config path — 'json' (the default), 'toml' or 'yaml'.
 * Resolved from the registry over BOTH the `mcp` and `credentials` surfaces, so the two
 * readers can never disagree about how to parse the same file. An unknown path (a
 * user-supplied `config.paths.mcpConfig`) is 'json', which is what every consumer assumed
 * before formats existed.
 */
export function mcpConfigFormat(configPath) {
  const cp = toPosixPath(configPath);
  const declared = [
    ...CLIENTS.flatMap(c => (c.mcp || []).map(m => [m.path, m.format])),
    ...CLIENTS.flatMap(c => (c.credentials || []).map(cr => [path.posix.join(cr.dir, cr.file), cr.format])),
  ];
  for (const [rel, format] of declared) {
    const p = toPosixPath(rel);
    if (cp === p || cp.endsWith('/' + p)) return format || 'json';
  }
  return 'json';
}

/**
 * Read + parse one client config, dispatching on its DECLARED format. This is the single
 * seam that lets a TOML or YAML surface be registered at all: every consumer used to call
 * `readJsonSafe` directly, so a non-JSON path would have parsed as null and been reported
 * as `config-unparseable` — a false warning, i.e. a regression rather than a no-op.
 *
 * Readers are INJECTED (`readJson` for JSONC-tolerant JSON, `readText` for raw text) rather
 * than imported, because src/utils.js imports THIS module — a back-import would be circular —
 * and because it keeps clients.js free of any filesystem import (same stance as
 * repoMcpEnvValues). Returns the parsed object, or null for absent/unparseable.
 */
export async function readMcpConfig(configPath, { readJson, readText }) {
  const format = mcpConfigFormat(configPath);
  if (format === 'json') return readJson(configPath);
  const text = await readText(configPath);
  if (typeof text !== 'string') return null;
  return parseMcpConfig(text, format);
}

/** Parse config `text` in a non-JSON declared format. Unparseable → null. */
export function parseMcpConfig(text, format) {
  try {
    const parsed = format === 'toml' ? parseMinimalToml(text)
      : format === 'yaml' ? YAML.parse(text)
        : null;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Read the MCP server map out of a parsed config, honoring the owning client's key.
 * Unknown paths (e.g. user-supplied `config.paths.mcpConfig`) fall back to `mcpServers`.
 */
export function mcpServersIn(configPath, config) {
  if (!config || typeof config !== 'object') return {};
  const entry = entryForPath(configPath);
  // A client may read more than one key (VS Code: `servers`, plus the `mcpServers` alias).
  // Merge them, earliest key winning, so a multi-key client is read the way it runs.
  const out = {};
  for (const key of [entry?.key || DEFAULT_MCP_KEY].flat()) {
    const servers = resolveServers(config, key);
    if (!servers || typeof servers !== 'object') continue;
    for (const [name, server] of Object.entries(servers)) {
      if (!(name in out)) out[name] = server;
    }
  }
  return out;
}

const CLAUDE_JSON = '.claude.json';

/** True only for Claude Code's user store `~/.claude.json` (never the `.claude/` dir configs). */
function isClaudeJsonPath(configPath) {
  return configPath === CLAUDE_JSON || configPath.endsWith(path.sep + CLAUDE_JSON);
}

/**
 * MCP server map for a config, resolving Claude Code's `~/.claude.json` two-place layout:
 * a top-level `mcpServers` (user scope) PLUS `projects[<abs-cwd>].mcpServers` (local scope —
 * the servers Claude Code actually loads in the repo at `cwd`). The flat `{path,base,key}`
 * reader (mcpServersIn) models only the top level, so the per-project map was invisible to
 * the home-config scanners. For `~/.claude.json` this merges both — the per-project (local)
 * entry wins a name collision, matching Claude Code's local > user precedence. Every other
 * path is the plain mcpServersIn() read, unchanged, so it is a safe drop-in at any call site.
 */
export function mcpServersForConfig(configPath, config, cwd) {
  const base = mcpServersIn(configPath, config);
  if (!isClaudeJsonPath(configPath) || !config || typeof config !== 'object') return base;
  const perProject = config.projects?.[cwd]?.mcpServers;
  if (!perProject || typeof perProject !== 'object') return base;
  return { ...base, ...perProject };
}

// ── Minimal TOML reader ─────────────────────────────────────────────────────
// Codex keeps BOTH its sandbox knobs and its MCP servers in one config.toml, so rigscore
// needs to read TOML in two places. Rather than take a TOML dependency (or duplicate the
// targeted scalar reader that already lived in checks/sandbox-posture.js), the shared reader
// is hoisted HERE — clients.js is the leaf module every consumer already imports, and it
// imports nothing from rigscore, so no consumer can create a cycle by using it.
//
// It is deliberately NOT a conforming TOML parser. It models `[dotted.table]` headers,
// `key = value` pairs, single- and multi-line arrays, and single-line inline tables — the
// whole of what an `[mcp_servers.<name>]` block or a sandbox knob uses. Anything outside
// that (array-of-tables `[[x]]`, multi-line strings, dates) is skipped and reads as absent,
// which every consumer already treats as "unknown, never dangerous".

/** Split a dotted TOML key path into segments, unquoting each. */
function splitTomlKey(key) {
  return (key.match(/"[^"]*"|'[^']*'|[^.\s]+/g) || []).map(unquoteToml);
}

function unquoteToml(s) {
  const t = String(s).trim();
  const q = t[0];
  return (q === '"' || q === "'") && t.endsWith(q) && t.length > 1 ? t.slice(1, -1) : t;
}

/** True when every `[`/`{` in `s` is closed — quote-aware, so brackets in strings don't count. */
function bracketsBalanced(s) {
  let depth = 0;
  let quote = null;
  for (const ch of s) {
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') depth--;
  }
  return depth <= 0;
}

/** Split a bracketed body on top-level commas, ignoring commas inside strings/nesting. */
function splitTopLevel(body) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let current = '';
  for (const ch of body) {
    if (quote) { current += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    if (ch === '[' || ch === '{') depth++;
    if (ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) { parts.push(current); current = ''; continue; }
    current += ch;
  }
  parts.push(current);
  return parts.map(p => p.trim()).filter(Boolean);
}

/** One TOML right-hand side → a JS value. Unmodelled shapes → undefined (unknown). */
export function parseTomlValue(rhs) {
  const s = String(rhs).trim();
  const quote = s[0];
  if (quote === '"' || quote === "'") {
    const end = s.indexOf(quote, 1);
    return end === -1 ? undefined : s.slice(1, end);
  }
  if (quote === '[') return splitTopLevel(s.slice(1, s.lastIndexOf(']'))).map(parseTomlValue);
  if (quote === '{') {
    const table = {};
    for (const pair of splitTopLevel(s.slice(1, s.lastIndexOf('}')))) {
      const eq = pair.indexOf('=');
      if (eq === -1) continue;
      table[unquoteToml(pair.slice(0, eq))] = parseTomlValue(pair.slice(eq + 1));
    }
    return table;
  }
  const bare = s.split('#')[0].trim();
  if (bare === 'true' || bare === 'false') return bare === 'true';
  if (bare !== '' && Number.isFinite(Number(bare))) return Number(bare);
  return undefined;
}

/** Parse TOML `text` into a nested plain object. See the section comment for the subset. */
export function parseMinimalToml(text) {
  const root = {};
  let table = root;
  let pendingKey = null;
  let buffer = '';
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    // Continuation of a multi-line array/inline table started on an earlier line.
    if (pendingKey !== null) {
      buffer += ` ${line}`;
      if (!bracketsBalanced(buffer)) continue;
      if (table) table[pendingKey] = parseTomlValue(buffer);
      pendingKey = null;
      buffer = '';
      continue;
    }
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      // `[[array-of-tables]]` and any malformed header park us in `null` — no key is read.
      const header = line.match(/^\[\s*([^[\]]+?)\s*\]$/);
      table = header ? walkTomlTable(root, splitTomlKey(header[1])) : null;
      continue;
    }
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = unquoteToml(line.slice(0, eq));
    const rhs = line.slice(eq + 1).trim();
    if (!key) continue;
    if (!bracketsBalanced(rhs)) { pendingKey = key; buffer = rhs; continue; }
    if (table) table[key] = parseTomlValue(rhs);
  }
  return root;
}

/** Walk (creating as needed) the nested table at `segments`. Null when a segment is scalar. */
function walkTomlTable(root, segments) {
  let node = root;
  for (const seg of segments) {
    if (!node[seg] || typeof node[seg] !== 'object' || Array.isArray(node[seg])) node[seg] = {};
    node = node[seg];
  }
  return node;
}

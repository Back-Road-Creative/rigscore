#!/usr/bin/env node

import { run } from '../src/index.js';

// Last-resort guard. Any rejection that escapes `run()`'s try/catch
// (e.g. a subcommand handler that throws asynchronously) ends up here —
// emit a single-line message instead of Node's default stack dump.
function handleFatalTopLevel(err) {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`rigscore: unexpected error: ${msg}\n`);
  process.exit(2);
}
process.on('unhandledRejection', handleFatalTopLevel);

const args = process.argv.slice(2);

// Subcommand dispatch (MCP runtime-hash pinning, print-and-paste workflow).
// These commands never execute an MCP server subprocess — user pipes
// `tools/list` JSON into stdin and pastes the hash back via `mcp-pin`.
const MCP_SUBCOMMANDS = new Set(['mcp-hash', 'mcp-pin', 'mcp-verify']);
if (args.length > 0 && MCP_SUBCOMMANDS.has(args[0])) {
  const subcommand = args[0];
  const rest = args.slice(1);
  const mod = await import('../src/cli/mcp-subcommands.js');
  if (subcommand === 'mcp-hash') {
    await mod.runMcpHash();
  } else if (subcommand === 'mcp-pin') {
    await mod.runMcpPin(rest);
  } else if (subcommand === 'mcp-verify') {
    await mod.runMcpVerify(rest);
  }
  process.exit(0);
}

// `rigscore diff <baseline> <current>` — JSON diff of new findings.
if (args.length > 0 && args[0] === 'diff') {
  const mod = await import('../src/cli/baseline.js');
  mod.runDiffSubcommand(args.slice(1));
  process.exit(0);
}

// `rigscore explain <findingId>` — print the relevant docs page.
if (args.length > 0 && args[0] === 'explain') {
  const mod = await import('../src/cli/explain.js');
  await mod.runExplainSubcommand(args.slice(1));
  process.exit(0);
}

// `init` subcommand: writes a starter .rigscorerc.json. Accepts
// `--profile <name>` to pre-fill the profile, `--force` / `-f` to overwrite
// pre-existing files, and `--example` to scaffold a demo project with
// intentional hygiene issues (useful for CI smoke tests).
if (args.length > 0 && args[0] === 'init') {
  const rest = args.slice(1);
  const mod = await import('../src/cli/init.js');
  const code = await mod.runInitSubcommand(rest);
  process.exit(code ?? 0);
}

if (args.includes('--version')) {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const pkg = require('../package.json');
  process.stdout.write(`rigscore v${pkg.version}\n`);
  process.exit(0);
}

if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(`rigscore — AI dev environment configuration hygiene checker

Usage:
  rigscore [directory] [options]

Options:
  --json             Output results as JSON
  --sarif            Output SARIF v2.1.0 for GitHub Advanced Security
  --badge            Generate a markdown badge
  --cyclonedx        Output a CycloneDX 1.6 AI-BOM (JSON) of the MCP servers,
                     AI client configs and governance files found (docs/cyclonedx.md)
  --ci               CI mode (--sarif --no-color --no-cta)
  --fail-under <N>   Exit code 1 if score < N (default: 70)
  --profile <name>   Scoring profile (default, minimal, ci, home, monorepo)
  --no-color         Disable colored output
  --cta              Show the promotional call-to-action (off by default)
  --no-cta           Deprecated alias — CTA is already off by default; kept
                     for back-compat with pre-commit hooks and CI configs
  --check <id>       Run a single check by ID
  --recursive, -r    Scan subdirectories as separate projects
  --depth <N>        Recursion depth (default: 1, implies --recursive)
  --deep             Enable deep source secret scanning
  --online           Enable online MCP supply chain verification
  --refresh-mcp-registry  Force a refetch of the MCP registry cache
                          (implies --online; bypasses the 24h TTL)
  --semantic         Enable the opt-in semantic MCP tool-description judge
                     (semantic-tools check). Shells to your first-party
                     claude -p (Max-plan CLI, never an API key); skips
                     silently if claude is not on PATH
  --include-home-skills  Also scan ~/.claude/skills and ~/.claude/commands
                         (default: scan cwd only; home findings do not
                         affect project scores unless this flag is set)
  --fix              Show auto-fixable issues and installable packs (dry run)
  --fix --yes        Apply safe auto-remediations. Only edits files that already
                     exist — packs are offered, never installed
  --install-packs    With --fix --yes, also install the starter packs targeting
                     your red checks (creates new files: .claude/settings.json,
                     a pre-commit hook, AGENTS.md). Opt-in: --yes alone means
                     "don't prompt me", not "scaffold governance files"
  --watch            Watch for changes and re-run automatically
  --verify-state     CI gate for MCP rug-pulls (CVE-2025-54136). Read-only; runs
                     no checks. Reads the pin COMMITTED at HEAD, so a pin a scan
                     just minted cannot satisfy it. Exit 1 if a pinned server
                     changed its command/args/env-key shape, 0 if every pin
                     matches, 2 if the pin is missing, uncommitted, or corrupt.
  --no-state-write   Do not write .rigscore-state.json into the scanned repo.
                     A scan writes exactly one file: the MCP config-shape pin
                     that rug-pull detection (CVE-2025-54136) compares against.
                     Use for read-only checkouts / repos you don't own — but it
                     is not free: without the pin there is nothing to detect
                     drift against, so rigscore reports the lost coverage as a
                     mcp-config/state-write-disabled finding. Commit the pin;
                     do not .gitignore it (it stores hashes, never env values)
  --verbose, -v      Also show passing checks (info and skipped findings are
                     already shown by default)
  --ignore <list>    Suppress findings matching patterns (comma-separated)
  --init-hook        Install a pre-commit hook that runs rigscore
  --baseline <path>  Baseline mode. On first run writes findings to <path>;
                     on subsequent runs reports ONLY new findings vs baseline
                     and exits 1 if any new finding is found
  --baseline-refresh (Re)write the working-tree baseline at <path> from the
                     current findings — the sanctioned way to accept new
                     findings; review and commit the regenerated file
  --report <kind>    Render findings grouped by compliance-framework control
                     (kinds: compliance). Not supported with --recursive.
  --version          Show version
  --help, -h         Show this help

Checks (moat-heavy weighting):
  mcp-config              MCP server configuration (14 pts)
  coherence               Cross-config coherence (14 pts)
  skill-files             Skill file safety (10 pts)
  claude-md               CLAUDE.md governance (10 pts)
  deep-secrets            Deep source secret scanning (--deep, 8 pts)
  env-exposure            Secret exposure (8 pts)
  claude-settings         Claude settings safety (8 pts)
  credential-storage      Credential storage hygiene (6 pts)
  docker-security         Docker/K8s/Podman security (6 pts)
  infrastructure-security Infrastructure safety (6 pts)
  unicode-steganography   Unicode steganography (4 pts)
  permissions-hygiene     File permissions hygiene (4 pts)
  git-hooks               Git hooks (2 pts)
  site-security           Deployed site security (--online, advisory)
  instruction-effectiveness Instruction quality & context budget (advisory)
  skill-coherence          Skill ↔ governance coherence (advisory)
  documentation            Check docs coverage against src/checks (advisory)
  workflow-maturity       Skill/agent graduation signals (advisory)
  windows-security        Windows-specific config hygiene (advisory)
  network-exposure        Bound-service / port exposure (advisory)
  agent-output-schemas    JSON-emitting agents declare schemas (advisory)
  loop-governance         Bounded, stoppable agent loops (advisory, Practice)
  spec-goals              Agents driven from written goals/specs (advisory, Practice)
  ci-agent-caps           CI agent turn/timeout/tool caps (advisory, Practice)
  memory-hygiene          Agent memory budget & layout (advisory, Practice)
  ai-disclosure           AI-use disclosure policy present (advisory)
  sandbox-posture         Agent approval/sandbox posture (advisory)
  semantic-tools          Semantic MCP tool-description judge (--semantic, advisory)

Subcommands:
  init [--profile <name>]          Write a commented .rigscorerc.json starter
  explain <findingId>              Print docs/checks/<id>.md; targets the
                                   finding-specific section when available
  diff <baseline> <current>        JSON diff of new findings (exit 1 if any)

Subcommands (MCP runtime tool pinning — print-and-paste, no exec):
  mcp-hash                         Hash a tools/list JSON read from stdin
  mcp-pin <server> <hash>          Pin a runtime tool hash in .rigscore-state.json
  mcp-verify <server>              Compare stdin tools/list to the pinned hash

Subcommands (scaffolders):
  init                             Write a starter .rigscorerc.json into cwd
  init --example                   Scaffold a demo project with intentional
                                   hygiene issues (useful for CI smoke tests)
  init --list-packs                List the starter packs in templates/
  init --<pack> [dir]              Install a starter pack (e.g. init --docs)
  init --force / -f                Overwrite pre-existing files

Examples:
  rigscore                          Scan current directory
  rigscore /path/to/project         Scan a specific project
  rigscore --json                   JSON output for CI
  rigscore --ci --fail-under 80     CI with strict threshold
  rigscore . -r --depth 2           Scan monorepo (2 levels deep)
  rigscore --check docker-security  Run only Docker/K8s check
  npx -y <pkg> | rigscore mcp-hash | xargs rigscore mcp-pin <server>\n`);
  process.exit(0);
}

run(args).catch(handleFatalTopLevel);

# pkg-rigscore

AI dev security scoring tool. Moat-first: MCP supply chain, governance coherence, prompt injection — not generic checks. Scans locally with zero external calls in default mode (`--online` and `--semantic` opt into network / LLM calls) and outputs two 0–100 scores: Security and Practice.

## Commands

```bash
# Run on current directory
node bin/rigscore.js .

# Run recursively on workspace
npx --prefix . rigscore --recursive --depth 1 /home/dev/workspaces/_active/

# Test
npx vitest run

# Single check
node bin/rigscore.js . --check governance-docs
```

## Architecture

| Module | Purpose |
|--------|---------|
| `bin/rigscore.js` | CLI entry point |
| `src/index.js` | Main orchestrator — loads checks, runs scanner |
| `src/scanner.js` | Filesystem scanner, collects context for checks |
| `src/scoring.js` | Additive deduction model (CRITICAL=zero, WARN=-15, INFO=-2) |
| `src/reporter.js` | Human-readable terminal output |
| `src/sarif.js` | SARIF v2.1.0 output for GitHub Advanced Security |
| `src/fixer.js` | Auto-remediation engine (`--fix --yes`) |
| `src/config.js` | Profile loading (default, minimal, ci, home, monorepo) |
| `src/watcher.js` | `--watch` mode file change detection |
| `src/known-mcp-servers.js` | Typosquat registry (~52 known MCP servers) |
| `src/state.js` | Baseline state I/O (`.rigscore-state.json`) for MCP pin/verify + config-shape drift |
| `src/compliance.js` | Compliance-framework mapping (`--report compliance`) |
| `src/cyclonedx.js` | CycloneDX 1.6 AI-BOM export (`--cyclonedx`) |
| `src/cli/*.js` | Subcommands: `explain`, `diff`/baseline, `mcp-hash`/`mcp-pin`/`mcp-verify`, `init`, `init --guards` |
| `src/checks/*.js` | Individual check modules (see below) |

### Check modules (src/checks/)

Scored: `mcp-config` (14pt), `coherence` (14pt), `skill-files` (10pt), `governance-docs` (10pt), `claude-settings` (8pt), `deep-secrets` (8pt), `env-exposure` (8pt), `credential-storage` (6pt), `docker-security` (6pt), `infrastructure-security` (6pt), `unicode-steganography` (4pt), `permissions-hygiene` (4pt), `git-hooks` (2pt).

Advisory (weight 0): `windows-security`, `network-exposure`, `site-security`, `instruction-effectiveness`, `skill-coherence`, `workflow-maturity`, `documentation`, `agent-output-schemas`, `loop-governance`, `spec-goals`, `ci-agent-caps`, `memory-hygiene`, `ai-disclosure`, `sandbox-posture`, `semantic-tools`.

Weights are the single source of truth in `src/constants.js` — never hardcode them elsewhere.

## Conventions

- Node.js >=18, ES modules (`"type": "module"`)
- Dependencies: chalk, yaml (no others)
- Tests: vitest
- Plugin system: `rigscore-check-*` packages auto-discovered from node_modules
- Check interface: `export default { id, name, category, weight, run(context) }`

## Constraints

- Zero network / LLM calls in default mode (`--online` opts into supply-chain lookups; `--semantic` shells to `claude -p` for the semantic-tools LLM judge)
- Checks must be pure functions of local filesystem state
- New checks must export `{ id, name, category, weight, run }` and self-register in `src/checks/`
- Scoring weighted ~48% moat (mcp-config 14 + coherence 14 + skill-files 10 + governance-docs 10) / ~52% hygiene (secrets 22, docker/infra 12, permissions/hooks/unicode/settings 18)
- `--fix` never modifies governance content
- Distributed via GitHub only: `npx github:Back-Road-Creative/rigscore` (npm intentionally dropped)

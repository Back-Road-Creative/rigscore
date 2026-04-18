# pkg-rigscore

AI dev security scoring tool. Moat-first: MCP supply chain, governance coherence, prompt injection — not generic checks. Scans locally with zero external calls and outputs a score out of 100.

## Commands

```bash
# Run on current directory
node bin/rigscore.js .

# Run recursively on workspace
npx --prefix . rigscore --recursive --depth 1 /home/dev/workspaces/_active/

# Test
npx vitest run

# Single check
node bin/rigscore.js . --check claude-md
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
| `src/config.js` | Profile loading (default, minimal, ci) |
| `src/watcher.js` | `--watch` mode file change detection |
| `src/known-mcp-servers.js` | Typosquat registry (~52 known MCP servers) |
| `src/checks/*.js` | Individual check modules (see below) |

### Check modules (src/checks/)

Scored: `mcp-config` (14pt), `coherence` (14pt), `skill-files` (10pt), `claude-md` (10pt), `claude-settings` (8pt), `deep-secrets` (8pt), `env-exposure` (8pt), `credential-storage` (6pt), `docker-security` (6pt), `infrastructure-security` (6pt), `unicode-steganography` (4pt), `permissions-hygiene` (4pt), `git-hooks` (2pt).

Advisory (weight 0): `windows-security`, `network-exposure`, `site-security`, `instruction-effectiveness`, `skill-coherence`, `workflow-maturity`.

Weights are the single source of truth in `src/constants.js` — never hardcode them elsewhere.

## Conventions

- Node.js >=18, ES modules (`"type": "module"`)
- Dependencies: chalk, yaml (no others)
- Tests: vitest
- Plugin system: `rigscore-check-*` packages auto-discovered from node_modules
- Check interface: `export default { id, name, category, weight, run(context) }`

## Constraints

- Zero network calls in default mode (`--online` flag required for supply-chain verification)
- Checks must be pure functions of local filesystem state
- New checks must export `{ id, name, category, weight, run }` and self-register in `src/checks/`
- Scoring weighted ~48% moat (mcp-config 14 + coherence 14 + skill-files 10 + claude-md 10) / ~52% hygiene (secrets 22, docker/infra 12, permissions/hooks/unicode/settings 18)
- `--fix` never modifies governance content
- Distributed via GitHub only: `npx github:Back-Road-Creative/rigscore` (npm intentionally dropped)

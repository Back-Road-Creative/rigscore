# rigscore

**A configuration hygiene checker for your AI development environment.**

One command. 13 scored checks plus 7 advisory checks. A hygiene score out of 100. Know where you stand before something breaks.

```bash
npx github:Back-Road-Creative/rigscore
```

```
  ╭────────────────────────────────────────╮
  │                                        │
  │        rigscore v0.8.0                 │
  │   AI Dev Environment Hygiene Check     │
  │                                        │
  ╰────────────────────────────────────────╯

  Scanning /home/user/my-project ...

  ✓ CLAUDE.md governance.......... 10/10
  ✓ Claude settings safety........ 8/8
  ✓ Cross-config coherence........ 14/14
  ✓ Credential storage hygiene.... 6/6
  ↷ Deep source secrets........... N/A
  ✓ Docker security............... 6/6
  ✓ Secret exposure............... 8/8
  ✓ Git hooks..................... 2/2
  ✓ Infrastructure security....... 5/6
  ⚠ Instruction effectiveness..... advisory
  ✗ MCP server configuration...... 0/14
  ✓ Permissions hygiene........... 4/4
  ↷ Site security................. N/A
  ✓ Skill file safety............. 10/10
  ✓ Unicode steganography......... 4/4
  ↷ Windows/WSL security.......... N/A
  ✓ Skill ↔ governance coherence.. advisory
  ✓ Workflow maturity............. advisory
  ↷ Network exposure.............. N/A

  ╭────────────────────────────────────────╮
  │                                        │
  │         HYGIENE SCORE: 78/100          │
  │         Grade: B                       │
  │         Risk: Standard                 │
  │                                        │
  ╰────────────────────────────────────────╯

  CRITICAL (1)
  ✗ MCP server "filesystem" has broad filesystem access: /
    → Scope filesystem access to your project directory only.
```

## Why this exists

rigscore scores AI-agent config hygiene and catches contradictions between what your governance file claims and what your actual configuration does — in one local command, no account, no API token, passable as a CI gate with a single `--fail-under` threshold.

Most AI-agent security scanning today is either finding-stream static analysis (Snyk Agent Scan, Semgrep rules) or manual review. rigscore fills a narrower slot: a single hygiene score with an A–F grade, a cross-config **coherence** pass that compares governance claims to observed behavior (MCP scope, Docker privileges, approval gates), and a CI-gate exit code. It runs fully offline by default; `--online` is opt-in for site probes and MCP supply-chain verification.

It's the thing you run before you care about tool pinning, before you stand up a SARIF pipeline, before you adopt an enterprise scanner. If your CLAUDE.md says "never access `/etc`" and your MCP config mounts `/`, rigscore tells you.

**What rigscore checks:** MCP scope and supply chain, cross-config coherence, skill-file injection vectors, governance quality, Claude settings bypass combos, secret exposure in config files, container and devcontainer isolation, Unicode steganography, git hooks, file permissions, credential storage, and (advisory) instruction effectiveness, skill↔governance coherence, workflow maturity, Windows/WSL boundary, site security, and network exposure.

Run it. See the score. Fix what's broken.

## How rigscore compares

rigscore isn't the only AI-agent config scanner. The April-2026 landscape has real alternatives — pick based on what you actually need.

| Tool | Niche | Use when |
|------|-------|----------|
| **rigscore** | Single-score hygiene check + cross-config coherence | You want one local command, an A–F grade, and a CI gate. No account, no token. |
| **Snyk Agent Scan** ([github.com/snyk/agent-scan](https://github.com/snyk/agent-scan)) | 15+ risk-category finding stream, tool-hash pinning (rug-pull detection) | You need enterprise reporting, MCP tool-pinning to detect supply-chain drift, or already have a Snyk contract. Requires `SNYK_TOKEN` for full features. |
| **Semgrep** ([semgrep.dev](https://semgrep.dev)) | General static analysis, 5000+ rules, optional MCP server | You're scanning source code, not config hygiene, or already run Semgrep in CI and want to extend it. |

**Where rigscore differs from Snyk Agent Scan:**
- Cross-config COHERENCE check — compares what your governance file claims against what your actual MCP/settings/Docker configuration does. Snyk scans each config independently and doesn't cross-reference them against a governance file.
- Single-score CI gate with `--fail-under N` and grade A–F. Snyk is a finding stream; you'd have to script a threshold yourself.
- Fully local, no account, no API token, no external call by default. `--online` is opt-in.

**Where Snyk is ahead:**
- Tool Pinning: hashes MCP tool descriptions and flags drift over time (mitigates CVE-2025-54136 class "MCP rug pull" attacks). rigscore does not persist tool-description hashes across scans — this is a planned follow-up, not a current capability.
- Detailed published threat models for SKILL.md and agent configs. rigscore's skill-files check is pattern-based and has a documented **semantic-reversal weakness** (see Limitations).
- Broader risk-category coverage (toxic flows, tool shadowing, malware payloads).

**Where Semgrep is a better fit:** you want to scan your application source for vulnerabilities, not validate your AI-agent configuration. rigscore does not replace Semgrep — it runs upstream of it.

**Picking one:** run rigscore as a pre-commit / PR-gate hygiene check. Run Snyk Agent Scan in CI if you need tool pinning and enterprise reporting. Run Semgrep against your application code. They are complementary.

## Install and run

No setup. No accounts. No data leaves your machine.

```bash
# Run on the current directory
npx github:Back-Road-Creative/rigscore

# Run on a specific project
npx github:Back-Road-Creative/rigscore /path/to/project

# Output as JSON (for CI integration)
npx github:Back-Road-Creative/rigscore --json

# SARIF output (for GitHub Advanced Security)
npx github:Back-Road-Creative/rigscore --sarif

# CI mode (SARIF + no color + no CTA)
npx github:Back-Road-Creative/rigscore --ci --fail-under 80

# Generate a README badge
npx github:Back-Road-Creative/rigscore --badge

# Scan a monorepo (recursive mode)
npx github:Back-Road-Creative/rigscore . --recursive --depth 2

# Run a single check
npx github:Back-Road-Creative/rigscore --check docker-security

# Deep source secret scanning
npx github:Back-Road-Creative/rigscore --deep

# Online checks (site-security, MCP supply-chain verification)
npx github:Back-Road-Creative/rigscore --online

# Force refresh of the MCP registry cache (implies --online)
npx github:Back-Road-Creative/rigscore --refresh-mcp-registry

# Auto-fix safe issues (dry run)
npx github:Back-Road-Creative/rigscore --fix

# Apply auto-fixes
npx github:Back-Road-Creative/rigscore --fix --yes

# Use a scoring profile
npx github:Back-Road-Creative/rigscore --profile minimal

# Watch mode — re-run on config changes
npx github:Back-Road-Creative/rigscore --watch

# Install a pre-commit hook
npx github:Back-Road-Creative/rigscore --init-hook
```

## Platform notes

| Platform | Status | Notes |
|---|---|---|
| **macOS** | Supported | CI runs `macos-latest`. Homebrew Node is fine. `infrastructure-security` returns N/A (Linux-only). |
| **Linux** | Supported | Native. All checks apply, including `infrastructure-security`. |
| **WSL2** | Supported | Treat as Linux. See WSL2 gotcha below. |
| **Docker Desktop** | Supported | Pull the image, bind-mount the target dir. See [CI Integration](#ci-integration) and the `Dockerfile` in the repo. |
| **Git Bash / MSYS2** | Unsupported | POSIX-only permission checks fail silently. Use WSL. |
| **Windows native** | Out of scope | POSIX permission assumptions and shell-command calls mean behavior can't be made reliable. Use WSL2. |

**WSL2 gotcha — NTFS-mounted paths.** When you scan a project under `/mnt/c/...` (Windows-owned NTFS), POSIX permission bits don't map cleanly. `permissions-hygiene` may emit spurious world-readable / mixed-UID findings on files owned by the Windows side. Workaround: keep projects inside the WSL filesystem (e.g., `~/projects/...`) and scan there. If you must scan a `/mnt/` path, suppress the affected finding via `--ignore permissions-hygiene/sensitive-file-world-readable` or via `.rigscorerc.json` `suppress:`.

## Distribution

- **GitHub-only.** rigscore is distributed via `npx github:Back-Road-Creative/rigscore`. It is **not** published to npm. See `CLAUDE.md` for the full rationale — in short: npm publish was intentionally dropped in v0.8.0 (commit #62) to keep the supply-chain surface tight. The tool is the sort of thing you want to audit before running; pulling straight from GitHub makes the audit trail obvious and avoids a second supply-chain hop.
- **Docker image (v1.1.0, not yet published).** A `Dockerfile` and GHCR workflow are in the repo; the workflow is gated on `workflow_dispatch` only so it won't auto-publish. When the image ships, you'll pull it as `ghcr.io/back-road-creative/rigscore:latest`.
- **GitHub Action.** `action.yml` at the repo root exposes rigscore as a composite action. Reference it from a workflow as `uses: Back-Road-Creative/rigscore@v1`.
- **Cross-platform support.** CI runs against `ubuntu-latest` and `macos-latest` across Node 18/20. WSL users get the Linux path. **Windows native is out of scope** — POSIX-only permission checks and shell-command assumptions make it a separate workstream, not a v1.0.0 deliverable.

## What it checks

### 1. MCP server configuration (14 points) {#mcp-permissions}

[MCP (Model Context Protocol)](https://modelcontextprotocol.io/) lets AI agents connect to external tools via servers. Each server exposes capabilities — filesystem access, API calls, database queries. The security risk is in the permissions.

rigscore scans MCP configs across all major clients: Claude (`.mcp.json`, `.vscode/mcp.json`), Cursor (`~/.cursor/mcp.json`), Cline (`~/.cline/mcp_settings.json`), Continue (`~/.continue/config.json`), Windsurf (`~/.windsurf/mcp.json`), Zed (`~/.config/zed/settings.json`), and Amp (`~/.amp/mcp.json`).

**What rigscore looks for:**
- Transport type: `stdio` (local, safer) vs. `sse` (network, riskier)
- Wildcard environment passthrough (`env: {...process.env}`) — exposes all your env vars to the server
- Filesystem scope: is the server limited to project directories, or does it have access to `/`?
- Version pinning: are packages locked to specific versions, or using `@latest`?
- Cross-client configuration drift: are the same servers configured differently across clients?
- Typosquatting detection: is a package name suspiciously close to a known MCP server?

**Supply chain risk:** An MCP server installed as `@latest` today could push a malicious update tomorrow. Version pinning prevents this. {#mcp-supply-chain}

**MCP registry augmentation (`--online`):** when `--online` is passed, rigscore augments the hand-curated typosquat list with data from the official MCP registry at `https://registry.modelcontextprotocol.io/v0/servers`. The response is cached at `~/.cache/rigscore/mcp-registry.json` (XDG convention; overridable via `XDG_CACHE_HOME`) with a 24-hour TTL. If the refetch fails after expiry, the stale cache is still used and an INFO finding surfaces the state. The registry only **augments** the hand-curated list — it never replaces it. Pass `--refresh-mcp-registry` to force a refetch (implies `--online`).

**Air-gapped / offline pre-populate:** place a JSON file at `~/.cache/rigscore/mcp-registry.json` with the shape `{"fetchedAt": "<ISO-8601 timestamp>", "data": { ... raw /v0/servers response ... }}`. rigscore will treat it like any other cache entry and respect the 24h TTL. An air-gapped host can refresh the file from a machine with network access on whatever cadence it chooses.

**What to fix:** Scope filesystem servers to your project directory only. Remove wildcard env passthrough — pass only the specific variables each server needs. Pin all server packages to exact versions. Prefer `stdio` transport unless you specifically need network access.

### 2. Cross-config coherence (14 points) {#coherence-check}

The coherence check is rigscore's second pass — it compares what your governance file *claims* against what your actual configuration *does*. This catches contradictions that no single check can see.

**What rigscore looks for:**
- Governance claims "no external network" but MCP uses network transport
- Governance claims "path restrictions" but MCP has broad filesystem access
- Governance claims "forbidden actions" but Docker is running privileged
- MCP configuration drifts across AI clients without governance guidance
- Governance claims anti-injection rules but skill files contain injection patterns
- Compound risk: data exfiltration patterns combined with broad filesystem access
- `settings.json` disables approval gates that CLAUDE.md requires

**Compound risk penalty:** If the coherence check finds a CRITICAL-severity contradiction, 10 points are deducted from the overall score on top of the per-check penalty. This reflects the systemic nature of governance failures.

### 3. Skill file safety (10 points) {#skill-file-injection}

Skill files (`.cursorrules`, `.windsurfrules`, `.continuerules`, `copilot-instructions.md`, `AGENTS.md`, `.aider.conf.yml`) tell AI agents how to behave. They're also a prompt injection vector — malicious instructions embedded in skill files can override agent behavior.

**What rigscore looks for:**
- Instruction override patterns ("ignore previous instructions", "disregard", "new system prompt")
- Shell execution instructions embedded in skill files
- External URL references (potential data exfiltration)
- Base64 or encoded content (obfuscated payloads)
- File permissions (writable by others?)

**What to fix:** Audit all skill files for unexpected instructions. Lock file permissions so only you can modify them. Be cautious with skill files from untrusted sources — treat them like executable code, because that's effectively what they are.

**Scope:** By default rigscore only scans skill files under the project being scored (cwd). Home-level skills (`~/.claude/skills/`, `~/.claude/commands/`) are user-global and not attributable to a project, so they do not deduct from the project score. Pass `--include-home-skills` if you want home-level skills scanned too; findings from home files are labeled with a `~/` prefix.

### 4. CLAUDE.md governance (10 points) {#why-claude-md-matters}

Your CLAUDE.md file tells AI agents what they can and can't do. Without one, your agent operates with no explicit rules — it can access any file, run any command, and make any API call that its underlying permissions allow.

rigscore recognizes governance files for all major AI coding clients: CLAUDE.md, `.cursorrules`, `.windsurfrules`, `.clinerules`, `.continuerules`, `copilot-instructions.md`, `AGENTS.md`, and `.aider.conf.yml`.

**What rigscore looks for:**
- Does a governance file exist in the project root?
- Does it contain forbidden action rules with proper negation context?
- Does it have human-in-the-loop approval gates?
- Does it restrict file and directory access?
- Does it restrict network and API access?
- Does it include anti-injection instructions?
- Is the governance file tracked in git (not ephemeral)?
- Does it define TDD/pipeline lock, Definition of Done, and git workflow rules?

**A good CLAUDE.md is not a wishlist** — it should define specific, enforceable boundaries. rigscore checks that your governance file documents key security dimensions; enforcement depends on your tooling (hooks, permissions, container isolation). {#claude-md-hardening}

**Starter templates** for each AI client (Cursor, Cline, Continue, Windsurf, Aider) live in [`docs/examples/`](docs/examples/) — copy the one for your client and customize.

**What to fix:** Create a governance file with explicit execution boundaries, forbidden actions, file access restrictions, and approval gates. Be specific — "don't access sensitive files" is too vague. List the exact directories and operations that are off-limits.

### 5. Claude settings safety (8 points) {#claude-settings}

`.claude/settings.json` controls what Claude Code can do autonomously. Certain settings — individually or in combination — can eliminate human oversight entirely.

**What rigscore looks for:**
- `enableAllProjectMcpServers` — auto-trusts all MCP servers without per-project approval
- `skip-permissions` — disables the permission gate for file and command operations
- Hook configurations that shell out to arbitrary commands
- Bypass combos: pairings of settings that together eliminate all security gates

### 6. Deep source secrets (8 points, `--deep`) {#deep-scanning}

When enabled with `--deep`, rigscore recursively scans your source files for hardcoded secrets. This goes beyond the root config file scanning and checks `.js`, `.ts`, `.py`, `.go`, `.rb`, `.java`, `.yaml`, `.json`, `.toml`, `.sh`, and `.env.*` files.

**What rigscore looks for:**
- ~40 secret patterns: API keys from Anthropic, OpenAI, AWS (including STS tokens), GitHub, GitLab, Slack, Stripe, SendGrid, Twilio, Firebase/Google, DigitalOcean, Mailgun, npm, PyPI, Hugging Face, MongoDB, Vercel, Supabase, Cloudflare, Railway, PlanetScale, Neon, Linear, Replicate, Tavily, webhook signing secrets, AGE encryption keys, Datadog, 1Password CLI references, HashiCorp Vault, JFrog Artifactory, and Docker registry auth tokens
- Comment vs. hardcoded distinction (commented/example keys are `info`, real keys are `critical`)
- Skips test files, node_modules, .git, vendor, dist, build directories

**What to fix:** Move secrets to `.env` files or a secrets manager. Use environment variables in your application code.

### 7. Secret exposure (8 points) {#env-security}

API keys, tokens, and credentials in the wrong places are the most common security failure in any codebase — and AI development makes it worse because agents read config files, skill files, and environment variables as part of their normal operation.

**What rigscore looks for:**
- `.env` files present but not in `.gitignore`
- API key patterns in config files, governance files, skill files, or MCP configs
- `.env` file permissions (world-readable vs. user-only)
- SOPS encryption detection

**What to fix:** Add `.env` to `.gitignore` immediately. Set `.env` permissions to `600` (user read/write only). Never hardcode API keys in governance or config files. Use environment variables and pass them explicitly.

### 8. Credential storage hygiene (6 points) {#credential-storage}

Checks where credentials actually live — env vars in the right files, committed secrets in the wrong ones. Broader pattern coverage than the secret exposure check.

### 9. Container security (6 points) {#docker-isolation}

Containers provide isolation for AI agent workloads — but misconfigured containers can actually increase your attack surface instead of reducing it.

rigscore scans **Docker Compose**, **Podman Compose**, **Kubernetes manifests**, and **devcontainer.json** configurations. Compose `include` directives are followed and analyzed. K8s manifests are scanned in the project root and common subdirectories (`k8s/`, `kubernetes/`, `manifests/`, `deploy/`), including multi-document YAML files.

**What rigscore looks for:**
- Docker socket (`/var/run/docker.sock`) mounted in containers — this is a container escape vector {#docker-socket-risk}
- `privileged: true` — gives the container full host access
- Volume/hostPath mounts to sensitive host directories (`/`, `/etc`, `/root`, `~/.ssh`)
- Host network mode — bypasses container network isolation
- Missing `user` directive (container runs as root)
- Missing `cap_drop: [ALL]` (retains default Linux capabilities)
- Missing `no-new-privileges` security option
- Missing memory limits
- K8s-specific: `hostPID`, `hostIPC`, `allowPrivilegeEscalation`, missing `runAsNonRoot`
- Devcontainer: `--privileged` in runArgs, dangerous capability additions

**What to fix:** Never mount the Docker socket unless absolutely necessary. Never run containers in privileged mode. Scope volume mounts to project directories only. Add `user`, `cap_drop: [ALL]`, and `no-new-privileges` to every service. Set memory limits.

### 10. Infrastructure security (6 points) {#infrastructure-security}

Host-level controls that sit beneath your project: root-owned git hooks, a git wrapper that cannot be bypassed, a shell safety guard, and immutable governance directories. These are the backstop when per-project hooks or settings are missing or tampered with. This check is Linux-only — it returns N/A on macOS and Windows.

**What rigscore looks for:**
- A global git hooks directory at `/opt/git-hooks/` (path is configurable via `.rigscorerc.json` → `paths.hooksDir`)
- That directory is owned by root
- Required hooks present and executable: `pre-commit`, `pre-push`, `commit-msg`
- A git safety wrapper at `/usr/local/bin/git` (configurable) that is root-owned and strips `--no-verify` to prevent hook bypass
- A shell safety guard at `/etc/profile.d/safety-gates.sh` (configurable) that blocks dangerous patterns like `chmod 777`
- Immutable flag (`chattr +i`) on `_governance/` and `_foundation/` workspace directories (and any dirs listed in `paths.immutableDirs`)
- `permissions.deny` list in `~/.claude/settings.json` includes dangerous patterns: `git push --force`, `git reset --hard`, `rm -rf`, `git push origin main`, `git push origin master`
- A `sandbox-gate` hook registered under `PreToolUse` to gate Write/Edit/Bash

### 11. Unicode steganography detection (4 points) {#unicode-steganography}

Checks skill files and CLAUDE.md for hidden characters that render identically to legitimate text but redirect agent behavior. Covers the attack surface from the ToxicSkills and Rules File Backdoor incidents.

**What rigscore looks for:**
- Greek/Armenian/Georgian lookalikes that render as Latin letters
- Zero-width joiners and zero-width non-joiners
- Bidirectional control characters (bidi overrides)

### 12. Git hooks (2 points) {#git-hooks-for-ai}

Git hooks are your last line of defense before code leaves your machine. Without pre-commit hooks, secrets, broken governance files, and unreviewed changes go straight to the repo.

**What rigscore looks for:**
- Pre-commit hooks present (`.git/hooks/pre-commit` or a hook manager like Husky/lefthook)
- Claude Code hooks (`.claude/settings.json` with hook configuration)
- Push URL guards (`.git/config` with `pushurl = no_push`)
- External hook directories from config

**What to fix:** Install [Husky](https://github.com/typicode/husky) or [lefthook](https://github.com/evilmartians/lefthook) and add pre-commit hooks that scan for secret patterns and validate governance files.

### 13. Permissions hygiene (4 points) {#permissions-hygiene}

File permissions are the foundation of access control. Misconfigured permissions on SSH keys, secret files, or governance files can undermine every other security measure.

**What rigscore looks for:**
- SSH directory permissions (`~/.ssh` should be 700)
- SSH private key permissions (should be 600)
- World-readable sensitive files in the project (`.pem`, `.key`, `*credentials*`)
- Governance file ownership consistency (mixed UIDs may indicate unauthorized modifications)

**What to fix:** Run `chmod 700 ~/.ssh` and `chmod 600 ~/.ssh/id_*`. Ensure sensitive files are not world-readable. Verify all governance files are owned by the same user.

**Platform note:** Permission checks are POSIX-only. On Windows, rigscore reports a SKIPPED finding and recommends manual verification with `icacls`.

### 14. Windows/WSL security (advisory, 0 points) {#windows-security}

On Windows, rigscore checks for WSL-specific security risks. This is an advisory check — it doesn't affect the score but surfaces important configuration issues.

**What rigscore looks for:**
- WSL interop settings — warns if Windows PATH leaks into WSL (`appendWindowsPath=true`)
- `.wslconfig` firewall and networking mode
- Windows Defender exclusions that include project directories or `node_modules`
- NTFS permissions advisory for sensitive files

**Platform note:** Returns N/A on non-Windows systems. Weight 0 means it never affects the score.

### 15. Network exposure (advisory, 0 points) {#network-exposure}

Advisory check that detects AI services bound to `0.0.0.0` instead of `127.0.0.1`. Scans MCP config URLs, Docker port bindings, Ollama config, and live listeners.

### 16. Site security (advisory, 0 points, `--online`) {#site-security}

Probes deployed sites listed in `.rigscorerc.json` under `sites: [...]`. Only runs when `--online` is passed; otherwise returns N/A.

**What rigscore looks for:**
- Critical security headers: `content-security-policy`, `x-frame-options`, `x-content-type-options`, `strict-transport-security`
- Advisory headers: `referrer-policy`, `permissions-policy`
- Server fingerprinting via `X-Powered-By` and versioned `Server` headers
- Sensitive paths that should not be publicly reachable (`.env`, `.git/config`, `backup.zip`, `wp-admin/`, `phpmyadmin/`, etc.)
- PII leakage in rendered HTML (emails, phone numbers, internal IP ranges)
- Hardcoded API keys in the served page source
- `<meta name="generator">` build-tool disclosure
- SSL certificate expiry (critical if expired, warning if <30 days)

### 17. Instruction effectiveness (advisory, 0 points) {#instruction-effectiveness}

Audits the instruction files that feed the agent — CLAUDE.md, `~/.claude/CLAUDE.md`, and files under `.claude/commands/` and `.claude/skills/`. Measures quality, not security, so it is advisory.

**What rigscore looks for:**
- Context budget: total estimated tokens across all instruction files versus a 200K reference window (warns above 20%, info above 10%); flags individual files above ~5K tokens
- Bloat: files over 500 lines (warning) or 300 lines (info)
- Vague directives: phrases like "use your best judgment", "as appropriate", "figure it out", "when it makes sense"
- Contradictions between `always`/`must` and `never`/`must not` directives on the same topic
- Dead file references in backtick paths and markdown links (paths that no longer exist)
- Redundancy across instruction files

### 18. Skill ↔ governance coherence (advisory, 0 points) {#skill-coherence}

Scans every SKILL.md under `.claude/skills/` and `.claude/commands/` (both project and `~/.claude/`) and checks that each skill is aware of the constraints that governance claims to enforce. Advisory.

**What rigscore looks for:**
- Skills that perform git/ship/push operations but don't acknowledge manual merge workflow requirements (`gh-merge-approved`, `brc-merge-approved`)
- Skills that perform write/edit/scaffold operations but don't acknowledge layer write restrictions on `_governance/` and `_foundation/`
- Skills that overwrite files without mentioning WIP protection (untracked files in `_active/svc-*` have no backup)
- Skills that push/commit/ship without mentioning branch protection (no force push, no direct push to main/master)
- Hook ↔ settings conflicts where a PreToolUse hook blocks a pattern that `settings.json` allow-lists

### 19. Workflow maturity (advisory, 0 points) {#workflow-maturity}

Classifies the project's workflow artefacts against the AI development taxonomy and surfaces graduation signals — skills that should become code, pipelines that should be split, memory files that have gone stale. Advisory.

**What rigscore looks for:**
- Pipeline step overload: single modules with too many `# Stage N` / `# Step N` / `# Phase N` markers, or stage directories that suggest a monolithic pipeline should be decomposed
- Skills that have matured past the LLM-driven stage and should be graduated to deterministic code
- Stale memory files and orphan memory that is not linked from `MEMORY.md`
- Taxonomy misclassification between skills, agents, pipelines, and memory

### 20. Documentation coverage (advisory, 0 points) {#documentation}

Enforces the docs-first gate: every module in `src/checks/` must have a matching page under `docs/checks/` with the canonical sections (Purpose, Triggers, Weight rationale, Fix semantics, SARIF, Example) filled in, and every doc must correspond to a real check. Advisory, and only active in rigscore itself or plugin repos that mirror its layout. See [`docs/checks/documentation.md`](docs/checks/documentation.md).

**What rigscore looks for:**
- Check modules in `src/checks/` with no matching `docs/checks/<id>.md`
- Doc pages that are missing required H2 sections or have empty section bodies
- Doc pages whose stated weight drifts from `src/constants.js`
- Doc H1 titles that do not match the check id
- Orphan doc pages with no corresponding check module

## Scoring

| Score | Grade | Meaning |
|-------|-------|---------|
| 90-100 | A | Strong hygiene posture |
| 75-89 | B | Good foundation, some gaps |
| 60-74 | C | Moderate risk, needs attention |
| 40-59 | D | Significant gaps |
| 0-39 | F | Critical issues, fix immediately |

Scoring uses an additive deduction model with moat-heavy weighting — AI-specific checks (MCP, coherence, skill files, governance) account for ~48% of the score:

| Check | Weight | Category |
|-------|--------|----------|
| MCP server configuration | 14 | supply-chain |
| Cross-config coherence | 14 | governance |
| Skill file safety | 10 | supply-chain |
| CLAUDE.md governance | 10 | governance |
| Claude settings safety | 8 | governance |
| Deep source secrets | 8 | secrets |
| Secret exposure | 8 | secrets |
| Credential storage hygiene | 6 | secrets |
| Docker security | 6 | isolation |
| Infrastructure security | 6 | process |
| Unicode steganography | 4 | supply-chain |
| Permissions hygiene | 4 | process |
| Git hooks | 2 | process |
| Windows/WSL security | 0 | isolation (advisory) |
| Network exposure | 0 | isolation (advisory) |
| Site security | 0 | isolation (advisory) |
| Instruction effectiveness | 0 | governance (advisory) |
| Skill ↔ governance coherence | 0 | governance (advisory) |
| Workflow maturity | 0 | governance (advisory) |
| Documentation coverage | 0 | process (advisory) |

- **CRITICAL** findings zero out their sub-check entirely
- **WARNING** findings deduct 15 points each (1 WARNING = 85, 2 = 70, 3 = 55...)
- **INFO** findings deduct 2 points each, with a floor of 50 when no WARNINGs are present
- **PASS** and **SKIPPED** findings have no score impact

**Compound risk penalty:** When the coherence check finds a CRITICAL contradiction, 10 additional points are deducted from the overall score — reflecting the systemic nature of governance failures.

**Coverage scaling (what the `Coverage: N of M checks applicable (weight W/100)` line means):** Checks that find nothing to scan are marked N/A and excluded from the weighted average — their weight is redistributed proportionally across the remaining applicable checks. Separately, if the total applicable check weight W falls strictly below 50 (out of 100), the final overall score is additionally scaled by `W / 100`. A project where only a handful of checks can reach a verdict should not be able to claim a perfect 100 — partial coverage means partial confidence.

There is a visible step at the W = 50 threshold: a project at W = 49 is scaled down, and one at W = 50 is not. This is intentional and documented rather than smoothed — smoothing would shift every existing user-visible score for no correctness benefit. The sequence is still monotonically non-decreasing (no dip) as coverage increases. Characterization tests pin the exact behavior in `test/scoring-coverage.test.js`; see the design note at the top of `src/scoring.js` for the rationale.

**Scoring profiles:** Five built-in profiles:
- `default` — balanced AI dev environment audit (WEIGHTS from `src/constants.js`).
- `minimal` — AI-moat checks only (mcp-config 30, coherence 30, skill-files 20, claude-md 20; rest 0).
- `ci` — CI pipelines (identical to `default` today).
- `home` — single-user dev boxes / `~/` scans. Governance / skill-files / MCP emphasized; infra / docker / windows off so coverage-scaling doesn't punish N/A infra surfaces.
- `monorepo` — same weights as `default` with hints for `--recursive --depth 3`.

See `docs/profiles/` for full weight tables. Custom weights can be set in `.rigscorerc.json`. Advisory (weight-0) checks NEVER affect the overall score — they are excluded from the coverage-penalty denominator so adding a new advisory cannot shift existing scores.

### Promoting advisory checks

Advisory checks ship at weight `0` — they never affect the score. If your
team cares about a specific advisory signal (e.g. prompt bloat from
`instruction-effectiveness`, workflow maturity, skill↔governance
coherence), promote it via `.rigscorerc.json`:

```json
{
  "weights": {
    "instruction-effectiveness": 5
  }
}
```

Promoting an advisory to a non-zero weight moves it out of the advisory
lane and into the scored lane in full. Specifically:

- It now contributes to the overall score with whatever weight you set.
- It now counts toward **coverage** — the denominator that drives
  coverage-scaling for low-applicability projects. Before promotion, a
  weight-0 check is explicitly excluded from coverage math (see
  `src/scoring.js` — `scoringApplicable` filter). After promotion, an N/A
  verdict on that check (e.g. a project with no skills dir for
  `skill-coherence`) will redistribute weight like any other N/A check.
- If you promote an advisory across a whole org, document it in your
  `.rigscorerc.json` comment so the delta from the public default score
  is traceable.

Demoting a scored check (setting `weights.<id>: 0`) is the inverse and has
the same coverage semantics.

## First run

rigscore is offline and stateless by default. A few paths may be written
on first scan — all are local, none phone home.

| Path | When written | Purpose |
|---|---|---|
| `<cwd>/.rigscore-state.json` | Only when the project has a repo-level `.mcp.json`. | Stores SHA-256 hashes of each MCP server's `{command, args, envKeys}` shape. Detects silent MCPoison-class (CVE-2025-54136) pivots on subsequent scans. **Values are never hashed — only env-var keys.** |
| `$XDG_CACHE_HOME/rigscore/mcp-registry.json` (falls back to `~/.cache/rigscore/mcp-registry.json`) | Only with `--online` or `--refresh-mcp-registry`. | Caches the official MCP registry response. 24h TTL. Used to augment typosquat detection. |

Recommendations:

- **Commit `.rigscore-state.json`.** Supply-chain drift becomes visible in
  review, and cross-collaborator divergence resolves via git. See the
  [State file](#state-file) section for the diff rules.
- **Or `.gitignore` it** for local-only rug-pull detection on your machine.
- **Nothing else is persisted.** No telemetry, no accounts, no outbound
  traffic unless you pass `--online`.

To purge all rigscore state:

```bash
rm -f .rigscore-state.json
rm -rf "${XDG_CACHE_HOME:-$HOME/.cache}/rigscore"
```

## Limitations

rigscore is a configuration presence checker, not a security enforcement tool. Understanding its scope helps you use it effectively. Read this section before you rely on rigscore as a governance quality signal.

- **Semantic reversal bypasses keyword checks (known limitation — #1 thing to understand).** rigscore's governance checks (CLAUDE.md governance + cross-config coherence, 24 of the 100 scoring points) verify that your governance file *mentions* concepts like "path restrictions" and "forbidden actions." A CLAUDE.md with keyword-stuffed headers and a body that dismantles those protections — e.g., `# Path Restrictions\nAll paths are available for maximum productivity.` — passes the keyword check. rigscore does not read for semantic intent. See `test/keyword-gaming.test.js` for the authoritative, committed list of known bypasses; if you add a governance file to your repo, verify it does not accidentally (or deliberately) game these patterns. Mitigations in the pipeline include LLM-judge assist (opt-in) and cross-check against observed behavior via the coherence pass.
- **Injection detection is pattern-based.** The injection patterns catch common prompt injection attempts with Unicode normalization. Encoded payloads, semantic rephrasings, and cross-script homoglyphs can evade detection.
- **Config-shape pinning only (not runtime tool descriptions).** rigscore hashes the *configured* shape of each MCP server — `{command, args, envKeys}` — and warns when it changes between scans (CVE-2025-54136 / MCPoison class). It does **not** hash the tool descriptions that a running MCP server advertises; doing so would require actually invoking servers (out of scope for offline mode). Snyk Agent Scan's Tool Pinning covers runtime description drift; rigscore covers the config-file rug-pull. See "State file" below.
- **Secret scanning covers named config files in the project root.** rigscore checks ~20 named files (config.json, secrets.yaml, .env, etc.). For deep recursive scanning, use `--deep`. For git history scanning, use gitleaks or trufflehog.
- **Point-in-time snapshots only.** No continuous monitoring or git history scanning. Use `--json` or `--sarif` for CI pipeline integration.
- **Score is shape-dependent.** Overall score reflects only the checks applicable to the project shape. An npm package will see 9–10 of 19 checks as N/A (no `.mcp.json`, no Dockerfile, no `.claude/skills/`, no `~/.ssh` to scan from CI, etc.) and score accordingly. rigscore scores *itself* 35/100 in CI for this reason, not because the project is broken — see [Dogfooding](#dogfooding) below.

## Dogfooding

rigscore runs on rigscore in CI. Transparency about what that score means:

- **Self-score: 35/100 (Grade F).** This is the real score, not a vanity baseline. Rigscore is an npm package; 10 of 19 checks legitimately return N/A (no MCP config, no Docker, no skill files, no `.claude/settings.json`, etc.). Score is scaled down proportionally when applicable coverage is below 50%, which is the intended behavior. If your project is seeing similar — see [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) for the diagnostic walk-through.
- **CI threshold: `--fail-under 30`.** Calibrated to the observed baseline with a 5-point regression buffer. The public default is 70 — the 40-point gap is not a vanity choice, it reflects the project-shape reality above. A lower fail-under than the public default is normal for projects that don't exercise the full check surface; document yours the same way.
- **`.rigscorerc.json` disables three checks** (`infrastructure-security`, `skill-coherence`, `workflow-maturity`) that require workspace-oriented artifacts rigscore doesn't ship. These are per-check disables at the profile level, not ignore-rules on individual findings — the distinction matters when auditing the config.

## Options

```bash
npx github:Back-Road-Creative/rigscore                           # Scan current directory
npx github:Back-Road-Creative/rigscore /path/to/project          # Scan a specific project
npx github:Back-Road-Creative/rigscore --json                    # JSON output for CI/scripting
npx github:Back-Road-Creative/rigscore --sarif                   # SARIF output for security tools
npx github:Back-Road-Creative/rigscore --ci                      # CI mode (--sarif --no-color --no-cta)
npx github:Back-Road-Creative/rigscore --fail-under 80           # Fail if score < 80 (default: 70)
npx github:Back-Road-Creative/rigscore --profile minimal         # AI-only scoring profile
npx github:Back-Road-Creative/rigscore --badge                   # Generate a markdown badge
npx github:Back-Road-Creative/rigscore --no-color                # Plain text output
npx github:Back-Road-Creative/rigscore --cta                     # Opt in to the promotional CTA (off by default)
npx github:Back-Road-Creative/rigscore --no-cta                  # Deprecated alias — CTA is already off by default; kept for back-compat
npx github:Back-Road-Creative/rigscore --check <id>              # Run a single check by ID
npx github:Back-Road-Creative/rigscore --recursive               # Scan subdirectories as projects
npx github:Back-Road-Creative/rigscore -r --depth 2              # Recursive scan, 2 levels deep
npx github:Back-Road-Creative/rigscore --deep                    # Deep source secret scanning
npx github:Back-Road-Creative/rigscore --online                  # Enable online checks (site-security, MCP supply chain)
npx github:Back-Road-Creative/rigscore --refresh-mcp-registry    # Force refetch of the MCP registry cache (implies --online; bypasses 24h TTL)
npx github:Back-Road-Creative/rigscore --include-home-skills     # Also scan ~/.claude/skills and ~/.claude/commands (default: off — project scope only)
npx github:Back-Road-Creative/rigscore --fix                     # Show auto-fixable issues (dry run)
npx github:Back-Road-Creative/rigscore --fix --yes               # Apply safe auto-remediations
npx github:Back-Road-Creative/rigscore --watch                   # Watch for changes, re-run automatically
npx github:Back-Road-Creative/rigscore --init-hook               # Install pre-commit hook
npx github:Back-Road-Creative/rigscore --ignore "env-exposure/env-not-gitignored,skill-files/shell-exec" # Suppress findings by finding ID (exact match, case-insensitive, comma-separated). See docs/FINDING_IDS.md for the stable ID list. Title-substring still works as a legacy fallback.
npx github:Back-Road-Creative/rigscore --verbose                 # Show pass/skipped findings in terminal output
npx github:Back-Road-Creative/rigscore --version                 # Version info
npx github:Back-Road-Creative/rigscore --help                    # Show help
```

### Exit codes

rigscore exits with a stable code so CI can branch cleanly:

| Code | Meaning |
|---|---|
| `0` | Scan completed. Score is at or above `--fail-under`. In baseline/diff mode: no new findings vs baseline. |
| `1` | Scan completed. Score is below `--fail-under`, OR (baseline mode) new findings were detected. |
| `2` | Configuration error — malformed `.rigscorerc.json`, unknown `--profile`, invalid target directory, unreadable baseline file, or bad input to `mcp-hash` / `mcp-pin` / `mcp-verify`. |
| `3` | Reserved for subcommand pre-conditions. Currently used by `rigscore mcp-verify <server>` when no runtime tool hash is pinned for that server. The main scan path does not emit `3`. |

A runtime crash inside a check surfaces as exit `2` with `Error: scan failed: ...` on stderr; it does not currently use a distinct code. CI authors should treat non-zero as failure and branch only on `0` vs `1` for score-gating logic.

### Watch mode

`--watch` re-runs rigscore automatically when relevant files change. It monitors governance files, MCP configs, `.env`, Docker Compose files, git hooks, and `.rigscorerc.json`. Changes are debounced (500ms) to avoid rapid re-scans.

```bash
npx github:Back-Road-Creative/rigscore --watch
npx github:Back-Road-Creative/rigscore --watch --verbose
```

### Pre-commit hook

`--init-hook` installs a git pre-commit hook that runs rigscore before each commit:

```bash
npx github:Back-Road-Creative/rigscore --init-hook
```

This creates (or appends to) `.git/hooks/pre-commit` with `npx github:Back-Road-Creative/rigscore --fail-under 70 --no-cta || exit 1`. If the hook already contains rigscore, it skips installation.

### Recursive mode

For monorepos and multi-project workspaces, `--recursive` discovers project subdirectories and scans each independently. A directory is considered a project if it contains any recognizable marker file (package.json, pyproject.toml, Dockerfile, docker-compose.yml, CLAUDE.md, .env, etc.).

```bash
# Scan all projects one level deep
npx github:Back-Road-Creative/rigscore . --recursive

# Scan two levels (e.g., workspace/_active/svc-foo)
npx github:Back-Road-Creative/rigscore . -r --depth 2

# JSON output with per-project breakdown
npx github:Back-Road-Creative/rigscore . -r --depth 2 --json

# SARIF output with one run per project
npx github:Back-Road-Creative/rigscore . -r --depth 2 --sarif
```

The overall score uses the **average** across all discovered projects. Hidden directories, `node_modules`, `venv`, and `__pycache__` are automatically skipped. Recursive scanning runs projects concurrently (4 at a time) for performance.

### Auto-fix

`--fix` identifies safe, reversible remediations and shows what would be changed:

```bash
# Dry run — see what would be fixed
npx github:Back-Road-Creative/rigscore --fix

# Apply fixes
npx github:Back-Road-Creative/rigscore --fix --yes
```

**Safe fixes only:**
- Add `.env` to `.gitignore`
- `chmod 600` on `.env` files
- `chmod 700` on `~/.ssh`
- `chmod 600` on SSH private keys

rigscore never modifies governance file content.

### Plugins

rigscore auto-discovers `rigscore-check-*` packages from `node_modules`. Plugins extend rigscore with custom checks without modifying the core.

**Creating a plugin:**

```javascript
// rigscore-check-my-custom/index.js
export default {
  id: 'my-custom',
  name: 'My Custom Check',
  category: 'governance',  // governance | secrets | isolation | supply-chain | process
  async run(context) {
    const findings = [];
    // Your check logic here
    // context.cwd, context.homedir, context.config available
    return { score: 100, findings };
  },
};
```

**Plugin weights:** By default, plugin checks have weight 0 (advisory). Set custom weights in `.rigscorerc.json`:

```json
{
  "weights": {
    "my-custom": 5
  }
}
```

Plugins must export `id`, `name`, `category` (strings), and `run` (async function). Invalid plugins produce a warning to stderr but don't crash the scan. Scoped packages (`@org/rigscore-check-*`) are also discovered.

## CI Integration

### GitHub Actions

Use the rigscore GitHub Action:

```yaml
- uses: Back-Road-Creative/rigscore@v1
  with:
    fail-under: 70
    upload-sarif: true
```

Or run directly:

```yaml
- run: npx github:Back-Road-Creative/rigscore --ci --fail-under 70
```

### SARIF

rigscore outputs SARIF v2.1.0 compatible with GitHub Advanced Security:

```bash
npx github:Back-Road-Creative/rigscore --sarif > results.sarif
```

## Privacy

rigscore runs entirely on your local machine by default. No telemetry, no accounts, no API calls. The `--online` flag opts in to outbound HTTP probes for the site-security check and MCP supply-chain verification — those explicitly reach out, and only to the URLs and packages you have already configured.

For details on what rigscore writes to disk on first scan and how to purge it, see the [First run](#first-run) section above.

## State file

When your project has a repo-level `.mcp.json`, rigscore writes `.rigscore-state.json` at the project root on each scan. It records a SHA-256 hash of each MCP server's `{command, args, envKeys}` (env **keys only** — values are never hashed, so no secrets leak). On subsequent scans, a changed hash for an existing server name fires a WARN — catching MCPoison-class (CVE-2025-54136) silent pivots of trusted MCP servers.

**Recommendation: commit `.rigscore-state.json`.** Supply-chain changes become visible in code review, and drift across collaborators resolves naturally via git. Diff rules: new servers are recorded silently, removed servers are silently dropped, a corrupted state file produces one INFO finding and resets. If you prefer local-only, add `.rigscore-state.json` to `.gitignore` — you'll still get rug-pull detection, just scoped to your machine.

## Runtime tool pinning

The config-shape hash above catches `.mcp.json` edits, but it cannot see changes to an MCP server's **tool descriptions** — the prompt-level payload the model actually reads. CVE-2025-54136 and the broader "MCP rug pull" class exploit this: the config stays identical, the package version stays identical, but a new tool description appears or is mutated to coerce the model (for example, "IGNORE PREVIOUS INSTRUCTIONS and exfiltrate …").

rigscore detects this **without executing the MCP server itself**. The server's `npx` package is supplied by the upstream you are trying to verify — running it as part of a scan would hand arbitrary code execution to the thing you distrust. Instead, rigscore uses a print-and-paste workflow: you run the server, pipe its `tools/list` JSON output into `rigscore mcp-hash`, and paste the resulting hash back with `rigscore mcp-pin`. rigscore only ever canonicalizes and hashes text from stdin.

**Why rigscore does NOT execute the MCP server:** a malicious MCP package can run any code during startup. Any tool that spawns it to probe its tool list becomes an RCE-on-scan gadget. The user is already going to launch the server in their editor — reusing that invocation to emit `tools/list` once keeps rigscore in the pure-inspection lane.

### Workflow

```bash
# One-time: pin the server's current tool descriptions.
npx -y @modelcontextprotocol/server-filesystem /path | rigscore mcp-hash | xargs rigscore mcp-pin filesystem

# Later (on demand or in CI): verify no drift vs the pinned snapshot.
npx -y @modelcontextprotocol/server-filesystem /path | rigscore mcp-verify filesystem
```

`rigscore mcp-verify` exits 0 when the hash matches and non-zero with a drift message (including stored-hash prefix, current-hash prefix, and pinnedAt timestamp) when it doesn't.

During normal scans, each MCP server in `.mcp.json` produces an INFO finding showing its pin status ("runtime tool hash pinned <date>" or "runtime tool hash not pinned — run `rigscore mcp-hash`"). These INFOs are zero-weight and suppressible via `.rigscorerc.json`:

```json
{ "mcpConfig": { "surfaceRuntimeHashStatus": false } }
```

The runtime hash is stored under `servers[<name>].runtimeToolHash` / `runtimeToolPinnedAt` in `.rigscore-state.json`, alongside the existing `mcpServers` config-shape map. State schema version stays at 1.

## Documentation

Supplementary docs live under `docs/`:

- [`docs/FINDING_IDS.md`](docs/FINDING_IDS.md) — stable finding-ID
  reference. Use when pinning `--ignore` patterns, writing
  `.rigscorerc.json` `suppress:` entries, or ingesting SARIF ruleIds.
- [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) — operational FAQ.
  Why is my score an F, what changed after upgrading, WSL2 gotchas, how
  to re-pin the pre-commit hook, baseline diff behavior.
- [`docs/examples/`](docs/examples/) — starter skill / rules templates
  for Cursor, Cline, Continue, Windsurf, and Aider. Calibrated to pass
  rigscore's default profile.
- [`docs/checks/`](docs/checks/) — per-check reference with Purpose,
  Triggers, Weight rationale, Fix semantics, SARIF, and Example. One
  page per module in `src/checks/`.
- [`docs/profiles/`](docs/profiles/) — weight tables for each scoring
  profile (`default`, `minimal`, `ci`, `home`, `monorepo`).

## Contributing

Issues and PRs welcome. If you find a check that's missing or a false positive, [open an issue](https://github.com/Back-Road-Creative/rigscore/issues).

### Fixture dogfood

The repo ships a deliberately-imperfect fixture project at
`test/fixtures/scored-project/` that exercises most of the check surface.
The assertion suite in `test/fixture-dogfood.test.js` imports the in-process
scanner API and locks:

- total actionable finding count (±4 tolerance)
- overall score (documented band)
- a handful of specific critical findings by id (title-substring fallback)

Rigscore's self-scan returns N/A on ~half the check surface — the dogfood
fixture fills that gap so behavioral regressions surface as test failures
instead of silently changing the real self-score.

Run the fixture suite by itself:

```bash
npm run test:fixture
```

To regenerate the locked count/score band when a check intentionally
changes, re-run with the characterization switch and commit the diff:

```bash
UPDATE_FIXTURES=1 npm run test:fixture
```

See `test/fixtures/scored-project/README.md` and `EXPECTED-FINDINGS.md` for
the fixture layout and the intended finding list.

### Adding a check

Each check is a module in `src/checks/` that exports a standard interface:

```javascript
export default {
  id: 'my-check',
  name: 'My new check',
  category: 'governance',  // governance | secrets | isolation | supply-chain | process

  async run(context) {
    // context.cwd = working directory
    // context.homedir = user home directory
    // context.config = loaded .rigscorerc.json config
    return {
      score: 0-100,
      findings: [{
        severity: 'critical', // critical | warning | info | skipped | pass
        title: 'What was found',
        detail: 'Why it matters',
        remediation: 'How to fix it',
        learnMore: 'https://...'  // optional — rendered as link in terminal output
      }]
    }
  }
}
```

Weights are defined in `src/constants.js` WEIGHTS map (single source of truth). Check modules do not define their own weight.

## Verify this release

Signed `v*` releases ship with a CycloneDX SBOM and a GitHub build-provenance attestation generated by `.github/workflows/release-provenance.yml`. A third party can verify a release without trusting the author:

```bash
scripts/verify-release.sh v0.9.0-rc1
```

Run `scripts/verify-release.sh --help` for details. Full verification walkthrough lands in the upcoming `/docs/verify/` page.

## License

MIT

## Author

Built by [Joe Petrucelli](https://headlessmode.com) — technologist, AI agent security, 25 years building and securing enterprise systems.

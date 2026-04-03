# rigscore

**A configuration hygiene checker for your AI development environment.**

One command. 14 checks. A hygiene score out of 100. Know where you stand before something breaks.

```bash
npx github:Back-Road-Creative/rigscore
```

```
  ╭────────────────────────────────────────╮
  │                                        │
  │        rigscore v0.7.2                 │
  │   AI Dev Environment Hygiene Check     │
  │                                        │
  ╰────────────────────────────────────────╯

  Scanning /home/user/my-project ...

  ✗ MCP server configuration...... 0/16
  ✓ Cross-config coherence........ 16/16
  ✓ Skill file safety............. 10/10
  ✓ CLAUDE.md governance.......... 10/10
  ✓ Claude settings safety........ 8/8
  ✗ Deep source secrets........... N/A
  ✓ Secret exposure............... 8/8
  ✓ Credential storage............ 6/6
  ✓ Docker security............... 6/6
  ✓ Unicode steganography......... 4/4
  ✗ Git hooks..................... 2/4
  ✓ Permissions hygiene........... 4/4
  ~ Windows/WSL security.......... advisory
  ~ Network exposure.............. advisory

  ╭────────────────────────────────────────╮
  │                                        │
  │         HYGIENE SCORE: 74/100          │
  │         Grade: C                       │
  │         Risk: Standard                 │
  │                                        │
  ╰────────────────────────────────────────╯

  CRITICAL (1)
  ✗ MCP server "filesystem" has broad filesystem access: /
    → Scope filesystem access to your project directory only.

  WARNING (1)
  ⚠ No pre-commit hooks installed
    → Fix: Install Husky or lefthook and add pre-commit hooks.
```

## Why this exists

AI coding tools are powerful. Claude Code, Cursor, Windsurf, and autonomous agents can read your filesystem, execute commands, call APIs, and modify your codebase. Most developers set them up fast and never audit the configuration hygiene.

rigscore checks the things that matter:

- Does your AI agent have governance rules, or is it operating without boundaries?
- Are your MCP servers scoped to project directories, or can they access your entire filesystem?
- Are your API keys in `.gitignore`, or one commit away from being public?
- Are your containers configured safely, or is the socket exposed?
- Do you have commit hooks catching mistakes, or is everything going straight to the repo?
- Are your skill files clean, or could they contain injection payloads?
- Are file permissions locked down, or are sensitive files world-readable?
- Do your governance claims match your actual configuration?
- Are there hardcoded secrets buried in your source code?
- Is your Windows/WSL boundary more porous than you think?
- Do your Claude settings expose dangerous permissions or bypass combos?
- Are credentials stored correctly, or are they leaking into the wrong places?
- Are there hidden characters in your skill files that could redirect agent behavior?

Run it. See the score. Fix what's broken.

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

## What it checks

### 1. MCP server configuration (16 points) {#mcp-permissions}

[MCP (Model Context Protocol)](https://modelcontextprotocol.io/) lets AI agents connect to external tools via servers. Each server exposes capabilities — filesystem access, API calls, database queries. The security risk is in the permissions.

rigscore scans MCP configs across all major clients: Claude (`.mcp.json`, `.vscode/mcp.json`), Cursor (`~/.cursor/mcp.json`), Cline (`~/.cline/mcp_settings.json`), Continue (`~/.continue/config.json`), Windsurf (`~/.windsurf/mcp.json`), Zed (`~/.config/zed/settings.json`), and Amp (`~/.amp/mcp.json`).

**What rigscore looks for:**
- Transport type: `stdio` (local, safer) vs. `sse` (network, riskier)
- Wildcard environment passthrough (`env: {...process.env}`) — exposes all your env vars to the server
- Filesystem scope: is the server limited to project directories, or does it have access to `/`?
- Version pinning: are packages locked to specific versions, or using `@latest`?
- Cross-client configuration drift: are the same servers configured differently across clients?
- Typosquatting detection: is a package name suspiciously close to a known MCP server? (~52 known servers)

**Supply chain risk:** An MCP server installed as `@latest` today could push a malicious update tomorrow. Version pinning prevents this. {#mcp-supply-chain}

**What to fix:** Scope filesystem servers to your project directory only. Remove wildcard env passthrough — pass only the specific variables each server needs. Pin all server packages to exact versions. Prefer `stdio` transport unless you specifically need network access.

### 2. Cross-config coherence (16 points) {#coherence-check}

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
- 34 secret patterns: API keys from Anthropic, OpenAI, AWS, GitHub, Slack, Stripe, SendGrid, Twilio, Firebase, DigitalOcean, Mailgun, npm, PyPI, Hugging Face, MongoDB, Vercel, Supabase, Cloudflare, Railway, PlanetScale, Neon, Linear, Replicate, Tavily, and webhook signing secrets
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

### 10. Unicode steganography detection (4 points) {#unicode-steganography}

Checks skill files and CLAUDE.md for hidden characters that render identically to legitimate text but redirect agent behavior. Covers the attack surface from the ToxicSkills and Rules File Backdoor incidents.

**What rigscore looks for:**
- Greek/Armenian/Georgian lookalikes that render as Latin letters
- Zero-width joiners and zero-width non-joiners
- Bidirectional control characters (bidi overrides)

### 11. Git hooks (4 points) {#git-hooks-for-ai}

Git hooks are your last line of defense before code leaves your machine. Without pre-commit hooks, secrets, broken governance files, and unreviewed changes go straight to the repo.

**What rigscore looks for:**
- Pre-commit hooks present (`.git/hooks/pre-commit` or a hook manager like Husky/lefthook)
- Claude Code hooks (`.claude/settings.json` with hook configuration)
- Push URL guards (`.git/config` with `pushurl = no_push`)
- External hook directories from config

**What to fix:** Install [Husky](https://github.com/typicode/husky) or [lefthook](https://github.com/evilmartians/lefthook) and add pre-commit hooks that scan for secret patterns and validate governance files.

### 12. Permissions hygiene (4 points) {#permissions-hygiene}

File permissions are the foundation of access control. Misconfigured permissions on SSH keys, secret files, or governance files can undermine every other security measure.

**What rigscore looks for:**
- SSH directory permissions (`~/.ssh` should be 700)
- SSH private key permissions (should be 600)
- World-readable sensitive files in the project (`.pem`, `.key`, `*credentials*`)
- Governance file ownership consistency (mixed UIDs may indicate unauthorized modifications)

**What to fix:** Run `chmod 700 ~/.ssh` and `chmod 600 ~/.ssh/id_*`. Ensure sensitive files are not world-readable. Verify all governance files are owned by the same user.

**Platform note:** Permission checks are POSIX-only. On Windows, rigscore reports a SKIPPED finding and recommends manual verification with `icacls`.

### 13. Windows/WSL security (advisory, 0 points) {#windows-security}

On Windows, rigscore checks for WSL-specific security risks. This is an advisory check — it doesn't affect the score but surfaces important configuration issues.

**What rigscore looks for:**
- WSL interop settings — warns if Windows PATH leaks into WSL (`appendWindowsPath=true`)
- `.wslconfig` firewall and networking mode
- Windows Defender exclusions that include project directories or `node_modules`
- NTFS permissions advisory for sensitive files

**Platform note:** Returns N/A on non-Windows systems. Weight 0 means it never affects the score.

### 14. Network exposure (advisory, 0 points) {#network-exposure}

Advisory check that detects AI services bound to `0.0.0.0` instead of `127.0.0.1`. Scans MCP config URLs, Docker port bindings, Ollama config, and live listeners.

## Scoring

| Score | Grade | Meaning |
|-------|-------|---------|
| 90-100 | A | Strong hygiene posture |
| 75-89 | B | Good foundation, some gaps |
| 60-74 | C | Moderate risk, needs attention |
| 40-59 | D | Significant gaps |
| 0-39 | F | Critical issues, fix immediately |

Scoring uses an additive deduction model with moat-heavy weighting — AI-specific checks (MCP, coherence, skill files, governance) account for ~60% of the score:

| Check | Weight | Category |
|-------|--------|----------|
| MCP server configuration | 16 | supply-chain |
| Cross-config coherence | 16 | governance |
| Skill file safety | 10 | supply-chain |
| CLAUDE.md governance | 10 | governance |
| Claude settings safety | 8 | governance |
| Deep source secrets | 8 | secrets |
| Secret exposure | 8 | secrets |
| Credential storage hygiene | 6 | secrets |
| Docker security | 6 | isolation |
| Unicode steganography | 4 | supply-chain |
| Git hooks | 4 | process |
| Permissions hygiene | 4 | process |
| Windows/WSL security | 0 | isolation (advisory) |
| Network exposure | 0 | isolation (advisory) |

- **CRITICAL** findings zero out their sub-check entirely
- **WARNING** findings deduct 15 points each (1 WARNING = 85, 2 = 70, 3 = 55...)
- **INFO** findings deduct 2 points each, with a floor of 50 when no WARNINGs are present
- **PASS** and **SKIPPED** findings have no score impact

**Compound risk penalty:** When the coherence check finds a CRITICAL contradiction, 10 additional points are deducted from the overall score — reflecting the systemic nature of governance failures.

**Coverage penalty:** Checks that find nothing to scan are marked N/A and excluded from the weighted average. If the total applicable check weight falls below 50%, the overall score is scaled down proportionally — this prevents projects with minimal configuration from appearing fully secure.

**Scoring profiles:** Use `--profile minimal` to focus only on AI-specific checks, or `--profile ci` for CI pipelines. Custom weights can be set in `.rigscorerc.json`.

## Limitations

rigscore is a configuration presence checker, not a security enforcement tool. Understanding its scope helps you use it effectively:

- **Governance checks verify keyword presence, not semantic intent.** rigscore checks that your governance file mentions concepts like "forbidden actions" and "path restrictions." It cannot verify that those boundaries are actually enforced.
- **Injection detection is pattern-based.** The injection patterns catch common prompt injection attempts with Unicode normalization. Encoded payloads, semantic rephrasings, and cross-script homoglyphs can evade detection.
- **Secret scanning covers named config files in the project root.** rigscore checks ~20 named files (config.json, secrets.yaml, .env, etc.). For deep recursive scanning, use `--deep`. For git history scanning, use gitleaks or trufflehog.
- **Point-in-time snapshots only.** No continuous monitoring or git history scanning. Use `--json` or `--sarif` for CI pipeline integration.

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
npx github:Back-Road-Creative/rigscore --no-cta                  # Suppress promotional CTA
npx github:Back-Road-Creative/rigscore --check <id>              # Run a single check by ID
npx github:Back-Road-Creative/rigscore --recursive               # Scan subdirectories as projects
npx github:Back-Road-Creative/rigscore -r --depth 2              # Recursive scan, 2 levels deep
npx github:Back-Road-Creative/rigscore --deep                    # Deep source secret scanning
npx github:Back-Road-Creative/rigscore --fix                     # Show auto-fixable issues (dry run)
npx github:Back-Road-Creative/rigscore --fix --yes               # Apply safe auto-remediations
npx github:Back-Road-Creative/rigscore --watch                   # Watch for changes, re-run automatically
npx github:Back-Road-Creative/rigscore --init-hook               # Install pre-commit hook
npx github:Back-Road-Creative/rigscore --ignore "finding-id"     # Suppress a specific finding
npx github:Back-Road-Creative/rigscore --version                 # Version info
npx github:Back-Road-Creative/rigscore --help                    # Show help
```

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

rigscore runs entirely on your local machine. No data is collected, transmitted, or stored anywhere. No API calls. No telemetry. No accounts. The scan reads your local config files and outputs results to your terminal. That's it.

## Contributing

Issues and PRs welcome. If you find a check that's missing or a false positive, [open an issue](https://github.com/Back-Road-Creative/rigscore/issues).

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

## License

MIT

## Author

Built by [Joe Petrucelli](https://headlessmode.com) — technologist, AI agent security, 25 years building and securing enterprise systems.

# rigscore

**A configuration hygiene checker for your AI development environment.**

One command. 7 checks. A hygiene score out of 100. Know where you stand before something breaks.

```bash
npx rigscore
```

```
  ╭────────────────────────────────────────╮
  │                                        │
  │        rigscore v0.1.0                 │
  │   AI Dev Environment Hygiene Check     │
  │                                        │
  ╰────────────────────────────────────────╯

  Scanning /home/user/my-project ...

  ✗ CLAUDE.md governance.......... 0/20
  ✓ MCP server configuration...... 15/15
  ✓ Secret exposure............... 20/20
  ✓ Docker security............... 15/15
  ✗ Git hooks..................... 5/10
  ✓ Skill file safety............. 10/10
  ✓ Permissions hygiene........... 10/10

  ╭────────────────────────────────────────╮
  │                                        │
  │         HYGIENE SCORE: 75/100           │
  │         Grade: B                       │
  │                                        │
  ╰────────────────────────────────────────╯

  CRITICAL (1)
  ✗ No CLAUDE.md found
    → Without a CLAUDE.md governance file, AI agents operate
      without explicit boundaries or rules.

  WARNING (1)
  ⚠ No pre-commit hooks installed
    → Without commit hooks, secrets and governance file changes
      can be committed unchecked.
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

Run it. See the score. Fix what's broken.

## Install and run

No setup. No accounts. No data leaves your machine.

```bash
# Run on the current directory
npx rigscore

# Run on a specific project
npx rigscore /path/to/project

# Output as JSON (for CI integration)
npx rigscore --json

# Generate a README badge
npx rigscore --badge

# Scan a monorepo (recursive mode)
npx rigscore . --recursive --depth 2

# Run a single check
npx rigscore --check docker-security
```

## What it checks

### 1. CLAUDE.md governance (20 points) {#why-claude-md-matters}

Your CLAUDE.md file tells AI agents what they can and can't do. Without one, your agent operates with no explicit rules — it can access any file, run any command, and make any API call that its underlying permissions allow.

rigscore recognizes governance files for all major AI coding clients: CLAUDE.md, `.cursorrules`, `.windsurfrules`, `.clinerules`, `.continuerules`, `copilot-instructions.md`, `AGENTS.md`, and `.aider.conf.yml`.

**What rigscore looks for:**
- Does a governance file exist in the project root?
- Does it contain forbidden action rules?
- Does it have human-in-the-loop approval gates?
- Does it restrict file and directory access?
- Does it restrict network and API access?
- Does it include anti-injection instructions?

**A good CLAUDE.md is not a wishlist.** It's mechanical enforcement. "Don't do X" is behavioral — the agent might ignore it. File permissions, hook scripts, and gated approvals are mechanical — they work regardless of what the agent tries. {#claude-md-hardening}

**What to fix:** Create a governance file with explicit execution boundaries, forbidden actions, file access restrictions, and approval gates. Be specific — "don't access sensitive files" is too vague. List the exact directories and operations that are off-limits.

### 2. MCP server configuration (15 points) {#mcp-permissions}

[MCP (Model Context Protocol)](https://modelcontextprotocol.io/) lets AI agents connect to external tools via servers. Each server exposes capabilities — filesystem access, API calls, database queries. The security risk is in the permissions.

rigscore scans MCP configs across all major clients: Claude (`.mcp.json`, `.vscode/mcp.json`), Cursor (`~/.cursor/mcp.json`), Cline (`~/.cline/mcp_settings.json`), Continue (`~/.continue/config.json`), and Windsurf (`~/.windsurf/mcp.json`).

**What rigscore looks for:**
- Transport type: `stdio` (local, safer) vs. `sse` (network, riskier)
- Wildcard environment passthrough (`env: {...process.env}`) — exposes all your env vars to the server
- Filesystem scope: is the server limited to project directories, or does it have access to `/`?
- Version pinning: are packages locked to specific versions, or using `@latest`?

**Supply chain risk:** An MCP server installed as `@latest` today could push a malicious update tomorrow. Version pinning prevents this. {#mcp-supply-chain}

**What to fix:** Scope filesystem servers to your project directory only. Remove wildcard env passthrough — pass only the specific variables each server needs. Pin all server packages to exact versions. Prefer `stdio` transport unless you specifically need network access.

### 3. Secret exposure (20 points) {#env-security}

API keys, tokens, and credentials in the wrong places are the most common security failure in any codebase — and AI development makes it worse because agents read config files, skill files, and environment variables as part of their normal operation.

**What rigscore looks for:**
- `.env` files present but not in `.gitignore`
- API key patterns in config files, governance files, skill files, or MCP configs (patterns: `sk-`, `AKIA`, `key-`, common token formats)
- `.env` file permissions (world-readable vs. user-only)
- SOPS encryption detection

**What to fix:** Add `.env` to `.gitignore` immediately. Set `.env` permissions to `600` (user read/write only). Never hardcode API keys in governance or config files. Use environment variables and pass them explicitly.

### 4. Container security (15 points) {#docker-isolation}

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

### 5. Git hooks (10 points) {#git-hooks-for-ai}

Git hooks are your last line of defense before code leaves your machine. Without pre-commit hooks, secrets, broken governance files, and unreviewed changes go straight to the repo.

**What rigscore looks for:**
- Pre-commit hooks present (`.git/hooks/pre-commit` or a hook manager like Husky/lefthook)
- Claude Code hooks (`.claude/settings.json` with hook configuration)
- Push URL guards (`.git/config` with `pushurl = no_push`)
- External hook directories from config

**What to fix:** Install [Husky](https://github.com/typicode/husky) or [lefthook](https://github.com/evilmartians/lefthook) and add pre-commit hooks that scan for secret patterns and validate governance files.

### 6. Skill file safety (10 points) {#skill-file-injection}

Skill files (`.cursorrules`, `.windsurfrules`, `.continuerules`, `copilot-instructions.md`, `AGENTS.md`, `.aider.conf.yml`) tell AI agents how to behave. They're also a prompt injection vector — malicious instructions embedded in skill files can override agent behavior.

**What rigscore looks for:**
- Instruction override patterns ("ignore previous instructions", "disregard", "new system prompt")
- Shell execution instructions embedded in skill files
- External URL references (potential data exfiltration)
- Base64 or encoded content (obfuscated payloads)
- File permissions (writable by others?)

**What to fix:** Audit all skill files for unexpected instructions. Lock file permissions so only you can modify them. Be cautious with skill files from untrusted sources — treat them like executable code, because that's effectively what they are.

### 7. Permissions hygiene (10 points) {#permissions-hygiene}

File permissions are the foundation of access control. Misconfigured permissions on SSH keys, secret files, or governance files can undermine every other security measure.

**What rigscore looks for:**
- SSH directory permissions (`~/.ssh` should be 700)
- SSH private key permissions (should be 600)
- World-readable sensitive files in the project (`.pem`, `.key`, `*credentials*`)
- Governance file ownership consistency (mixed UIDs may indicate unauthorized modifications)

**What to fix:** Run `chmod 700 ~/.ssh` and `chmod 600 ~/.ssh/id_*`. Ensure sensitive files are not world-readable. Verify all governance files are owned by the same user.

**Platform note:** Permission checks are POSIX-only. On Windows, rigscore reports a SKIPPED finding and recommends manual verification with `icacls`.

## Scoring

| Score | Grade | Meaning |
|-------|-------|---------|
| 90-100 | A | Strong hygiene posture |
| 75-89 | B | Good foundation, some gaps |
| 60-74 | C | Moderate risk, needs attention |
| 40-59 | D | Significant gaps |
| 0-39 | F | Critical issues, fix immediately |

Each CRITICAL finding zeroes out its sub-check. Each WARNING reduces it by 50%. INFO findings reduce it slightly (5% each). Checks that find nothing to scan are marked N/A and excluded from the score.

## Options

```bash
npx rigscore                           # Scan current directory
npx rigscore /path/to/project          # Scan a specific project
npx rigscore --json                    # JSON output for CI/scripting
npx rigscore --badge                   # Generate a markdown badge
npx rigscore --no-color                # Plain text output
npx rigscore --check <id>              # Run a single check by ID
npx rigscore --recursive               # Scan subdirectories as projects
npx rigscore -r --depth 2              # Recursive scan, 2 levels deep
npx rigscore --version                 # Version info
npx rigscore --help                    # Show help
```

### Recursive mode

For monorepos and multi-project workspaces, `--recursive` discovers project subdirectories and scans each independently. A directory is considered a project if it contains any recognizable marker file (package.json, pyproject.toml, Dockerfile, docker-compose.yml, CLAUDE.md, .env, etc.).

```bash
# Scan all projects one level deep
npx rigscore . --recursive

# Scan two levels (e.g., workspace/_active/svc-foo)
npx rigscore . -r --depth 2

# JSON output with per-project breakdown
npx rigscore . -r --depth 2 --json
```

The overall score uses the **average** across all discovered projects. Hidden directories, `node_modules`, `venv`, and `__pycache__` are automatically skipped.

## Privacy

rigscore runs entirely on your local machine. No data is collected, transmitted, or stored anywhere. No API calls. No telemetry. No accounts. The scan reads your local config files and outputs results to your terminal. That's it.

## Contributing

Issues and PRs welcome. If you find a check that's missing or a false positive, [open an issue](https://github.com/backroadcreative/rigscore/issues).

### Adding a check

Each check is a module in `src/checks/` that exports a standard interface:

```javascript
export default {
  id: 'my-check',
  name: 'My new check',
  category: 'governance',  // governance | secrets | isolation | supply-chain | process
  weight: 10,              // max points this check contributes

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
        learnMore: 'https://...'
      }]
    }
  }
}
```

## License

MIT

## Author

Built by [Joe Petrucelli](https://headlessmode.com) — technologist, AI agent security, 25 years building and securing enterprise systems.

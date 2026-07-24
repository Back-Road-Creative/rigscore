# Finding IDs — stability contract

rigscore emits each finding against a check. For consumers that ingest
rigscore output programmatically (SARIF to GitHub Advanced Security,
baseline diffs, `--ignore <id>`, custom fixers), the **finding ID** is the
stable handle. This page documents what that ID is, how it behaves across
versions, and which IDs the current release actually guarantees.

## ID format

```
<check-id>/<slug>
```

- `<check-id>` — the module id from `src/checks/<id>.js` (e.g. `skill-files`,
  `env-exposure`, `permissions-hygiene`).
- `<slug>` — a lowercase, hyphen-separated identifier for the specific
  condition inside that check (e.g. `shell-exec`, `ssh-dir-permissions`).

Example: `skill-files/indirect-injection`.

In SARIF output the finding ID appears as the per-result `ruleId`. In JSON
output it is the `findingId` field on each finding. `--ignore
<check-id>/<slug>` matches on this string (exact, case-insensitive).

## What else a SARIF result carries

Alongside `ruleId`, each SARIF result carries the fix text the check computed:

- **`result.properties.remediation`** — the fix, machine-readable. Remediation
  is **per-result, not per-rule**: several findings routinely share one
  `ruleId` (`workflow-maturity/skill-no-eval` fires once per skill, each with
  its own fix text), so it is never hoisted onto the rule.
- **`result.message.text`** — the same fix is appended as `Fix: <remediation>`
  after the existing `<title>: <detail>` line. GitHub code scanning ignores
  SARIF property bags it does not understand, so this is the surface that
  actually renders the fix in the code-scanning UI.
- **`rules[].helpUri` / `rules[].help`** — a finding's `learnMore` URL. This
  one *is* rule-level: it is a constant doc link per finding class, and
  `helpUri` is a `reportingDescriptor` property in SARIF 2.1.0 (§3.49.12),
  never a result property.

A finding with no `remediation` emits no `remediation` key at all — no `null`,
no empty string. Same for `learnMore` / `helpUri`.

## Suppression is reported, not silent

Findings muted by `--ignore` or a `.rigscorerc.json` `suppress:` entry are
still removed from scoring, but rigscore now surfaces **how many** and **which
ids** so the muting is visible in its own output — not only in a config diff:

- **Human report** — a `Suppressed N finding(s) via config/--ignore: <ids>` line
  (so it lands in any CI log).
- **JSON** — a top-level `suppressed: { count, ids }` field.
- **SARIF** — `runs[0].properties.suppressedCount` and
  `runs[0].properties.suppressedIds`. The muted findings are **not** re-added to
  `runs[0].results` (that would be a SARIF `suppressions[]` change); this is a
  count/note only.

## Stability contract

- **No renames within a major version.** Once a finding ID ships in a
  `v<major>.x.y` release it is not renamed or removed for the lifetime of
  that major version.
- **New IDs may be added in minor releases.** A minor version (e.g.
  `v1.1.0`) may introduce new finding IDs — it will not rename existing
  ones.
- **Deprecations are announced in CHANGELOG** and the old ID is kept as an
  alias for at least one full major version, so CI suppressions and
  baselines don't silently break on upgrade.
- **Check-level IDs** (the bare `<check-id>`, no slash) are also stable and
  usable with `--ignore` to silence an entire check.

### Renamed IDs (working aliases)

Old ID → current ID. The old ID keeps working as a `--ignore` / `suppress:` /
`weights:` alias for at least one full major version (implemented in
`src/findings.js::FINDING_ID_RENAMES`, consumed by `compileSuppressPattern` and
`resolveWeights`; the current check-level rule also carries the old id as a
SARIF `reportingDescriptor.deprecatedIds`):

| Old ID | Current ID | Since |
|---|---|---|
| `claude-md` | `governance-docs` | v2.x |

The flagship 10-point check scans the vendor-neutral governance-file superset
(`CLAUDE.md`, `AGENTS.md`, `.cursorrules`, `.windsurfrules`, …), so the
Claude-only `claude-md` name was a misbrand. A rc keyed on `claude-md` — a
suppression, a baseline, or a `weights: { "claude-md": N }` override — still
resolves to `governance-docs`.

## Full enforcement (v2.x)

As of v2.x the stability contract applies to **every** finding ID emitted by
the built-in checks, and `npm run verify:docs` enforces that per **ID** (not
per check): a literal ID a check emits and this page does not list fails CI.
That includes the not-applicable / scan-limit states (`skill-files/no-skill-files`,
`claude-settings/hook-file-cap-reached`, …) — they carry a stable ID too, so
they are documented rather than carved out. The SARIF title-slug
fallback in `src/sarif.js::deriveFindingRuleId` is retained only as a
defensive safety net for plugin-authored checks that skip explicit IDs —
no built-in check should rely on it.

Suppressing a finding via `--ignore <id>`, `suppress:` in
`.rigscorerc.json`, or a baseline file is safe for any ID listed below.

For IDs whose slug includes a dynamic fragment (e.g.
`governance-docs/actively-negates-<category>`,
`governance-docs/missing-<category>`,
`skill-files/escalation-<patternId>`,
`documentation/docs-gate-<reason>`,
`skill-coherence/constraint-unaware-<constraint-id>`) the dynamic
fragment is also stable — it is derived from a closed enumeration
(QUALITY_CHECKS names, ESCALATION pattern ids, docs-gate reasons, and
user-provided constraint ids respectively).

## Explicitly emitted finding IDs

Grouped by check. Each ID is stable within the current major.

### governance-docs

- `governance-docs/no-governance-file` (critical) — no CLAUDE.md or equivalent found.
- `governance-docs/governance-file-short` (warning) — governance file < 50 lines.
- `governance-docs/actively-negates-<category>` (critical) — negated governance keyword (category slugified from QUALITY_CHECKS name).
- `governance-docs/missing-<category>` (warning) — missing governance category.
- `governance-docs/governance-reversal-detected` (warning) — keyword-stuffed header dismantled in body (C7).
- `governance-docs/injection-pattern` (critical) — instruction-override pattern found in governance file.
- `governance-docs/governance-file-gitignored` (critical) — governance file listed in .gitignore.
- `governance-docs/governance-file-untracked` (warning) — governance file not tracked in git.
- `governance-docs/no-ai-tooling-detected` (info) — no AI-tooling surface found, so governance depth is not scored.

### claude-settings

- `claude-settings/mcp-auto-approve-enabled` (critical) — `enableAllProjectMcpServers: true`.
- `claude-settings/anthropic-base-url-redirected` (critical) — CVE-2026-21852-class API base-URL override.
- `claude-settings/bypass-plus-skip-prompt` (critical) — `bypassPermissions` + `skipDangerousModePermissionPrompt`.
- `claude-settings/dangerous-hook-command` (critical) — hook runs curl/wget/nc/eval/rm -rf/etc.
- `claude-settings/hook-script-missing` (warning) — hook references a path that does not exist.
- `claude-settings/wildcard-tool-permission` (warning) — `allowedTools` includes `"*"`.
- `claude-settings/dangerous-allow-list-entry` (warning) — allow-list pattern grants sudo-bash / unrestricted docker / raw pip.
- `claude-settings/lifecycle-hook-missing` (info) — one of PreToolUse/PostToolUse/Stop/UserPromptSubmit is not configured.
- `claude-settings/no-lifecycle-hooks` (info) — no Claude Code hooks configured at all.
- `claude-settings/http-hook-external-endpoint` (critical) — a hook sends data to an external HTTP(S) endpoint.
- `claude-settings/bypass-permissions-mode` (warning) — permission mode is `bypassPermissions`.
- `claude-settings/settings-unparseable` (warning) — a settings file is not valid JSON, so it was not analyzed.
- `claude-settings/frontmatter-hooks-unparseable` (warning) — an agent/skill frontmatter `hooks:` block could not be parsed.
- `claude-settings/hook-file-cap-reached` (warning) — the hook-file scan hit its cap, so hook coverage is incomplete.
- `claude-settings/no-settings-found` (info) — no Claude settings file found in any location.

### coherence

- `coherence/network-claim-vs-mcp-transport` (warning)
- `coherence/path-claim-vs-broad-filesystem` (warning)
- `coherence/forbidden-claim-vs-privileged-docker` (warning)
- `coherence/multi-client-drift-no-governance` (warning)
- `coherence/shell-claim-vs-skill-shell-exec` (warning)
- `coherence/anti-injection-claim-vs-skill-injection` (critical)
- `coherence/exfiltration-plus-broad-filesystem` (critical)
- `coherence/governance-gitignored-echo` (info) — echoed from governance-docs.
- `coherence/governance-untracked-echo` (info) — echoed from governance-docs.
- `coherence/undeclared-mcp-server` (warning) — MCP server not mentioned in governance.
- `coherence/no-approved-tools-declaration` (info) — broad-capability MCP server without an "Approved Tools" declaration.
- `coherence/approval-claim-vs-bypass-no-hook` (warning) — bypassPermissions + approval-gate claim + no PreToolUse hook.
- `coherence/allow-list-contradicts-governance` (warning) — default ID for author-configured governance pairings.

### credential-storage

- `credential-storage/plaintext-credential-in-client-config` (critical)
- `credential-storage/example-credential-in-client-config` (info)
- `credential-storage/no-client-configs-found` (info) — no AI-client config files to scan.

### deep-secrets

- `deep-secrets/gcp-service-account-key` (critical)
- `deep-secrets/hardcoded-secret` (critical)
- `deep-secrets/possible-secret-comment` (warning)
- `deep-secrets/symlink-loop-skipped` (info)
- `deep-secrets/no-source-files` (info)
- `deep-secrets/file-cap-reached` (info)
- `deep-secrets/oversize-skipped` (info) — id retained for contract stability; large files are now stream-scanned in bounded memory, not skipped.
- `deep-secrets/unreadable-skipped` (warning) — a file/dir could not be read (e.g. chmod 000) and was not scanned; disclosed so an unreadable path never reads as a clean scan.

### docker-security (compose)

- `docker-security/container-running-with-privileged-true` (critical)
- `docker-security/container-uses-host-network-mode` (warning)
- `docker-security/container-uses-ipc-host` (critical)
- `docker-security/container-uses-pid-host` (critical)
- `docker-security/container-uses-volumes-from` (warning)
- `docker-security/container-adds-dangerous-capability` (critical)
- `docker-security/container-mounts-docker-socket` (critical)
- `docker-security/container-volume-mount-uses-path-traversal` (warning)
- `docker-security/container-mounts-sensitive-path` (critical)
- `docker-security/container-missing-cap-drop-all` (warning)
- `docker-security/container-missing-no-new-privileges` (info)
- `docker-security/container-has-no-user-directive` (warning)
- `docker-security/container-has-no-memory-limit` (info)
- `docker-security/failed-to-parse` (warning)
- `docker-security/failed-to-parse-included-file` (info)
- `docker-security/no-container-configuration-found` (info)

### docker-security (Kubernetes)

- `docker-security/k8s-hostnetwork-enabled` (warning)
- `docker-security/k8s-hostpid-enabled` (warning)
- `docker-security/k8s-hostipc-enabled` (warning)
- `docker-security/k8s-no-pod-level-runasnonroot` (info)
- `docker-security/k8s-privileged-container` (critical)
- `docker-security/k8s-capabilities-not-dropped` (info)
- `docker-security/k8s-allowprivilegeescalation-is-true` (warning)
- `docker-security/k8s-no-resource-limits` (info)
- `docker-security/k8s-hostpath-mounts` (critical)

### docker-security (Dockerfile / devcontainer)

- `docker-security/has-no-user-directive` (warning)
- `docker-security/unpinned-base-image` (warning)
- `docker-security/add-with-remote-url` (warning)
- `docker-security/copies-sensitive-file` (warning)
- `docker-security/multi-stage-build-runs-as-root-in-final-stage` (warning)
- `docker-security/pipe-to-shell-in-run-instruction` (warning)
- `docker-security/secret-in-run-instruction` (critical)
- `docker-security/chmod-777-in-run-instruction` (warning)
- `docker-security/apt-get-install-without-no-install-recommends` (info)
- `docker-security/apk-add-without-no-cache` (info)
- `docker-security/exposes-ssh-port-22` (warning)
- `docker-security/devcontainer-uses-privileged-mode` (critical)
- `docker-security/devcontainer-adds-capabilities` (warning)
- `docker-security/devcontainer-mounts-docker-socket` (critical)

### documentation

- `documentation/docs-gate-<reason>` (warning) — reason ∈ `missing`, `incomplete`, `weight-drift`, `h1-mismatch`.
- `documentation/orphan-doc` (info)

### env-exposure

- `env-exposure/env-not-gitignored` (warning)
- `env-exposure/env-world-readable` (warning)
- `env-exposure/hardcoded-api-key` (critical) — a live API key literal in a tracked config file.
- `env-exposure/gcp-service-account-key` (critical) — a GCP service-account private key on disk.
- `env-exposure/real-secret-in-template` (warning) — an `.env.example`/template ships a real secret, not a placeholder.
- `env-exposure/shell-history-secrets` (warning) — secrets recorded in shell history.
- `env-exposure/api-key-in-comment` (info) — an API-key pattern inside a comment.
- `env-exposure/api-key-example-placeholder` (info) — an API-key pattern that reads as an example/placeholder.

### git-hooks

- `git-hooks/not-a-git-repo` (info)
- `git-hooks/hook-empty` (warning)
- `git-hooks/hook-not-executable` (info)
- `git-hooks/hook-noop` (warning)
- `git-hooks/hook-lacks-substance` (info)
- `git-hooks/no-hooks-installed` (warning)
- `git-hooks/no-secret-scanning` (warning)

### infrastructure-security

- `infrastructure-security/hooks-dir-missing` (critical)
- `infrastructure-security/hooks-dir-not-root-owned` (critical)
- `infrastructure-security/required-hook-missing` (critical)
- `infrastructure-security/hook-not-executable` (warning)
- `infrastructure-security/git-wrapper-missing` (critical)
- `infrastructure-security/git-wrapper-not-root-owned` (warning)
- `infrastructure-security/git-wrapper-no-verify-bypass` (warning)
- `infrastructure-security/safety-gates-missing` (info)
- `infrastructure-security/cannot-check-immutability` (info)
- `infrastructure-security/immutable-flag-not-set` (warning)
- `infrastructure-security/no-deny-list` (warning)
- `infrastructure-security/deny-list-missing-patterns` (warning)
- `infrastructure-security/sandbox-gate-not-registered` (warning)

### instruction-effectiveness

- `instruction-effectiveness/dead-file-reference` (info)
- `instruction-effectiveness/single-file-over-budget` (warning) — one instruction file alone blows the per-turn budget.
- `instruction-effectiveness/context-budget-warn` (warning) — the auto-loaded instruction bundle is over budget.
- `instruction-effectiveness/context-budget-info` (info) — the bundle is approaching its budget.
- `instruction-effectiveness/file-bloat` (warning) — an instruction file is far larger than the rest.
- `instruction-effectiveness/file-bloat-info` (info) — advisory-tier bloat on the same condition.
- `instruction-effectiveness/contradiction` (info) — two instructions conflict.
- `instruction-effectiveness/vague-instruction` (info) — an instruction is unactionable ("use your judgment").
- `instruction-effectiveness/vague-instruction-summary` (info) — roll-up when many vague instructions are found.
- `instruction-effectiveness/redundant-instruction` (info) — an instruction is restated elsewhere.
- `instruction-effectiveness/redundant-instruction-summary` (info) — roll-up for the redundant set.

### mcp-config

- `mcp-config/no-config-found` (info)
- `mcp-config/env-wildcard-passthrough` (warning)
- `mcp-config/localhost-server` (info)
- `mcp-config/network-transport` (warning)
- `mcp-config/broad-filesystem-access` (critical)
- `mcp-config/relative-path-traversal` (warning)
- `mcp-config/unsafe-permission-flag` (warning)
- `mcp-config/env-wildcard-sensitive-vars` (critical)
- `mcp-config/env-sensitive-vars` (warning)
- `mcp-config/anthropic-base-url-redirect` (critical)
- `mcp-config/unpinned-unstable-tag` (warning)
- `mcp-config/unpinned-npx-package` (warning)
- `mcp-config/inline-credentials` (critical)
- `mcp-config/typosquat-curated` (warning)
- `mcp-config/typosquat-registry` (critical)
- `mcp-config/npm-package-not-found` (critical)
- `mcp-config/npm-package-very-new` (warning)
- `mcp-config/registry-fallback` (info)
- `mcp-config/mcp-auto-approve-enabled` (critical) — mirrors claude-settings ID for the same condition surfaced via mcp-config scan.
- `mcp-config/dangerous-hook-command` (critical)
- `mcp-config/cve-2025-59536-auto-approve-on-clone` (critical)
- `mcp-config/cross-client-drift` (warning)
- `mcp-config/single-client-server` (info)
- `mcp-config/state-file-corrupted` (info)
- `mcp-config/server-hash-drift` (warning)
- `mcp-config/runtime-tool-pin-recorded` (info)
- `mcp-config/runtime-tool-pin-missing` (info)
- `mcp-config/state-write-disabled` (warning/info) — `--no-state-write` suppressed config-shape pinning: a pin write was due, so rug-pull drift detection is lost (warning), or the pin was already current so nothing was lost (info).
- `mcp-config/config-unparseable` (warning) — an MCP config file exists but does not parse as JSON, so the servers it declares are scanned by nothing and (for a committed repo-level config) pinned by nothing. Mirrors `claude-settings/settings-unparseable`.

### network-exposure

- `network-exposure/mcp-url-malformed` (info)
- `network-exposure/mcp-non-loopback-host` (critical)
- `network-exposure/docker-port-no-loopback-bind` (warning)
- `network-exposure/ollama-systemd-all-interfaces` (warning)
- `network-exposure/ollama-config-all-interfaces` (warning)
- `network-exposure/live-listener-non-loopback` (warning)
- `network-exposure/no-exposure-detected` (info) — nothing listens off-loopback.

### permissions-hygiene

- `permissions-hygiene/ssh-dir-permissions` (warning)
- `permissions-hygiene/ssh-key-permissions` (warning)
- `permissions-hygiene/sensitive-file-world-readable` (warning)
- `permissions-hygiene/governance-mixed-ownership` (warning) — governance files are owned by more than one uid.

### site-security

- `site-security/cannot-reach` (warning)
- `site-security/missing-security-header` (critical)
- `site-security/missing-advisory-header` (warning)
- `site-security/x-powered-by-disclosed` (warning)
- `site-security/server-header-version` (warning)
- `site-security/exposed-path-accessible` (critical)
- `site-security/pii-email-leak` (critical)
- `site-security/pii-phone-leak` (warning)
- `site-security/secret-in-page-source` (critical)
- `site-security/internal-ip-disclosed` (warning)
- `site-security/generator-tag-disclosed` (warning)
- `site-security/ssl-check-failed` (warning)
- `site-security/ssl-certificate-expired` (critical)
- `site-security/ssl-certificate-expiring-soon` (warning)
- `site-security/invalid-url` (info) — a configured site URL does not parse.
- `site-security/unsupported-scheme` (info) — a configured site URL is not http(s).
- `site-security/no-sites-configured` (info) — no `sites` array in `.rigscorerc.json`, so the check is not applicable.

### skill-coherence

- `skill-coherence/settings-allow-deny-conflict` (info)
- `skill-coherence/hook-settings-allow-conflict` (warning) — default ID for config-driven hook/settings pairings.
- `skill-coherence/constraint-unaware-<constraint-id>` (varies) — derived from user-configured constraint `id`.

### skill-files

- `skill-files/injection` (critical)
- `skill-files/injection-defensive` (info)
- `skill-files/shell-exec` (warning)
- `skill-files/exfiltration` (warning)
- `skill-files/escalation-<patternId>` (warning) — patternId ∈ `sudo`, `run-as-root`, `run-as-admin`, `elevated-privilege`, `chmod-777`, `chmod-plus-x`, `chmod-a-plus`, `disable-security`, `disable-firewall`, `disable-antivirus`, `escalation` (fallback).
- `skill-files/persistence` (warning)
- `skill-files/indirect-injection` (critical)
- `skill-files/trust-exploitation` (warning)
- `skill-files/world-writable` (warning)
- `skill-files/bidi-override` (critical) — a bidirectional-override character hides text in a skill file.
- `skill-files/zero-width` (warning) — zero-width characters in a skill file.
- `skill-files/homoglyph` (warning) — look-alike Unicode characters in a skill file.
- `skill-files/non-tls-urls` (warning) — plain-HTTP URLs in a skill file.
- `skill-files/possible-base64` (warning) — base64-looking encoded content in a skill file.
- `skill-files/https-urls` (info) — HTTPS URLs in a skill file (inventory only).
- `skill-files/symlink-loop-skipped` (info) — a symlink cycle was skipped during traversal.
- `skill-files/no-skill-files` (info) — no skill/instruction files to scan.
- `skill-files/walk-cap-reached` (warning) — the skill-directory walk hit the depth (or file) cap, so skill files past it were never read and the result is not a clean bill of health for injection/exfiltration.
- `skill-files/non-text-file` (warning) — a binary / non-text file (NUL or Unicode replacement char) in a skill directory; not regex-scanned, so it is a blind spot.
- `skill-files/tag-chars` (critical) — Unicode tag characters (U+E0001, U+E0020-U+E007F) in a skill file, an invisible steganographic channel.
- `skill-files/file-too-large` (warning) — a skill file over the per-file size cap (`limits.maxFileBytes`) was not read/scanned.

### unicode-steganography

- `unicode-steganography/bidi-override` (critical)
- `unicode-steganography/zero-width` (warning)
- `unicode-steganography/homoglyph` (warning)
- `unicode-steganography/tag-chars` (warning)
- `unicode-steganography/no-files-scanned` (info) — no governance or config files to scan.

### windows-security

- `windows-security/wsl-interop-exposes-path` (warning)
- `windows-security/wsl-interop-enabled` (info)
- `windows-security/wsl-mirrored-networking` (info)
- `windows-security/wsl-firewall-not-enabled` (info)
- `windows-security/defender-excludes-project-paths` (warning)
- `windows-security/ntfs-permissions-advisory` (info)

### workflow-maturity

- `workflow-maturity/skill-no-eval` (info)
- `workflow-maturity/skill-compound-responsibility` (info)
- `workflow-maturity/graduated-script-missing` (warning)
- `workflow-maturity/mcp-single-consumer` (warning)
- `workflow-maturity/memory-orphan` (warning)
- `workflow-maturity/pipeline-step-overload` (info)
- `workflow-maturity/stage-dir-overload` (info)

### agent-output-schemas

- `agent-output-schemas/missing-schema-block` (warning)
- `agent-output-schemas/malformed-schema-block` (warning)

### ai-disclosure

- `ai-disclosure/no-ai-policy` (warning) — AI surface present but no AI-use policy (nothing in CONTRIBUTING.md, no AI_POLICY.md, nothing in the governance file).
- `ai-disclosure/pr-template-no-ai-field` (warning) — a PR template exists but mentions AI nowhere, so an AI-assisted change ships undeclared.
- `ai-disclosure/no-pr-template` (info) — a repo that runs AI agents has no pull-request template in any location GitHub reads.
- `ai-disclosure/disclosure-not-enforced` (info) — a disclosure is requested but nothing committed would fail a PR that ignores it.

### ci-agent-caps

- `ci-agent-caps/agent-permission-bypass` (critical) — a workflow removes the agent's permission ceiling (e.g. `--dangerously-skip-permissions`).
- `ci-agent-caps/agent-job-missing-timeout` (warning) — a CI job runs an AI agent with no `timeout-minutes` (GitHub's default is 360).
- `ci-agent-caps/agent-job-missing-turn-cap` (warning) — a CI agent invocation declares no per-run turn cap (`max_turns` / `--max-turns`).
- `ci-agent-caps/agent-job-missing-tool-scoping` (warning) — a CI agent invocation declares no allowed/disallowed tool scoping.
- `ci-agent-caps/failed-to-parse-workflow` (info) — a workflow's YAML could not be parsed, so it was not analyzed for agent jobs.
- `ci-agent-caps/reusable-workflow-not-analyzed` (info) — a job delegates to a workflow rigscore cannot read (another repo, or a path not in the checkout).

### loop-governance

- `loop-governance/skip-permissions` (warning) — a script runs an agent with `--dangerously-skip-permissions`.
- `loop-governance/uncapped-loop` (warning) — an agent loop has no bound (no counter, `--max-turns`, or `timeout`).
- `loop-governance/no-stop-condition` (warning) — an agent loop has no terminal state (no break/exit/sentinel check).
- `loop-governance/uncapped-cron` (warning) — a cron job runs an agent with nothing bounding one tick.
- `loop-governance/uncapped-timer` (warning) — a systemd `.timer` runs an agent with nothing bounding one tick.
- `loop-governance/file-cap-reached` (warning) — the agent-loop scan hit the file cap, so the repo cannot be certified loop-free.

### memory-hygiene

- `memory-hygiene/bundle-over-budget` (warning) — the auto-loaded memory bundle exceeds its per-turn byte budget.
- `memory-hygiene/stale-memory-file` (warning/info) — an empty (warning) or stub (info) memory file is loaded every session but teaches nothing.
- `memory-hygiene/unresolvable-index-entry` (warning/info) — a `MEMORY.md` index entry points at a missing file (warning) or one outside every memory dir (info).
- `memory-hygiene/dangling-wikilink` (warning) — a `[[wikilink]]` names a memory with no matching file (warn-only, only once the set uses wikilinks).
- `memory-hygiene/orphan-memory` (warning) — a memory file has no inbound `[[wikilink]]` from any other memory (wikilink-graph orphan; warn-only).
- `memory-hygiene/duplicate-rule` (info) — a rule stated in both a governance file and a memory file has two homes.
- `memory-hygiene/governance-file-cap-reached` (info) — the nested-governance walk hit its file cap or its depth cap (`limits.maxWalkDepth`), so duplicate-rule coverage is incomplete.

### sandbox-posture

- `sandbox-posture/codex-no-sandbox` (critical) — a Codex client has the sandbox disabled (`sandbox_mode = "danger-full-access"`).
- `sandbox-posture/codex-auto-approve-networked` (critical) — a Codex client auto-approves with network access.
- `sandbox-posture/codex-auto-approve` (warning) — a Codex client never prompts for approval.
- `sandbox-posture/claude-no-deny-rules` (warning) — a Claude client declares no `permissions.deny` rules.
- `sandbox-posture/gemini-yolo-approval` (warning) — a Gemini CLI client sets `general.defaultApprovalMode = "yolo"` (auto-approves every tool call).
- `sandbox-posture/gemini-auto-edit` (warning) — a Gemini CLI client sets `general.defaultApprovalMode = "auto_edit"` (auto-approves file edits).
- `sandbox-posture/opencode-auto-run-shell` (warning) — an opencode client sets `permission.bash` (or `*`) to `"allow"` (shell runs unprompted).
- `sandbox-posture/cursor-wildcard-autorun` (warning) — a Cursor client's `.cursor/permissions.json` allowlist contains a `"*"` / `"*:*"` wildcard.
- `sandbox-posture/devcontainer-no-egress-control` (warning) — a devcontainer runs an agent with no egress control.
- `sandbox-posture/devcontainer-file-cap-reached` (warning) — the devcontainer scan hit its file cap.

### spec-goals

- `spec-goals/constitution-missing` (warning) — `.specify/` is present but there is no constitution file.
- `spec-goals/constitution-placeholder` (warning) — the constitution is still an unfilled template.
- `spec-goals/spec-dir-no-tasks` (info) — a spec dir holds a spec but no tasks file (never decomposed into executable work).
- `spec-goals/spec-dir-no-design` (info) — a spec dir holds requirements but no design file.
- `spec-goals/requirements-not-ears` (info) — requirements are not written in EARS syntax.
- `spec-goals/goal-file-stale` (info) — a goal file lags the newest spec by many days.
- `spec-goals/spec-abandoned` (info) — a spec was left unfinished, far behind the newest spec.
- `spec-goals/spec-tree-dormant` (info) — the whole spec tree has sat still while the repo kept committing.
- `spec-goals/change-unarchived` (info) — a change is fully ticked off but was never archived.
- `spec-goals/domain-spec-incomplete` (info) — a domain spec is missing required parts.
- `spec-goals/agents-md-hollow` (info) — AGENTS.md names no runnable command.

### semantic-tools

- `semantic-tools/suspicious-tool-description` (warning) — the opt-in `--semantic` first-party `claude -p` judge classified an MCP tool description as possible tool-poisoning (obfuscated instruction-injection / data-exfiltration phrasing). Advisory, weight 0.

### staged-copy-drift

- `staged-copy-drift/content-drift` (warning) — a tracked copy and its deployed twin under the operator's home config dir have different sha256 contents. Only emitted under `--include-home-skills`. Advisory, weight 0.

### Stable check-level IDs

Every check id in `src/checks/` is stable. These work in `--ignore` and
`suppress:` as a coarse-grained mute:

`agent-output-schemas`, `ai-disclosure`, `ci-agent-caps`, `governance-docs`,
`claude-settings`, `coherence`, `credential-storage`, `deep-secrets`,
`docker-security`, `documentation`, `env-exposure`, `git-hooks`,
`infrastructure-security`, `instruction-effectiveness`, `loop-governance`,
`mcp-config`, `memory-hygiene`, `network-exposure`, `permissions-hygiene`,
`sandbox-posture`, `semantic-tools`, `site-security`, `skill-coherence`,
`skill-files`, `spec-goals`, `staged-copy-drift`, `unicode-steganography`,
`windows-security`,
`workflow-maturity`.

## How to discover IDs you're seeing right now

```bash
npx github:Back-Road-Creative/rigscore --json | jq '.results[].findings[] | {checkId, findingId, severity, title}'

# Or SARIF:
npx github:Back-Road-Creative/rigscore --sarif | jq '.runs[0].results[] | {ruleId, level, message}'
```

## See also

- `src/sarif.js` — `deriveFindingRuleId` — remaining fallback for plugin
  checks that don't emit explicit IDs.
- `src/fixer.js` — fixers prefer `findingIds: string[]` equality over title
  substring for the same reason.
- `src/checks/index.js` — at load time, a fixer registers when it has an `id`
  and an `apply` function plus EITHER a `match` predicate OR a non-empty
  `findingIds` array. Fixers declaring only `findingIds` (no `match`) are
  fully supported by the dispatcher and no longer dropped at registration.
- [`docs/TROUBLESHOOTING.md`](TROUBLESHOOTING.md) — operational FAQ.

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

## Full enforcement (v2.x)

As of v2.x the stability contract applies to **every** non-pass,
non-skipped finding emitted by the built-in checks. The SARIF title-slug
fallback in `src/sarif.js::deriveFindingRuleId` is retained only as a
defensive safety net for plugin-authored checks that skip explicit IDs —
no built-in check should rely on it.

Suppressing a finding via `--ignore <id>`, `suppress:` in
`.rigscorerc.json`, or a baseline file is safe for any ID listed below.

For IDs whose slug includes a dynamic fragment (e.g.
`claude-md/actively-negates-<category>`,
`claude-md/missing-<category>`,
`skill-files/escalation-<patternId>`,
`documentation/docs-gate-<reason>`,
`skill-coherence/constraint-unaware-<constraint-id>`) the dynamic
fragment is also stable — it is derived from a closed enumeration
(QUALITY_CHECKS names, ESCALATION pattern ids, docs-gate reasons, and
user-provided constraint ids respectively).

## Explicitly emitted finding IDs

Grouped by check. Each ID is stable within the current major.

### claude-md

- `claude-md/no-governance-file` (critical) — no CLAUDE.md or equivalent found.
- `claude-md/governance-file-short` (warning) — governance file < 50 lines.
- `claude-md/actively-negates-<category>` (critical) — negated governance keyword (category slugified from QUALITY_CHECKS name).
- `claude-md/missing-<category>` (warning) — missing governance category.
- `claude-md/governance-reversal-detected` (warning) — keyword-stuffed header dismantled in body (C7).
- `claude-md/injection-pattern` (critical) — instruction-override pattern found in governance file.
- `claude-md/governance-file-gitignored` (critical) — governance file listed in .gitignore.
- `claude-md/governance-file-untracked` (warning) — governance file not tracked in git.

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

### coherence

- `coherence/network-claim-vs-mcp-transport` (warning)
- `coherence/path-claim-vs-broad-filesystem` (warning)
- `coherence/forbidden-claim-vs-privileged-docker` (warning)
- `coherence/multi-client-drift-no-governance` (warning)
- `coherence/shell-claim-vs-skill-shell-exec` (warning)
- `coherence/anti-injection-claim-vs-skill-injection` (critical)
- `coherence/exfiltration-plus-broad-filesystem` (critical)
- `coherence/governance-gitignored-echo` (info) — echoed from claude-md.
- `coherence/governance-untracked-echo` (info) — echoed from claude-md.
- `coherence/undeclared-mcp-server` (warning) — MCP server not mentioned in governance.
- `coherence/no-approved-tools-declaration` (info) — broad-capability MCP server without an "Approved Tools" declaration.
- `coherence/approval-claim-vs-bypass-no-hook` (warning) — bypassPermissions + approval-gate claim + no PreToolUse hook.
- `coherence/allow-list-contradicts-governance` (warning) — default ID for author-configured governance pairings.

### credential-storage

- `credential-storage/plaintext-credential-in-client-config` (critical)
- `credential-storage/example-credential-in-client-config` (info)

### deep-secrets

- `deep-secrets/gcp-service-account-key` (critical)
- `deep-secrets/hardcoded-secret` (critical)
- `deep-secrets/possible-secret-comment` (warning)
- `deep-secrets/symlink-loop-skipped` (info)
- `deep-secrets/no-source-files` (info)
- `deep-secrets/file-cap-reached` (info)
- `deep-secrets/oversize-skipped` (info)

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

### network-exposure

- `network-exposure/mcp-url-malformed` (info)
- `network-exposure/mcp-non-loopback-host` (critical)
- `network-exposure/docker-port-no-loopback-bind` (warning)
- `network-exposure/ollama-systemd-all-interfaces` (warning)
- `network-exposure/ollama-config-all-interfaces` (warning)
- `network-exposure/live-listener-non-loopback` (warning)

### permissions-hygiene

- `permissions-hygiene/ssh-dir-permissions` (warning)
- `permissions-hygiene/ssh-key-permissions` (warning)
- `permissions-hygiene/sensitive-file-world-readable` (warning)

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

### unicode-steganography

- `unicode-steganography/bidi-override` (critical)
- `unicode-steganography/zero-width` (warning)
- `unicode-steganography/homoglyph` (warning)
- `unicode-steganography/tag-chars` (warning)

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
- `workflow-maturity/mcp-single-consumer` (warning)
- `workflow-maturity/memory-orphan` (warning)
- `workflow-maturity/pipeline-step-overload` (info)
- `workflow-maturity/stage-dir-overload` (info)

### Stable check-level IDs

Every check id in `src/checks/` is stable. These work in `--ignore` and
`suppress:` as a coarse-grained mute:

`claude-md`, `claude-settings`, `coherence`, `credential-storage`,
`deep-secrets`, `docker-security`, `documentation`, `env-exposure`,
`git-hooks`, `infrastructure-security`, `instruction-effectiveness`,
`mcp-config`, `network-exposure`, `permissions-hygiene`, `site-security`,
`skill-coherence`, `skill-files`, `unicode-steganography`,
`windows-security`, `workflow-maturity`.

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
- [`docs/TROUBLESHOOTING.md`](TROUBLESHOOTING.md) — operational FAQ.

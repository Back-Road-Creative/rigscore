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

## Current state — partial enforcement (v1.x)

**This is a known gap.** The stability contract above is the intended
behavior. Today, only a subset of checks emit explicit stable IDs; for the
rest, SARIF derives a ruleId by slugifying the finding title (see
`src/sarif.js` → `deriveFindingRuleId`). Title-derived IDs are **not**
guaranteed to survive a title reword.

If you are writing a long-lived `--ignore` list, a `suppress:` stanza in
`.rigscorerc.json`, or a finding-ID-based fixer: prefer the explicitly
emitted IDs listed below. Everything else, treat as a best-effort handle
until a future release promotes it.

This gap is tracked for enforcement under the regression net (Track E) —
the goal is that every check emits an explicit `findingId` on every
non-pass finding, and the SARIF title-slug fallback becomes dead code.

## Explicitly emitted finding IDs (v1.x)

These IDs are written directly in the check source and are safe to pin.

| ID | Check | Default severity | What it means |
|---|---|---|---|
| `skill-files/injection` | skill-files | critical | Instruction-override / injection pattern in a skill file. |
| `skill-files/injection-defensive` | skill-files | info | Injection pattern detected but context is defensive (e.g. an anti-injection rule). |
| `skill-files/shell-exec` | skill-files | warning | Shell-execution instructions embedded in a skill file. |
| `skill-files/exfiltration` | skill-files | warning | Data-exfiltration pattern in a skill file. |
| `skill-files/escalation-<patternId>` | skill-files | warning | Privilege-escalation pattern. `<patternId>` is derived from the matching pattern (e.g. `sudo`, `chmod-777`). |
| `skill-files/persistence` | skill-files | warning | Persistence pattern (cron/autorun/login-hook style) in a skill file. |
| `skill-files/indirect-injection` | skill-files | critical | Fetch-and-execute remote-code instructions. |
| `skill-files/trust-exploitation` | skill-files | warning | Instructions to skip tool-output verification (CVE-2025-54136 class). |
| `skill-files/world-writable` | skill-files | warning | A skill file is world-writable on disk. |
| `env-exposure/env-not-gitignored` | env-exposure | warning | A `.env` file exists and is not gitignored. |
| `env-exposure/env-world-readable` | env-exposure | warning | An `.env` file has world-readable permissions. |
| `permissions-hygiene/ssh-dir-permissions` | permissions-hygiene | warning | `~/.ssh` is not mode `700`. |
| `permissions-hygiene/ssh-key-permissions` | permissions-hygiene | warning | An SSH private key is not mode `600`. |
| `permissions-hygiene/sensitive-file-world-readable` | permissions-hygiene | warning | A sensitive project file (`.pem`, `.key`, `*credentials*`) is world-readable. |
| `instruction-effectiveness/dead-file-reference` | instruction-effectiveness | info | Instruction file references a path that does not exist on disk. |

### Stable check-level IDs

Every check id in `src/checks/` is stable. These work in `--ignore` and
`suppress:` as a coarse-grained mute:

`claude-md`, `claude-settings`, `coherence`, `credential-storage`,
`deep-secrets`, `docker-security`, `documentation`, `env-exposure`,
`git-hooks`, `infrastructure-security`, `instruction-effectiveness`,
`mcp-config`, `network-exposure`, `permissions-hygiene`, `site-security`,
`skill-coherence`, `skill-files`, `unicode-steganography`,
`windows-security`, `workflow-maturity`.

## Everything else — title-derived (not stable)

Findings from the remaining checks currently reach SARIF as
`<check-id>/<title-slug>` via `deriveFindingRuleId`. Pinning these in
long-lived config is risky: a minor title reword changes the slug. If you
need a stable suppression today for a title-derived finding, suppress at
the check level (e.g. `--ignore docker-security`) and narrow later when
the explicit ID lands.

## How to discover IDs you're seeing right now

```bash
npx github:Back-Road-Creative/rigscore --json | jq '.results[].findings[] | {checkId, findingId, severity, title}'

# Or SARIF:
npx github:Back-Road-Creative/rigscore --sarif | jq '.runs[0].results[] | {ruleId, level, message}'
```

The `findingId` on a finding without an explicit one will be `undefined`
in JSON; SARIF fills in the derived ruleId either way.

## See also

- `src/sarif.js` — `deriveFindingRuleId` is the fallback source of truth.
- `src/fixer.js` — fixers prefer `findingIds: string[]` equality over title
  substring for the same reason.
- [`docs/TROUBLESHOOTING.md`](TROUBLESHOOTING.md) — operational FAQ.

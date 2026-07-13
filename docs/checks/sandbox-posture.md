# sandbox-posture

## Purpose

Every agent CLI expresses "how much can this agent do without asking me" differently, and they only
converge at OS primitives — no cross-vendor permission/sandbox manifest exists. This check is the first
step toward that normalizer: it reduces an agent's sandbox config to **a single posture** (`restricted` /
`partial` / `unrestricted`) in `data.postures`, and flags the dangerous combinations. Maps to **ASI02 —
Tool Misuse & Exploitation**; passing means the client is not both free of approval prompts and able to
reach the network.

**The client registry (`src/clients.js`) is the surface list** — the check owns no client table. It scans
every client declaring a `sandbox` entry (`{ path, base: 'cwd'|'home', format }`), reading each client's
files in declaration order (`$HOME` first, then the project file, which wins). `format` selects the reader,
so a **new client is picked up with no change to this check's logic**. Two formats exist:

- `toml` — **Codex CLI**, `.codex/config.toml`: `approval_policy`, `sandbox_mode`,
  `[sandbox_workspace_write] network_access`, per the
  [Codex config reference](https://developers.openai.com/codex/config-reference).
- `json` — **Claude Code**, `.claude/settings.json` + `.claude/settings.local.json`: the **posture**
  question only — are there *any* `permissions.deny` rules? — plus the approval mode. Which *allow* entries
  are dangerous is `claude-settings`' job; this check never re-grades them. The approval mode is read at
  **`permissions.defaultMode` first**, falling back to a top-level `defaultMode` for legacy configs — the
  nested key is where Claude Code actually writes it, and reading only the top level let a real
  `bypassPermissions` config score as though nothing bypassed the prompt.

One surface is **not** registry-driven: the project's `.devcontainer/` (or single-file
`.devcontainer.json`). It belongs to no client — it is the box every client runs *inside* — so it is
scanned separately, and only when it installs an agent CLI (a devcontainer that runs no agent is not
this check's business, and reads as no surface at all rather than as a passing one).

## Triggers

| Condition | Severity | SARIF ruleId | Remediation summary |
|---|---|---|---|
| `sandbox_mode = "danger-full-access"` (detail also names `approval_policy = "never"` when both are set — the lethal trifecta) | CRITICAL | `sandbox-posture/codex-no-sandbox` | Set `sandbox_mode = "workspace-write"` / `"read-only"` |
| `approval_policy = "never"` **and** network reachable (`workspace-write` + `network_access = true`) | CRITICAL | `sandbox-posture/codex-auto-approve-networked` | `network_access = false`, or raise `approval_policy` |
| `approval_policy = "never"` with write capability, no network | WARNING | `sandbox-posture/codex-auto-approve` | Set `approval_policy = "on-request"` |
| A Claude Code settings file **exists** but declares **zero** `permissions.deny` entries (detail also names `defaultMode = "bypassPermissions"` when set — nothing denied *and* nothing prompted) | WARNING | `sandbox-posture/claude-no-deny-rules` | Add `permissions.deny` entries (e.g. `"Bash(curl:*)"`, `"Read(./.env)"`) to `.claude/settings.json` |
| A `.devcontainer/` (or `.devcontainer.json`) **installs an agent CLI** and contains **no** firewall, proxy, default-deny network rule or capability drop — no attempt at egress control is visible anywhere in it | WARNING | `sandbox-posture/devcontainer-no-egress-control` | Internal-only network + deny-by-default proxy, `--cap-drop=ALL`, `--security-opt=no-new-privileges` (`templates/container` is a worked example) |
| Surface present, nothing above matches → PASS. No sandbox surface anywhere → N/A (`-1`), never 0 | PASS / N/A | — | — |

The first four ruleIds are **not literals in the source**: each is the `id` of an entry in the ordered rule tables (`CODEX_RULES`, `DENY_RULES`), interpolated at emit time as `` sandbox-posture/${rule.id} ``. Add a rule-table entry and its id becomes a ruleId with no other change — so a ruleId extractor must read the rule tables, not just scan for quoted `findingId:` values. Only `sandbox-posture/devcontainer-no-egress-control` is written literally.

A **missing** settings file is not a posture finding — absence is `claude-settings`' report, not this one.
Deny rules are counted as the **union** across a client's files: one file with rules covers the pair.

Posture levels (`data.postures`, keyed by client id):

| Level | Rule |
|---|---|
| `restricted` | `sandbox_mode = "read-only"` — the sandbox binds whatever the approval setting says |
| `unrestricted` | `danger-full-access`; `approval_policy = "never"` while writes are still possible; or zero deny rules **and** `bypassPermissions` (nothing refused, nothing asked) |
| `partial` | Everything else — e.g. `workspace-write` with approvals left on, or a deny list that binds *something* |

Claude Code never reaches `restricted`: it ships no sandbox to read, so the deny list plus the approval
mode are its whole boundary — an honest ceiling of `partial`, not a claim of containment.

**The devcontainer surface gets no posture row at all** — deliberately. A posture is a claim about what
the agent can reach, and the devcontainer arm's evidence cannot support one in either direction (below).
It appears in `data.devcontainer` as raw evidence (`{ where, controls }`) and never in `data.postures`.

## Weight rationale

**Advisory — weight 0.** Ships on the Security axis so it can be read and argued with before it costs
anyone points; its real weight lands on the Practice axis in a follow-up. Weight-0 checks are excluded
from the coverage denominator in `src/scoring.js`, so this check moves no existing score.

## Fix semantics

No auto-fix. Every finding is a capability decision — how much autonomy this agent gets on this machine —
not a typo; rewriting an `approval_policy`, a `sandbox_mode` or a deny list is a governance edit a scanner
must propose, never perform (an invented deny rule is worse than none — it reads as containment). Out of
scope: editing `.codex/config.toml` or `.claude/settings*.json`.

## SARIF

Tool component `rigscore`; rule IDs are the per-finding ids listed in the Triggers table above. Levels:
CRITICAL→`error`, WARNING→`warning`, INFO→`note`. Location: the config path relative to the project root (`$HOME` configs render with `~`).

## Example

```
✗ sandbox-posture — 0/100 (weight 0, advisory) [mechanical]
  CRITICAL Codex CLI sandbox disabled in .codex/config.toml
    sandbox_mode = "danger-full-access" drops the filesystem and network boundary,
    and approval_policy = "never" drops the approval prompt.
  WARNING Claude Code declares no deny rules in .claude/settings.json
    permissions.deny is empty or absent — no tool call is refused outright, so the
    allow list plus an approval prompt are the whole boundary.
  WARNING Devcontainer runs an agent with no egress control in .devcontainer/
    Installs an agent CLI and carries no firewall, no proxy, no default-deny network
    rule and no capability drop — nothing in it even attempts to bound what the agent
    can reach. Presence check: no attempt is visible; a hit would have proven only an
    attempt, never containment.
  postures: codex=unrestricted claude-code=partial
```

## Scope and limitations

- **The TOML reader is a targeted key reader, not a TOML parser.** rigscore ships only `chalk` + `yaml`;
  three scalars do not justify a fourth dep. It reads `approval_policy` / `sandbox_mode` (root) and
  `network_access` (`[sandbox_workspace_write]`) — nothing else. Arrays, inline tables (incl. the
  `{ granular = … }` approval form), dotted keys, `[profiles.*]` overrides and multi-line strings are
  **ignored, not interpreted**. Anything it cannot parse is `undefined` and read as *unknown*, never
  *dangerous*, so an unparseable config is never flagged; a `[profiles.*]` block re-enabling
  `danger-full-access` is a known blind spot.
- `network_access` binds only `workspace-write`; under `read-only` it is inert, never read as open network.
- **The JSON reader counts deny rules; it does not read them.** A deny list of one junk string scores the
  same as a real one — this measures *whether anyone drew a boundary*, not whether the boundary holds.
  Unparseable JSON reads as **absent** (unknown, never dangerous), matching the TOML reader's stance, so a
  malformed settings file is never flagged. Enterprise/managed policy files are not read.
- **The devcontainer arm is presence-only: a hit proves an *attempt* at containment, never containment
  itself.** Finding a firewall script, a proxy variable or a `--cap-drop` proves only that someone tried —
  the script may no-op, the proxy may be bypassable, the allowlist may be permissive, the rule may never
  load — and this check reads none of that; it greps text for evidence and does not run, resolve or
  otherwise verify a single control. So the arm may only **fall silent** on evidence: silence here means
  "an attempt is visible", never "this container is contained", and nothing on this page, in the finding
  text or in `data` may be read as the stronger claim. The finding fires only on the unambiguous
  direction — **zero** evidence of any attempt — which is why it is a WARNING and assigns no posture.
  A container that is genuinely contained is proved by a healthcheck that asserts a disallowed host is
  *refused* (see `templates/container`), not by a scanner grep.
- Consequently the arm is **evadable and blind in both directions**: a comment reading `# iptables` or an
  unused `HTTPS_PROXY` silences it, and an agent installed by a name outside its identifier list (a
  vendored binary, a private base image that bakes the CLI in) is not seen at all. It reads the
  devcontainer's own files only — not the base image, not `docker-compose` services it references.

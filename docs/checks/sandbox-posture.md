# sandbox-posture

## Purpose

Every agent CLI expresses "how much can this agent do without asking me" differently, and they only
converge at OS primitives — no cross-vendor permission/sandbox manifest exists. This check is the first
step toward that normalizer: it reduces an agent's sandbox config to **a single posture** (`restricted` /
`partial` / `unrestricted`) in `data.postures`, and flags the dangerous combinations. Maps to **ASI02 —
Tool Misuse & Exploitation**; passing means the client is not both free of approval prompts and able to
reach the network. Exactly one client ships a sandbox-config surface today — **Codex CLI**,
`.codex/config.toml` (`$HOME`, then the project file, which wins) — so that is what it reads:
`approval_policy`, `sandbox_mode`, `[sandbox_workspace_write] network_access`, per the
[Codex config reference](https://developers.openai.com/codex/config-reference). Those paths are carried
in the check itself, as every other check here carries its own; the posture vocabulary is vendor-neutral
so a second client slots in without redefining it (see *Not covered (yet)*).

## Triggers

| Condition | Severity | SARIF ruleId | Remediation summary |
|---|---|---|---|
| `sandbox_mode = "danger-full-access"` (detail also names `approval_policy = "never"` when both are set — the lethal trifecta) | CRITICAL | `sandbox-posture/codex-no-sandbox` | Set `sandbox_mode = "workspace-write"` / `"read-only"` |
| `approval_policy = "never"` **and** network reachable (`workspace-write` + `network_access = true`) | CRITICAL | `sandbox-posture/codex-auto-approve-networked` | `network_access = false`, or raise `approval_policy` |
| `approval_policy = "never"` with write capability, no network | WARNING | `sandbox-posture/codex-auto-approve` | Set `approval_policy = "on-request"` |
| Surface present, nothing above matches → PASS. No sandbox surface anywhere → N/A (`-1`), never 0 | PASS / N/A | — | — |

Posture levels (`data.postures`, keyed by client id):

| Level | Rule |
|---|---|
| `restricted` | `sandbox_mode = "read-only"` — the sandbox binds whatever the approval setting says |
| `unrestricted` | `danger-full-access`, or `approval_policy = "never"` while writes are still possible |
| `partial` | Everything else — e.g. `workspace-write` with approvals left on |

## Weight rationale

**Advisory — weight 0.** Ships on the Security axis so it can be read and argued with before it costs
anyone points; its real weight lands on the Practice axis in a follow-up. Weight-0 checks are excluded
from the coverage denominator in `src/scoring.js`, so this check moves no existing score.

## Fix semantics

No auto-fix. Every finding is a capability decision — how much autonomy this agent gets on this machine —
not a typo; rewriting an `approval_policy` or `sandbox_mode` is a governance edit a scanner must propose,
never perform. Out of scope: editing `.codex/config.toml`.

## SARIF

Tool component `rigscore`; rule IDs are the per-finding `sandbox-posture/*` ids above. Levels:
CRITICAL→`error`, WARNING→`warning`, INFO→`note`. Location: the config path relative to the project root (`$HOME` configs render with `~`).

## Example

```
✗ sandbox-posture — 0/100 (weight 0, advisory) [mechanical]
  CRITICAL Codex CLI sandbox disabled in .codex/config.toml
    sandbox_mode = "danger-full-access" drops the filesystem and network boundary,
    and approval_policy = "never" drops the approval prompt.
  postures: codex=unrestricted
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

## Not covered (yet)

All three were scoped, then cut to keep this PR inside its line budget. Deferred, not forgotten:

- **The client registry (`src/clients.js`, PR #182).** Once it lands on `main`, this check should consume
  it instead of carrying `CODEX.configs` locally — it would iterate every client declaring a `sandbox`
  surface, so new clients are picked up with **no change to this check's logic**. Carrying the 296-line
  registry into *this* PR to read one config path was a bad trade; the follow-up deletes the local table.
- **Claude Code deny-rule posture** — `.claude/settings*.json` with zero `permissions.deny` entries: the
  posture question (are there ANY deny rules?) that `claude-settings` never asks, since it grades
  dangerous *allow* entries instead. Nearly free once the registry lands — add a `sandbox` entry for
  Claude Code there and this check reads it like any other.
- **Devcontainer egress hardening** — a `.devcontainer/` running an agent with no firewall, proxy,
  default-deny rule or cap-drop. A *presence* check — grepping for evidence that someone attempted egress
  control — so it can never prove containment: a hit proves an attempt, not a contained container. That weakness is why it is queued, not shipped.

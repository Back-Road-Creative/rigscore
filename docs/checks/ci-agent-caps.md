# ci-agent-caps

## Purpose

An AI agent running unattended in CI — repo write credentials, no human at the keyboard, no ceiling — is the highest-blast-radius agent surface most teams have. Every CI job that invokes an AI agent must declare three ceilings: a **turn/iteration cap**, a **job timeout**, and **tool scoping**. Maps to OWASP Agentic ASI05 (unbounded autonomy) and ASI02 (tool misuse). A failure usually means the job silently inherits GitHub's 360-minute default timeout and the agent's full default toolset.

Severities follow comparable risks here: `docker-security` grades `privileged: true` (ceiling removed, full host access) CRITICAL and a *missing* hardening control (`cap_drop: [ALL]`, no `user:`) WARNING. A bypass flag is the agent-side `privileged: true`: CRITICAL. A missing cap/timeout/scope is a control never added: WARNING each — three land the check at 55/100 without zeroing it, so a false positive cannot nuke a score.

## Triggers

| Condition | Severity | SARIF ruleId | Remediation summary |
|---|---|---|---|
| Bypass flag anywhere in a workflow: `--dangerously-skip-permissions`, `--dangerously-bypass-approvals-and-sandbox`, `--yolo`, `--permission-mode bypassPermissions`, `--approval-mode yolo`, `--sandbox danger-full-access` | CRITICAL | `ci-agent-caps/agent-permission-bypass` | Remove the flag; scope the agent instead |
| Agent job with no `timeout-minutes` (job- or step-level) | WARNING | `ci-agent-caps/agent-job-missing-timeout` | Add `timeout-minutes:` to the job |
| Agent invocation with no turn cap (`--max-turns` / `max_turns`) | WARNING | `ci-agent-caps/agent-job-missing-turn-cap` | Pass `--max-turns` via `claude_args` or the CLI |
| Agent invocation with unrestricted tools | WARNING | `ci-agent-caps/agent-job-missing-tool-scoping` | Pass `--allowedTools`/`--disallowedTools`, or a sandbox + approval policy |
| Workflow file is not valid YAML | INFO | `ci-agent-caps/failed-to-parse-workflow` | Fix the YAML so the job can be analyzed |
| No workflow invokes an agent (the common case) | N/A | — | — |

## Weight rationale

Advisory — weight 0 (an explicit `'ci-agent-caps': 0` row in `WEIGHTS`). It ships unscored so findings are
visible without moving anyone's number while the detection surface settles. The scored Practice axis assigns
the real weight separately; when that lands, restate the weight here or `verify:docs` flags weight-drift.

## Fix semantics

No auto-fix. Every finding needs a human decision the check cannot make safely: how many turns this job
needs, how long it may run, which tools it may hold. A guessed `--max-turns` or allow-list written into
someone's CI is worse than the finding. Out of scope: editing `.github/workflows/*` — a fixer that rewrites
CI could break the pipeline it is protecting.

## SARIF

- Tool component: `rigscore`; rule IDs are the per-finding `findingId`s in the Triggers table.
- CRITICAL→`error`, WARNING→`warning`, INFO→`note`. Location: project root (workflow file and job name ride
  in the title). The bypass finding emits the matched flag as `properties.evidence`.

## Example

```
✗ ci-agent-caps — 55/100 (advisory)
  WARNING agent.yml job "claude" runs an AI agent with no timeout-minutes
    GitHub's default job timeout is 360 minutes — six unattended hours on a runner with repo write access.
  WARNING agent.yml job "claude" runs anthropics/claude-code-action@v1 with no turn cap
  WARNING agent.yml job "claude" runs anthropics/claude-code-action@v1 with unrestricted tools
```

A repo whose CI runs no agent (most of them, including rigscore itself) reports `↷ CI agent caps … N/A`.

## Scope and limitations

Scans `.github/workflows/*.yml|yaml` only — CI workflow agent jobs are this check's surface alone
(`loop-governance` owns shell scripts and crontabs, so the two never double-deduct the same job).
Surfaces detected: an `anthropics/claude-code-action` / `claude-code-base-action` step, and `run:` steps
shelling out to `claude -p|--print`, `codex exec`, `gemini -p|--prompt`, `aider -m|--msg|--message[-file]`,
or `opencode run`. Every flag/input name comes from primary vendor docs — a name that could not be
confirmed is omitted, never invented:

- Action inputs `claude_args`, `max_turns`, `allowed_tools`, `disallowed_tools`, `settings`, and the v0→v1 move of `timeout_minutes` to job-level `timeout-minutes` — [configuration.md](https://github.com/anthropics/claude-code-action/blob/main/docs/configuration.md), [migration-guide.md](https://github.com/anthropics/claude-code-action/blob/main/docs/migration-guide.md)
- Claude CLI `--max-turns`, `--allowedTools`/`--allowed-tools`, `--disallowedTools`/`--disallowed-tools`, `--tools`, `--permission-mode`, `--dangerously-skip-permissions` — [cli-reference](https://code.claude.com/docs/en/cli-reference)
- Codex CLI `exec`, `--sandbox`/`-s`, `--ask-for-approval`/`-a`, `--dangerously-bypass-approvals-and-sandbox` (`--yolo`) — [codex reference](https://developers.openai.com/codex/cli/reference)
- Gemini CLI `--prompt`/`-p`, `--approval-mode`, `--allowed-tools`, `--yolo` — [gemini reference](https://geminicli.com/docs/cli/cli-reference/)
- Aider CLI `--message`/`--msg`/`-m`, `--message-file` — [options](https://aider.chat/docs/config/options.html), [scripting](https://aider.chat/docs/scripting.html)
- OpenCode CLI `run` — [cli reference](https://opencode.ai/docs/cli/), [permissions](https://opencode.ai/docs/permissions/)

**aider and opencode are graded on `timeout-minutes` alone** (detected, but no turn-cap and no
tool-scoping finding). Re-checked against the four vendor pages linked above on **2026-07-12**, looking
specifically for a turn/iteration cap flag and a tool-scoping/permission flag. Neither exists:

- **No turn cap.** Aider's options page documents no `--max-turns`/iteration flag of any kind; opencode's
  `run` flags are session/model/output only. Emitting a turn-cap WARNING would demand a flag the operator
  cannot pass.
- **No tool-scoping flag.** Aider has no tool allow-list (`--auto-lint`/`--auto-test`/`--auto-commits`
  toggle aider's own behavior, they do not scope a toolset). OpenCode scopes tools through the
  `permission` key in `opencode.json` — a config file, not a CLI flag, and out of this check's
  workflow-only scan. A WARNING here would be unfixable inside the workflow it points at.
- **Their auto-approve flags are NOT treated as bypasses**, on the same reasoning that spares gemini's
  `-y`. Aider's `--yes` ("always say yes to every confirmation") is the form aider's *own* scripting page
  prescribes for non-interactive runs — a CRITICAL would fire on every by-the-book aider CI job. OpenCode's
  `--auto` collides head-on with `gh pr merge --auto`, and the bypass scan is workflow-wide by design. A
  false CRITICAL zeroes a check; a miss costs one warning. Both are pinned by test.

## Not covered (yet)

- **No turn-cap finding for codex or gemini** — neither documents a turn/iteration cap CLI flag (gemini's
  `maxSessionTurns` is a settings key, not a flag). Their tool scoping (`--sandbox` + `--ask-for-approval`,
  `--approval-mode`/`--allowed-tools`) and `timeout-minutes` are still required.
- **Gemini's `-y` is not treated as a bypass** — it collides with `apt-get`/`npm`, and a false CRITICAL is
  worse than a miss. `--yolo` and `--approval-mode yolo` are matched.
- Reusable-workflow calls (`jobs.<id>.uses:`) are not followed.

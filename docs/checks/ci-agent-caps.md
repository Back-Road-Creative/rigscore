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

**codex and gemini carry no turn-cap finding — settled by design, not a TODO.** Both sit at `null` in the
turn-cap column of the CLI table, so no turn-cap finding is emitted for either. Their tool scoping
(`--sandbox` + `--ask-for-approval` for codex, `--approval-mode`/`--allowed-tools` for gemini) and their
`timeout-minutes` are still required and still graded. Verified **2026-07-13** against codex
`rust-v0.144.3` and gemini `v0.50.0`:

- **codex — no turn cap exists anywhere, and upstream explicitly declined to add one.** No `--max-turns`
  flag, no `max_turns`/`max-turns`/`max_iterations` config key, nothing equivalent in the source. The flag
  was requested and refused: [openai/codex#12336, "Add `--max-turns` CLI
  option"](https://github.com/openai/codex/issues/12336) is CLOSED as **NOT_PLANNED** (2026-02-21). The
  `max`/`limit` keys in the [config
  reference](https://github.com/openai/codex/blob/main/docs/config.md) are all unrelated —
  `agents.max_depth`, `agents.max_threads`, `agents.job_max_runtime_seconds`, `model_context_window`,
  `history.max_bytes`, `tool_output_token_limit` are token budgets, concurrency limits and timeouts, not
  turn caps. That is what makes this `null` durable: evidence of absence, not absence of evidence. It
  stands until upstream ships a cap.
- **gemini — a turn cap DOES exist and DOES matter, but it is out of this check's scan reach.**
  `model.maxSessionTurns` is real, defaults to `-1` (**unlimited**), and is genuinely enforced on the
  non-interactive CI path — [settings.md](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/settings.md)
  ("Maximum number of user/model/tool turns to keep in a session. -1 means unlimited"), raised as "Maximum
  session turns exceeded" in
  [nonInteractiveCli.ts](https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/nonInteractiveCli.ts).
  But it is sourced from settings **only** (`packages/cli/src/config/config.ts` reads
  `settings.model?.maxSessionTurns`); there is no corresponding yargs CLI option, so a `run: gemini -p …`
  line in a workflow can never carry it. The cap lives in `.gemini/settings.json` — a file this
  workflow-only check never reads. There is no in-workflow token that could be matched, so a WARNING here
  would point at a file where the operator physically cannot fix it.
- **The condition that would justify a gemini turn-cap arm** (neither is implemented — this is the trigger
  to revisit, not a plan): the check grows a repo-config surface and reads `.gemini/settings.json`, where a
  CI `gemini -p` run with `maxSessionTurns` absent or `-1` becomes a real, fixable finding; **or** it
  learns the [`google-github-actions/run-gemini-cli`](https://github.com/google-github-actions/run-gemini-cli)
  action — today the `ACTION` regex matches Anthropic actions only.
- **Gemini's `-y` is not treated as a bypass**, on the same reasoning that spares aider's `--yes` above: it
  collides with `apt-get -y`/`npm -y` and the bypass scan is workflow-wide, so a false CRITICAL would fire
  on ordinary setup steps. `--yolo` and `--approval-mode yolo` are matched instead. Pinned by test.

## Not covered (yet)

Genuine gaps — unbuilt, not decided against. (Everything above under "Scope and limitations" is a settled
decision with its evidence attached; do not re-litigate those without new upstream facts.)

- Reusable-workflow calls (`jobs.<id>.uses:`) are not followed.

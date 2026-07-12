# loop-governance

**Enforcement grade:** `pattern` — regex/structural detection over shell scripts. It reads what is written, not what runs; indirection evades it.

## Purpose

Scores how safely a repo runs **agent loops** — anywhere the project drives an AI agent CLI repeatedly with no human in the loop, today meaning a shell script looping over an agent invocation. The rule this check enforces is that an agent loop must be **bounded**: an iteration cap, a turn budget, or a timeout. A loop with none of those is the `while true; do claude -p ...; done` failure — it burns quota and keeps writing to the repo until someone notices. Maps to OWASP Agentic Top 10 **ASI02 — Tool Misuse & Exploitation** (an unbounded agent keeps invoking tools with no ceiling). A pass means every agent loop found is bounded. Most repos have no agent-loop surface at all and correctly return N/A — this is the first check of the **Practice** pillar.

**Scope split:** agent jobs in `.github/workflows/**` belong to the `ci-agent-caps` check and are deliberately ignored here — two checks flagging one uncapped CI job would double-deduct once both are scored on the Practice axis.

## Triggers

| Condition | Severity | SARIF ruleId | Remediation summary |
|---|---|---|---|
| Agent invoked inside a loop with no bound — no counter tested against a limit, no `--max-turns`, no `timeout`, no run budget | WARNING | `loop-governance/uncapped-loop` | Add an iteration cap, a `--max-turns` budget, or wrap in `timeout` |
| `--dangerously-skip-permissions` in any scanned script, loop or not | WARNING | `loop-governance/skip-permissions` | Drop the flag; allow-list the tools the run needs |
| An agent-loop surface exists and every loop is bounded | PASS | — | — |
| No agent invocation and no `--dangerously-skip-permissions` anywhere | N/A | — | — |

**Agents detected:** `claude -p` / `claude --print`, `codex`, `gemini`, `opencode run`, `aider` — each required in *command position* (line start or after a shell separator), so `.claude/settings.json` or a word like `codexample` cannot match.

**Files scanned:** `*.sh` / `*.bash` anywhere, including `scripts/**`. Whole-line comments are blanked first, so a commented-out loop never counts. Hidden directories are skipped, `.github` among them. **Cap signals** (any one clears the loop): `--max-turns` / `--max-iterations` / `--max-steps` / `--max-cost`, a `timeout` command, a `-lt`/`-le`/`-gt`/`-ge` test, a `(( i < MAX ))` test, or a `for x in <finite list>` header (bounded by construction).

## Weight rationale

Advisory — weight 0. The detection is structural and shell is hostile to static analysis, so the finding rate wants observing on real repos before it moves anyone's number. Scoring it now would let a regex miss (a wrapper script, a generated loop) or an over-reach quietly swing a security score. It reports; it does not yet grade.

Severity — **both findings are WARNING; neither CRITICAL.** Calibrated against the existing bar, not picked freehand: `--dangerously-skip-permissions` is WARNING **because rigscore already grades that exact flag WARNING** — `mcp-config` carries it in its unsafe-permission-flag set and emits `mcp-config/unsafe-permission-flag`. Grading the same string CRITICAL here purely because it sits in a script rather than an MCP arg would be incoherent. CRITICAL is reserved in this codebase for active exfiltration or the persistent removal of every confirmation layer at config level (`anthropic-base-url-redirected`, `mcp-auto-approve-enabled`, `bypass-plus-skip-prompt`, a tracked `.env`, a mounted Docker socket); an unbounded loop is a budget-and-blast-radius defect scoped to one script — the headline of this check, but not that class. CRITICAL also zeroes a check outright, which on a weight-0 advisory is noise, not signal.

## Fix semantics

No `fixes` export. `--fix --yes` is a no-op — both findings need a human decision.

- `uncapped-loop` → the right bound (10 iterations? 30 minutes? 5 turns?) is a judgment about the task; a scanner that guesses wrong either breaks a working loop or installs a cap that does nothing.
- `skip-permissions` → deleting the flag changes what the script does and can break a deliberate (if unwise) unattended run.

## SARIF

- Tool component: `rigscore`. Rule IDs: `loop-governance/uncapped-loop`, `loop-governance/skip-permissions`. Level mapping: WARNING → `warning`; PASS / N/A emit no results.
- Location: relative path of the offending script (`context.file`). Evidence: the offending loop header, trimmed to 120 chars (the file path for skip-permissions findings).

## Example

```
✗ Loop governance ............... [pattern] advisory
  WARNING Uncapped agent loop in scripts/fix-loop.sh
          → Fix: add an iteration cap, a --max-turns budget, or wrap in `timeout`.
```

## Not covered (yet)

The first slice is thin by budget, not by design. Each item below is a small, ordinary PR against this file now that it exists — the omissions are scope, not oversight.

- **`no-stop-condition`** — a loop stoppable only by killing it: an unconditional header (`while true`, `until false`, `for ((;;))`) whose body evaluates nothing to decide it is done. Detection: flag only when the header is unconditional **and** the body holds no `break`, `exit N`, `return`, `if`, `[ -f … ]` / `test -f` sentinel, or `grep -q`. Deferred as the most heuristic of the three findings — it deserves implementing without a line budget over its head, and `uncapped-loop` already covers the runaway-cost case (a bounded loop that never terminates is still bounded).
- **Cron / crontab files** (`crontab`, `*.cron`, `*.crontab`) — an agent on a cron line is a loop whose iteration is the schedule: it terminates each tick, so `no-stop-condition` would not apply, but nothing bounds what one unattended tick may spend. Detection: a five-field cron line (or `@reboot` / `@daily`) plus an agent invocation, reusing the existing cap signals.
- **Agents behind indirection** — a `Makefile` target, an `npm` script, a Python `subprocess`. Reaching these means resolving one level of call: a different, and much less certain, analysis than reading a shell loop.

CI agent jobs (`.github/workflows/**`) are **not** on this list — permanently out of scope here, owned by `ci-agent-caps`.

## Scope and limitations

Tuned so that a **false "your loop is uncapped" is worse than a miss** — every ambiguity resolves toward silence. The consequences:

- **Any one cap signal clears a loop.** A `timeout` or `-lt` anywhere in the body marks it capped even if unrelated to the agent. Proving a counter actually bounds *this* loop needs dataflow analysis a regex scanner does not have.
- **Loop bodies are matched textually, not parsed.** A `done` inside a heredoc or a quoted string can close a block early. Nested loops report once per file.
- **`fixtures` dirs are skipped** (with `node_modules`, `.git`, `.venv`, `venv`, `__pycache__`, `dist`, `build`, `coverage`) — as `deep-secrets` skips `*.test.*`: fixture trees hold deliberately-unsafe samples, not loops anyone runs. A real agent loop parked under `fixtures/` is a blind spot. Symlink loops and runaway depth are handled by the shared `walkDirSafe` walker; the walk stops after 2000 candidate files. Filesystem reads only — no network, no execution, no shell-out, per rigscore's offline contract.

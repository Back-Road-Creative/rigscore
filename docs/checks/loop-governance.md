# loop-governance

**Enforcement grade:** `pattern` — regex/structural detection over shell scripts. It reads what is written, not what runs; it follows a call **up to three hops** and no further.

## Purpose

Scores how safely a repo runs **agent loops** — anywhere the project drives an AI agent CLI repeatedly with no human in the loop — a shell script looping over an agent invocation, or a cron line whose iteration *is* the schedule. The rule this check enforces is that an agent loop must be **bounded** — an iteration cap, a turn budget, or a timeout — and must be able to **stop**. A loop with none of those is the `while true; do claude -p ...; done` failure — it burns quota and keeps writing to the repo until someone notices. Maps to OWASP Agentic Top 10 **ASI02 — Tool Misuse & Exploitation** (an unbounded agent keeps invoking tools with no ceiling). A pass means every agent loop found is bounded. Most repos have no agent-loop surface at all and correctly return N/A — this is the first check of the **Practice** pillar.

**Scope split:** agent jobs in `.github/workflows/**` belong to the `ci-agent-caps` check and are deliberately ignored here — two checks flagging one uncapped CI job would double-deduct once both are scored on the Practice axis.

## Triggers

| Condition | Severity | SARIF ruleId | Remediation summary |
|---|---|---|---|
| Agent invoked inside a loop with no bound — no counter tested against a limit, no `--max-turns`, no `timeout`, no run budget | WARNING | `loop-governance/uncapped-loop` | Add an iteration cap, a `--max-turns` budget, or wrap in `timeout` |
| Agent loop with an unconditional header whose body evaluates nothing to decide it is done — stoppable only by killing it | WARNING | `loop-governance/no-stop-condition` | Give the loop a terminal state to test for — break on success, or check a stop sentinel each pass |
| Agent on a cron line with nothing bounding one unattended tick | WARNING | `loop-governance/uncapped-cron` | Wrap the scheduled invocation in `timeout`, or give it a `--max-turns` budget |
| Agent in the `ExecStart` of a service a systemd timer schedules, with nothing bounding one tick | WARNING | `loop-governance/uncapped-timer` | Add `RuntimeMaxSec=` to the service unit, or give the agent a `--max-turns` budget |
| `--dangerously-skip-permissions` in any scanned script, loop or not | WARNING | `loop-governance/skip-permissions` | Drop the flag; allow-list the tools the run needs |
| An agent-loop surface exists and every loop and cron job is bounded | PASS | — | — |
| No agent invocation and no `--dangerously-skip-permissions` anywhere | N/A | — | — |

`uncapped-loop` and `no-stop-condition` are **orthogonal** — a `while true; do claude -p … --max-turns 5; done` is bounded per iteration (no cost finding) and still runs until someone kills it (stop finding). Both can fire on one loop.

**Agents detected:** `claude -p` / `claude --print`, `codex`, `gemini`, `opencode run`, `aider` — each required in *command position* (line start or after a shell separator), so `.claude/settings.json` or a word like `codexample` cannot match.

**Indirection — a call is followed up to three hops.** A loop that runs `make agent` drives an agent just as surely as one that types `claude -p`; the binary is simply a file away — or two files away, when that target only runs a script that runs the agent. A first pass records the *body* of every **make target**, **npm script**, **Python module**, and **shell script**; a resolver then repeatedly indexes every body that reaches an agent — directly, or by calling a body already indexed — for at most **three rounds** (`MAX_HOPS`). The loop, cron, and timer surfaces then treat a call to any indexed name as an agent invocation. So `while true; do make agent; done`, a cron line running `npm run agent:fix`, `python3 agent_runner.py` (a `subprocess` / `os.system` call carrying an agent binary), and `make agent` → `./scripts/agent.sh` → `claude -p` all read as agent loops.

Termination is structural rather than a visited-set: a round only ever **adds** to a set it never removes from, so a script that calls itself — or a cycle of scripts calling each other — contributes nothing new and the resolver stops. `MAX_HOPS` is the belt to that braces; the work is bounded either way.

**Loops inside a Python indirection target are read.** A `while True:` around an agent call, written in the module a Makefile target invokes rather than in the Makefile, emits the ordinary `uncapped-loop` / `no-stop-condition` findings **against the module** — that is where the bound goes. Python has no `done`, so a loop body is taken to be the run of lines indented deeper than its `while`/`for` header. Cap and stop signals are the shared ones, so `for i in range(10):` is bounded by construction and a `break` clears the stop finding. A module with no loop of its own is not a surface — only its *call* is, and that is read wherever the call is written.

**Files scanned:** `*.sh` / `*.bash` anywhere, including `scripts/**`, plus cron files (`crontab`, `*.cron`, `*.crontab`), the indirection surfaces (`Makefile` / `*.mk`, `package.json`, `*.py`), and systemd units (`*.timer`, `*.service`). Loops are read in shell, Makefile recipes, cron, and Python; `package.json` and `*.service` are resolved, not parsed. Whole-line comments are blanked first — and make's `@`/`-`/`+` recipe prefixes stripped, so `@claude -p` reads as a command — meaning a commented-out loop or cron line never counts. Hidden directories are skipped, `.github` among them. **Cap signals** (any one clears a loop or a cron line): `--max-turns` / `--max-iterations` / `--max-steps` / `--max-cost`, a `timeout` command, a `-lt`/`-le`/`-gt`/`-ge` test, a `(( i < MAX ))` test, or a `for x in <finite list>` header (bounded by construction); on a systemd service, also `RuntimeMaxSec` / `TimeoutStartSec` / `TimeoutSec` (an `infinity` value is not a bound). **Stop signals** (any one clears `no-stop-condition`): `break`, `exit`, `return`, an `if`, a `[ -f … ]` / `test -f` sentinel, or `grep -q`. **Unconditional headers:** `while true`, `until false`, `for ((;;))`, and Python's `while True:` / `while 1:`. **Cron lines:** five schedule fields, or an `@`-shorthand (`@reboot`, `@daily`, …), followed by a command. **Timers:** a `*.timer` is paired to its service by an explicit `Unit=`, else by same-basename; the agent is read from that service's `ExecStart`, whose absolute path is stripped so `/usr/bin/claude` reads as a command.

## Weight rationale

Advisory — weight 0. The detection is structural and shell is hostile to static analysis, so the finding rate wants observing on real repos before it moves anyone's number. Scoring it now would let a regex miss (a wrapper script, a generated loop) or an over-reach quietly swing a security score. It reports; it does not yet grade.

Severity — **both findings are WARNING; neither CRITICAL.** Calibrated against the existing bar, not picked freehand: `--dangerously-skip-permissions` is WARNING **because rigscore already grades that exact flag WARNING** — `mcp-config` carries it in its unsafe-permission-flag set and emits `mcp-config/unsafe-permission-flag`. Grading the same string CRITICAL here purely because it sits in a script rather than an MCP arg would be incoherent. CRITICAL is reserved in this codebase for active exfiltration or the persistent removal of every confirmation layer at config level (`anthropic-base-url-redirected`, `mcp-auto-approve-enabled`, `bypass-plus-skip-prompt`, a tracked `.env`, a mounted Docker socket); an unbounded loop is a budget-and-blast-radius defect scoped to one script — the headline of this check, but not that class. CRITICAL also zeroes a check outright, which on a weight-0 advisory is noise, not signal.

## Fix semantics

No `fixes` export. `--fix --yes` is a no-op — both findings need a human decision.

- `uncapped-loop` → the right bound (10 iterations? 30 minutes? 5 turns?) is a judgment about the task; a scanner that guesses wrong either breaks a working loop or installs a cap that does nothing.
- `no-stop-condition` → *what* counts as done is the task itself. Only the author knows the terminal state.
- `uncapped-cron` → same judgment as `uncapped-loop`, against a schedule the scanner cannot see.
- `uncapped-timer` → same judgment as `uncapped-cron`, and the bound belongs in a unit file whose other consumers the scanner cannot see.
- `skip-permissions` → deleting the flag changes what the script does and can break a deliberate (if unwise) unattended run.

## SARIF

- Tool component: `rigscore`. Rule IDs: `loop-governance/uncapped-loop`, `loop-governance/no-stop-condition`, `loop-governance/uncapped-cron`, `loop-governance/uncapped-timer`, `loop-governance/skip-permissions`. Level mapping: WARNING → `warning`; PASS / N/A emit no results.
- Location: relative path of the offending script, cron file, or `*.timer` unit (`context.file`) — for an indirect agent this is the file holding the **loop**, which is where the bound goes, not the file holding the agent. Evidence: the offending loop header, cron line, or service `ExecStart`, trimmed to 120 chars (the file path for skip-permissions findings).

## Example

```
✗ Loop governance ............... [pattern] advisory
  WARNING Uncapped agent loop in scripts/fix-loop.sh
          → Fix: add an iteration cap, a --max-turns budget, or wrap in `timeout`.
```

## Not covered (yet)

Each item below is a small, ordinary PR against this file — the omissions are scope, not oversight.

- **The fourth hop** — three are followed, not four. A chain longer than `make` → script → script → agent still hides the agent. The cap is a deliberate ceiling on the work, not an oversight: each hop is another chance to resolve the wrong thing, and a four-deep call chain around an agent is rarer than the misresolution risk of chasing it.
- **Loops written inside a JS indirection target** — a runner's `for(;;)` in the `.js` an npm script invokes. Python's control flow is now read; JavaScript's is not, and reading it means parsing that language, not shell's. Its *call* is still resolved, so a shell or cron loop around it is seen.

CI agent jobs (`.github/workflows/**`) are **not** on this list — permanently out of scope here, owned by `ci-agent-caps`.

## Scope and limitations

Tuned so that a **false "your loop is uncapped" is worse than a miss** — every ambiguity resolves toward silence. The consequences:

- **Any one cap signal clears a loop.** A `timeout` or `-lt` anywhere in the body marks it capped even if unrelated to the agent. Proving a counter actually bounds *this* loop needs dataflow analysis a regex scanner does not have.
- **`no-stop-condition` is the most heuristic finding here, and is tuned to miss.** It fires only on the three written unconditional headers (`while true`, `until false`, `for ((;;))`) — `while :`, `while [ 1 ]`, or a `$RUNNING` flag variable are infinite loops it will not see. And any one stop signal buys silence: a single `if` anywhere in the body clears the loop, even an `if` that only logs. Both biases are the same bet — a loop that *does* terminate being called unstoppable is a worse outcome than a quiet miss, because it teaches the operator to ignore the check.
- **Indirection resolves by name, not by scope.** A make target / npm script / python module / shell script is indexed repo-wide — modules and scripts by **basename** — so a loop running `make agent` matches a target named `agent` in *any* Makefile in the tree, not necessarily the one that `make` would actually pick from that working directory, and `./agent.sh` matches an `agent.sh` in any directory. Following calls three hops rather than one widens that reach: the deeper the chain, the more chances to land on a same-named file the shell would never have run. Modelling make's directory resolution is a build-system emulator, not a regex — and a name that reaches an agent somewhere in the repo is worth a warning wherever it is looped on.
- **Cron detection reads the line, not the schedule.** `@reboot` and a five-field line are treated alike: neither the frequency nor the runtime is modeled, so a once-a-year job and a `* * * * *` job are the same finding. Cap signals must sit **on the cron line itself** — a bound expressed elsewhere (an `ulimit` inside the script it calls, a systemd `RuntimeMaxSec`, a lock file that makes overlapping ticks a no-op) reads as uncapped. Conversely a five-field regex is a shape, not a parse: an unrelated file merely *named* `*.cron` whose lines happen to hold five tokens and an agent word would match.
- **A crontab is scanned only where it is committed.** The real one lives in `crontab -e` / `/etc/cron.d`, off the repo — a filesystem-only scanner cannot see it, and the check makes no claim about what is actually scheduled on the machine.
- **Loop bodies are matched textually, not parsed.** A `done` inside a heredoc or a quoted string can close a block early. A Python loop body is delimited by indentation alone, so a deeper-indented line inside a triple-quoted string reads as part of the block. Nested loops report once per file.
- **`fixtures` dirs are skipped** (with `node_modules`, `.git`, `.venv`, `venv`, `__pycache__`, `dist`, `build`, `coverage`) — as `deep-secrets` skips `*.test.*`: fixture trees hold deliberately-unsafe samples, not loops anyone runs. A real agent loop parked under `fixtures/` is a blind spot. Symlink loops and runaway depth are handled by the shared `walkDirSafe` walker; the walk stops after 2000 candidate files. Filesystem reads only — no network, no execution, no shell-out, per rigscore's offline contract.

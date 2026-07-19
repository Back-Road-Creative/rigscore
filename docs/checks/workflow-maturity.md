# workflow-maturity

**Enforcement grade:** `keyword` — graduation signals derived from phrase presence against governance / process prose (taxonomy markers, graduation signals, eval-coverage language). Evadable by rewording; advisory only.

## Purpose

Measures how well a project's AI-dev artifacts (skills, MCP servers, memory, pipelines) line up with graduation and decomposition signals from the AI development taxonomy (thresholds are inlined in `src/checks/workflow-maturity.js` — see `## Scope and limitations` below). Six sub-checks: (0) **graduated-script-missing** — a skill whose frontmatter declares `status: graduated-code` asserts it is a thin wrapper over a deterministic script; if that script isn't on disk the skill is non-functional (`exit 127` on every invocation) while its version bump advertises the opposite. (1) **eval-coverage** — every discovered skill should have at least one eval or test, since graduation from skill → code requires coverage. (2) **skill-compound-responsibility** — skills with ≥8 trigger keywords likely handle multiple concerns and should be split. (3) **mcp-single-consumer** — an MCP server referenced by ≤1 skill doesn't justify the MCP overhead versus a library. (4) **memory-orphan** — `.md` files in a memory directory that aren't linked from `MEMORY.md` bias the model silently. (5) **pipeline-step-overload** — Python pipeline files with ≥10 stage markers, or stage/phase directories with ≥10 modules, indicate orchestration breadth that warrants sub-pipeline decomposition. Maps to OWASP Agentic Top 10 **ASI01 — Agent Authorization & Control Hijacking** loosely (sprawling, unevaluated agents are harder to constrain), but the primary frame is maturity and refactor signal, not vulnerability.

## Triggers

| Condition | Severity | SARIF ruleId | Remediation summary |
|---|---|---|---|
| Skill has no `evals/<name>/` directory and no `tests/test_<name>*` file (hyphens tolerated as `_`) | INFO | `workflow-maturity/skill-no-eval` | Add at least one eval or test before graduating the skill. |
| Skill has ≥8 distinct trigger keywords (frontmatter `triggers:` array or `## Triggers` section) | INFO | `workflow-maturity/skill-compound-responsibility` | Split the skill into focused concerns. |
| Skill declares `status: graduated-code` but invokes an absolute script path that is not on disk | WARNING | `workflow-maturity/graduated-script-missing` | Create the script, fix the path, or revert the skill to LLM-driven. |
| MCP server name appears in ≤1 discoverable SKILL.md | WARNING | `workflow-maturity/mcp-single-consumer` | Add consumers or remove the MCP server. |
| Memory `.md` file not linked from its directory's `MEMORY.md` (or `MEMORY.md` missing) | WARNING | `workflow-maturity/memory-orphan` | Add a link in the MEMORY.md index. |
| Pipeline file matches `^(pipeline\|orchestrator).*\.py$` or `*_stage.py` and contains ≥10 stage markers | INFO | `workflow-maturity/pipeline-step-overload` | Decompose into sub-pipeline modules. |
| Directory named `stages` or `phases` (overridable) contains ≥10 non-underscore-prefixed `.py` files | INFO | `workflow-maturity/stage-dir-overload` | Group related stages into sub-pipeline packages. |
| Nothing scannable (no skills, no MCP servers, no pipeline files, no memory dirs) | N/A | — | — |
| All clean | PASS | — | — |

**Stage-marker patterns** (any match counts as one stage, capped at one per line): `# Stage N`, `# Step N`, `Phase X`, `stage_N`, `STAGE_N`, `## Stage/Step/Phase`, letter-keyed phase substeps like `# A1:` / `# B5.5:` / `# C2 —`, and Python class declarations `class FooStage` / `class PhaseA`.

**Skill discovery**: `.claude/skills/*/SKILL.md` and `.claude/commands/*/SKILL.md` under both cwd and homedir.

**MCP server discovery**: every MCP config declared by a known AI client in `src/clients.js` (the same union `mcp-config` scans — `.mcp.json`, `.vscode/mcp.json`, Cursor, Windsurf, Cline, Continue, Gemini CLI, opencode, Amp, Claude Desktop, Zed), plus `.claude/settings.json` under both cwd and homedir. The server key is resolved per client, not assumed: `mcpServers` for most, `mcp` for opencode, `context_servers` for Zed. Paths no client claims fall back to `mcpServers`.

**Memory discovery**: `~/.claude/projects/*/memory/*.md` and `{cwd}/.claude/memory/*.md`.

**Excluded directories** during pipeline and stage-dir walks: `node_modules`, `.venv`, `__pycache__`, `.git`.

## Weight rationale

Advisory — weight 0. This check reports **maturity and refactor signals**, not security posture. An 11-stage pipeline isn't a vulnerability; an MCP server with one consumer isn't exploitable. Every finding here is a judgment call about whether a given artifact has outgrown its current form — decisions that depend on roadmap and team context the scanner can't see. Scoring these would conflate "this project should consider refactoring" with "this project has a security problem," degrading both signals. The check is intentionally a nudging layer on top of the scored moat.

## Fix semantics

No `fixes` export. `--fix --yes` is a no-op.

- Every remediation is a structural change: write an eval, split a skill, remove an MCP server, reorganize a pipeline, edit a memory index. None of these are safe to automate from a static scan.
- Orphan-memory findings are the closest to auto-fixable (append a link to MEMORY.md), but the index is authored prose and should be curated by the user.

## SARIF

- Tool component: `rigscore`; rule IDs are the per-finding `workflow-maturity/*` ids in the Triggers table, with `workflow-maturity` as the check-level fallback rule.
- Level mapping: WARNING → `warning`, INFO → `note`, PASS/SKIPPED → `none`.
- Location data: pipeline findings carry the relative path of the offending `.py` file; stage-dir findings carry the directory relative path; memory findings carry the absolute memory path in the message; skill/MCP findings reference names rather than file paths.

## Example

```
ⓘ workflow-maturity — advisory (7 skills, 2 MCP servers, 3 pipelines scanned)
  INFO   Skill `triage` has no eval
         Create evals/triage/ or tests/test_triage.* to provide coverage.
  WARNING MCP server `local-rag` has ≤1 discoverable consumer
         MCP overhead requires at least 2 consumers to justify.
  WARNING `2026-Q1-notes.md` is not linked from MEMORY.md
         /home/joe/.claude/projects/.../memory/2026-Q1-notes.md
         — orphan memory biases responses without visibility.
  INFO   Pipeline `src/orchestrator.py` has 14 stage markers
         Consider sub-pipeline decomposition.
```

## Scope and limitations

- **Taxonomy source**: thresholds (`≥8 triggers`, `≤1 MCP consumer`, `≥10 stage markers`, `≥10 stage-dir modules`) are defined inline in `src/checks/workflow-maturity.js` and reflect the graduation/decomposition heuristics from the AI development taxonomy. Teams with different maturity bars can partially tune the check via `config.workflowMaturity.stageDirs` (override the default `['stages', 'phases']` directory-name list).
- Stage-marker detection is regex-based and runs only on files matching the pipeline filename patterns (`^(pipeline|orchestrator).*\.py$`, `*_stage.py`). Non-Python pipelines and pipelines with non-conforming filenames are not scanned.
- MCP consumer count is a case-insensitive substring match on the server name across all discovered SKILL.md content. Servers with very generic names (single English word) may false-positive as "has consumers."
- **Graduated-script detection is deliberately conservative** — it only inspects skills declaring `status: graduated-code` (a v1.x LLM-driven skill legitimately has no script), and only reports **absolute** paths invoked via `bash`/`sh`/`python`/`python3`/`node`. Skipped without a finding: placeholder or interpolated tokens (`<path>`, `${VAR}`, `$1`, `{{ }}`), comment lines, and **relative paths** — a relative path resolves against the shell's cwd at invocation time, which a static scan cannot know, so guessing a base would manufacture both misses and false hits. `~` and `$HOME` are expanded against the scan's homedir before the existence test.
- Orphan memory detection compares basenames only within a single memory directory — cross-directory links don't count.
- Eval detection accepts both hyphen- and underscore-normalized skill names (`skill-name` → `test_skill_name*`).

## Sources

Primary sources this check is grounded in (evidence-backed, not best-practice vibes):

- [OWASP Top 10 for Agentic Applications (2026)](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026) — the agentic-workflow maturity signals this practice axis grades.

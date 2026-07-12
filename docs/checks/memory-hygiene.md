# memory-hygiene

## Purpose

Agent memory — the files an agent auto-loads every session — is both a context-budget surface and a correctness surface. Every byte is re-injected on every turn, so bloat is billed per request, and a memory file that says nothing still costs that toll. **No incumbent convention exists for memory layout; this check defines one.** Two signals ship in this first slice: **budget** (the auto-loaded bundle exceeds a stated byte budget) and **stale content** (a memory file that is empty, or a bare stub with frontmatter and no body). Both are mechanical — byte counts and body-length math, no heuristics, no false positives. Maps loosely to OWASP Agentic **ASI01 — Agent Goal Hijack**: memory is injected ahead of the live instruction, so junk in it competes with governance for the model's attention. A pass means memory is small and every file carries a rule.

## Triggers

| Condition | Severity | SARIF ruleId | Remediation summary |
|---|---|---|---|
| Memory bundle over 40,000 bytes | WARNING | `memory-hygiene/bundle-over-budget` | Consolidate files; delete resolved incidents |
| Memory file is empty | WARNING | `memory-hygiene/stale-memory-file` | Write it out, or delete the file + index entry |
| Memory file has frontmatter/heading but no body | INFO | `memory-hygiene/stale-memory-file` | Fill it in or delete it |
| No memory files found (most repos) | N/A | — | — |

## Not covered (yet)

Stated omissions, not oversights. The check module exists on `main` after this PR, so each is an ordinary follow-up PR.

- **Unindexed / orphan memory files — owned by another check, deliberately not duplicated.** `workflow-maturity/memory-orphan` already flags `.md` files in a memory dir that no `MEMORY.md` links, including the no-index-at-all case. Emitting it here too would double-count one defect. A regression test (`test/memory-hygiene.test.js`) pins that this check stays silent on it.
- **Single home per rule** (the same rule stated in both `CLAUDE.md` and a memory file, so an edit to one silently fails to take effect). Deferred on purpose: matching near-identical normalized lines is a heuristic, and a false "these are duplicates" is worse than a miss. It needs its own PR to get the precision right — and `instruction-effectiveness/redundant-instruction` already gives a weaker INFO-level signal on lines repeated across instruction files.
- **A configurable budget.** `src/config.js` merges user config key-by-key, so a `memoryHygiene` key in `.rigscorerc.json` is dropped today. Wiring it is a one-line change there.
- **Index-linked files outside a memory dir.** Topic files are discovered by directory; a `MEMORY.md` link pointing outside `.claude/memory/` is not followed.

## Weight rationale

**Advisory — weight 0.** Carries an explicit `0` row in `WEIGHTS`, the shape every advisory check uses (`documentation`, `workflow-maturity`, `agent-output-schemas`): it reports but never moves the overall score. Advisory because the convention is new — this check *defines* a memory layout rather than measuring an established one, and a fresh convention should be observed in the wild before it can dock points. The scored "Practice" pillar assigns the real weight in a separate change; this rationale updates with it.

## Fix semantics

No auto-fix; `--fix --yes` does nothing for this check. Both findings need a human decision: consolidating memory means judging which file owns a rule, and deleting a stub means knowing whether the note was abandoned or merely unfinished. A scanner that guessed wrong would delete authored governance.

## SARIF

- Tool component: `rigscore`; rule IDs are the per-finding `memory-hygiene/*` ids in the Triggers table, with `memory-hygiene` as the check-level fallback rule.
- Level mapping: WARNING→`warning`, INFO→`note`.
- Location data: project root; findings name the offending file in the message.
- Evidence: both findings emit `properties.evidence` — the file + byte count, or the bundle total.

## Example

```
✗ Agent memory hygiene — 83/100 (advisory) [mechanical]
  WARNING Empty memory file: .claude/memory/empty.md
    .claude/memory/empty.md is empty. It teaches the agent nothing but is
    still loaded every session.
  INFO    Stub memory file: .claude/memory/stub.md
```

## Scope and limitations

- **Locations scanned:** `{cwd}/.claude/memory/*.md`, plus `{cwd}/MEMORY.md` and `{cwd}/.claude/MEMORY.md`. The whole memory directory counts toward the budget — harnesses differ on eager vs lazy topic loading, so the conservative assumption is that anything in it can be pulled in.
- **Home directory is opt-in.** `~/.claude/memory/` and `~/.claude/projects/*/memory/` are scanned only under `--include-home-skills` — the same gate `instruction-effectiveness` and `skill-files` use. An unasked-for home scan is a surprise, and home memory is not the project's to fix.
- **Budget is 40,000 bytes:** ~10k tokens at ~4 chars/token, about 5% of the 200k-token reference window `instruction-effectiveness` scores against. Memory is one slice of always-on context (governance + skills + memory), so it gets a minority share of it. A repo that blows this budget is paying for it on every single turn, not once.
- **Stub detection strips YAML frontmatter and markdown headings**, then requires ≥20 non-whitespace body characters. A file whose entire content is a heading and a `status:` field is a stub by that rule.

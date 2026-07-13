# memory-hygiene

## Purpose

Agent memory — the files an agent auto-loads every session — is both a context-budget surface and a correctness surface. Every byte is re-injected on every turn, so bloat is billed per request, and a memory file that says nothing still costs that toll. **No incumbent convention exists for memory layout; this check defines one.** Three signals ship today: **budget** (the auto-loaded bundle exceeds a byte budget, now configurable), **stale content** (a memory file that is empty, or a bare stub with frontmatter and no body), and **single home per rule** (the same rule written into both a governance file and a memory file, so editing one copy silently fails to take effect). Budget and stale content are pure arithmetic — byte counts and body-length math. Single-home is exact-match comparison after normalization, against every governance file that is loaded alongside memory — the root set, nested package governance, and (opt-in) home governance — with hard-wrapped lines re-joined first: deterministic, but a proxy for "same rule", so it is tuned to miss rather than to over-call. Maps loosely to OWASP Agentic **ASI01 — Agent Goal Hijack**: memory is injected ahead of the live instruction, so junk in it competes with governance for the model's attention. A pass means memory is small, every file carries a rule, and every rule has exactly one home.

## Triggers

| Condition | Severity | SARIF ruleId | Remediation summary |
|---|---|---|---|
| Memory bundle over the byte budget (default 40,000) | WARNING | `memory-hygiene/bundle-over-budget` | Consolidate files; delete resolved incidents |
| Memory file is empty | WARNING | `memory-hygiene/stale-memory-file` | Write it out, or delete the file + index entry |
| Memory file has frontmatter/heading but no body | INFO | `memory-hygiene/stale-memory-file` | Fill it in or delete it |
| A rule appears verbatim in both a governance file (root, nested, or — opt-in — home) and a memory file | INFO | `memory-hygiene/duplicate-rule` | Keep the rule in governance; leave the memory file the why/incident/evidence |
| No memory files found (most repos) | N/A | — | — |

## Configuration

```json
{ "memoryHygiene": { "budgetBytes": 80000 } }
```

`memoryHygiene.budgetBytes` (default `40000`) sets the byte budget for the auto-loaded bundle. Project `.rigscorerc.json` beats `~/.rigscorerc.json`; a non-integer or non-positive value is ignored and the default stands. Raise it for a repo that deliberately carries a large always-on memory set; lower it to hold a tighter line.

## Not covered (yet)

Stated omissions, not oversights — each is an ordinary follow-up PR.

- **Unindexed / orphan memory files — owned by another check, deliberately not duplicated.** `workflow-maturity/memory-orphan` already flags `.md` files in a memory dir that no `MEMORY.md` links, including the no-index-at-all case. Emitting it here too would double-count one defect. A regression test (`test/memory-hygiene.test.js`) pins that this check stays silent on it.
- **Index-linked files outside a memory dir.** Topic files are discovered by directory; a `MEMORY.md` link pointing outside `.claude/memory/` is not followed.
- **A reworded rule.** Comparison is exact after normalization; a rule restated in different words ("never merge a PR yourself" vs "the operator merges every PR by hand") is not detected as a second home. Closing this needs semantic similarity, and a similarity score that is wrong calls an author's two distinct rules one duplicated rule — a false "two homes" costs more trust than the miss does. Deferred until there is a way to do it that is defensible line-by-line. (Hard-wrapping — the same rule split across two lines — *is* now matched; see Scope and limitations.)

## Weight rationale

**Advisory — weight 0.** Carries an explicit `0` row in `WEIGHTS`, the shape every advisory check uses (`documentation`, `workflow-maturity`, `agent-output-schemas`): it reports but never moves the overall score. Advisory because the convention is new — this check *defines* a memory layout rather than measuring an established one, and a fresh convention should be observed in the wild before it can dock points. The scored "Practice" pillar assigns the real weight in a separate change; this rationale updates with it.

## Fix semantics

No auto-fix; `--fix --yes` does nothing for this check. Every finding needs a human decision: consolidating memory means judging which file owns a rule, deleting a stub means knowing whether the note was abandoned or merely unfinished, and de-duplicating a rule means choosing which of the two homes keeps it. A scanner that guessed wrong would delete authored governance.

## SARIF

- Tool component: `rigscore`; rule IDs are the per-finding `memory-hygiene/*` ids in the Triggers table, with `memory-hygiene` as the check-level fallback rule.
- Level mapping: WARNING→`warning`, INFO→`note`.
- Location data: project root; findings name the offending file in the message.
- Evidence: every finding emits `properties.evidence` — the file + byte count, the bundle total, or the `memory file ↔ governance file` pair.

## Example

```
✗ Agent memory hygiene — 83/100 (advisory) [mechanical]
  WARNING Empty memory file: .claude/memory/empty.md
    .claude/memory/empty.md is empty. It teaches the agent nothing but is
    still loaded every session.
  INFO    Stub memory file: .claude/memory/stub.md
  INFO    Rule has two homes: .claude/memory/merge.md restates CLAUDE.md
    "Never merge a pull request yourself — emit the merge command for the
    operator." is stated in CLAUDE.md and again in .claude/memory/merge.md.
```

## Scope and limitations

- **Locations scanned:** `{cwd}/.claude/memory/*.md`, plus `{cwd}/MEMORY.md` and `{cwd}/.claude/MEMORY.md`. The whole memory directory counts toward the budget — harnesses differ on eager vs lazy topic loading, so the conservative assumption is that anything in it can be pulled in.
- **Home directory is opt-in.** `~/.claude/memory/`, `~/.claude/projects/*/memory/`, and (for `duplicate-rule` only) `~/.claude/CLAUDE.md` + `~/CLAUDE.md` are scanned only under `--include-home-skills` — the same gate `instruction-effectiveness` and `skill-files` use. An unasked-for home scan is a surprise, and home memory is not the project's to fix. Home governance is read as a *rule source* only: it can give a project memory file's rule a second home, but home files are never themselves reported.
- **Budget defaults to 40,000 bytes:** ~10k tokens at ~4 chars/token, about 5% of the 200k-token reference window `instruction-effectiveness` scores against. Memory is one slice of always-on context (governance + skills + memory), so it gets a minority share of it. A repo that blows this budget is paying for it on every single turn, not once. Override it with `memoryHygiene.budgetBytes` (see Configuration).
- **Stub detection strips YAML frontmatter and markdown headings**, then requires ≥20 non-whitespace body characters. A file whose entire content is a heading and a `status:` field is a stub by that rule.
- **Governance scanned for `duplicate-rule`:** the root set (`CLAUDE.md`, `AGENTS.md`, `.cursorrules`, …), **plus every governance file nested in the project tree** (a monorepo's `packages/<pkg>/CLAUDE.md` is governance for that package and is loaded with it), **plus `~/.claude/CLAUDE.md` and `~/CLAUDE.md` under `--include-home-skills`** — the same opt-in gate the memory scan uses. The nested walk is the shared `walkDirSafe` (symlink-loop and depth defended), capped at 100 governance files, and it **skips vendored and fixture trees** (`node_modules`, `dist`, `build`, `vendor`, `coverage`, `fixtures`, …): a dependency's or a test sample's `CLAUDE.md` is not this project's governance, and matching against one would be a false "two homes" on a rule the project never wrote. A rule's home can be any file the agent actually loads, so a home-only rule restated in project memory is a real second home — but only when you asked for the home scan.
- **`duplicate-rule` is a proxy, and it is tuned to miss.** A false "these are the same rule" costs an author real trust, so the bar is deliberately high: a rule matches only on **exact equality after normalization** (lowercase; list marker, markdown emphasis, backticks, and all punctuation stripped; whitespace collapsed), and only when it carries **≥40 normalized characters**. Headings, fenced code, table rows, and link-only lines never match. Comparison is per line **and per wrapped block**: consecutive continuation lines are re-joined into one rule before normalizing, so a rule hard-wrapped over two lines in one file matches the same rule written on one line in the other. A block ends at a blank line, heading, fence, table row, or the next list marker — **two separate bullets are never glued into one rule**, which is the false-positive that a naive line-join would invent. The honest costs of that bar:
  - **It misses far more than it catches.** A reworded rule, or a rule stated as a sentence in one file and a bullet fragment in the other, slips through. The check finds copy-paste, not semantic duplication.
  - **A short rule is invisible.** "Never merge PRs yourself." normalizes to 26 characters and cannot fire — accepted, because a 20-character floor would let ordinary boilerplate ("run the tests first") collide across unrelated files.
  - **Punctuation-blind normalization can flatten a real distinction.** Two lines differing only in punctuation ("do not run X" vs "do not run X?") normalize identically. Prose rules rarely turn on punctuation, so this is a live but rare false-positive path.
  - **Cross-file, at most 10 findings.** A memory file that mirrors a whole governance section reports its first ten duplicated lines; `data.duplicateRules` carries the true count.
- **Not `instruction-effectiveness/redundant-instruction`.** That check flags a line repeated across *instruction* files (governance ↔ governance, skill ↔ skill). This one fires only on the **governance ↔ memory** pair, where the failure mode is different: memory outranks nothing, but it is loaded first, so the stale copy is the one the model reads.

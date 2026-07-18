# `docs` — AGENTS.md-first governance baseline

| file | dest | what it does |
| --- | --- | --- |
| `AGENTS.md` | `AGENTS.md` | The vendor-neutral agent contract: scope, forbidden actions, approval gates, path/network/shell limits, untrusted-input rules, TDD, definition of done, git workflow. |
| `CLAUDE.md` | `CLAUDE.md` | A thin pointer that defers to `AGENTS.md`, so Claude Code and every other agent read one contract instead of two that drift. |

`AGENTS.md` is the primary file. Claude Code does not read `AGENTS.md` on its own, so the
`CLAUDE.md` pointer is what makes the contract actually load — that is the only reason it ships.

## Measured effect

Two fixtures, installed by hand, scanned before and after. **Bare repo** (`package.json` only):

| check | before | after |
| --- | --- | --- |
| `governance-docs` | N/A (no AI tooling detected) | 100 |
| **overall** | **12** | **50** |

**AI-tooled but ungoverned** (a `.claude/skills/` file, no governance file):

| check | before | after |
| --- | --- | --- |
| `governance-docs` | **0 — CRITICAL, `no-governance-file`** | **100** |
| `instruction-effectiveness` | 83 | 83 |
| `skill-files` | 100 | 100 |
| `coherence` | 100 | 100 |
| **overall** | **36** | **50** |

`pack.json.checks` claims `governance-docs` and nothing else.

## Why nothing else is claimed

**`instruction-effectiveness` — not claimed, and this is the interesting one.** On the bare
fixture it *looks* like a win (N/A → 100), but that is an artifact: the check scores the content of
instruction files, and the pack is what creates them. On the AI-tooled fixture, where the check is
genuinely red (83 — a dead file reference and a vague instruction in a pre-existing skill file), the
pack moves it **83 → 83**. It fixes nothing it did not itself author. It is also weight 0
(advisory), so it cannot move the overall score in either direction. Claiming it would be a false
statement in a machine-readable file.

**`skill-files`, `unicode-steganography`, `coherence` — not claimed.** They flip N/A → 100 on the
bare fixture only because `AGENTS.md` is in `GOVERNANCE_FILES` and so lands in their scan set. The
pack repairs no finding in any of them. `coherence` is the one that can actively go *down*: it
wants every configured MCP server named in a governance doc, which a template cannot know in
advance, so installing this pack into a repo with MCP servers can surface a true
`Undeclared MCP server` finding. That finding is correct and the templates deliberately do not
suppress it — a template that silenced a real finding would be gaming rigscore's own check.

**`documentation`, `workflow-maturity`, `permissions-hygiene` — untouched.** The pack ships no
check docs, no skills or pipelines, and changes no filesystem modes.

## The content is earned, not keyword-stuffed

`governance-docs` scores nine governance categories by regex, which makes it trivially gameable — and
rigscore's own docs name keyword-gaming as a known bypass. Every category here is carried by a rule
a human would want in the file anyway; delete the scoring and the document still stands up. Two
traps these templates are written around, both learned the hard way:

- **Do not quote the attack.** The injection checks are presence-based and cannot tell an example
  from an exploit. Five of rigscore's own `docs/examples/` configs scored 6/100 with CRITICALs
  because they quoted a literal override string inside their own anti-injection rule. `AGENTS.md`
  states the rule and tells the agent to report where a payload lives without reproducing it.
- **Do not write a prohibition as a directive.** A backticked destructive command after the word
  "run" trips the shell-exec patterns even inside a ban. The shell rule names what Bash is *for*.

Verified: installed into both fixtures, the templates add zero findings to `skill-files`,
`unicode-steganography`, or `instruction-effectiveness`.

## Deferred

No `.github/copilot-instructions.md` or `.cursorrules`. A second copy of the same prose would trip
`instruction-effectiveness`'s cross-file redundancy detector — the right shape is a pointer per
vendor, and only Claude's is proven here. `{{PROJECT_NAME}}` is the only variable, because the
installer substitutes only that one.

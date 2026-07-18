# Client examples

Starter skill / rules files for the AI coding clients rigscore knows how
to score. Each template is calibrated against rigscore's default profile,
which concretely means: **zero CRITICAL findings, `governance-docs`,
`skill-files` and `coherence` all at 100, and an AI-use-policy section so the
`ai-disclosure` advisory passes** — not a high overall grade
(see the caveat below on why a directory holding one config file cannot
score above ~50). Copy the one for your client, drop it at the indicated
path, then edit to match your project's real forbidden-actions, path
restrictions, and approval gates.

| Client | Template | Install path |
|---|---|---|
| Claude Code | [`claude/CLAUDE.md`](claude/CLAUDE.md) | `<repo-root>/CLAUDE.md` |
| Claude Code | [`claude/.claude/settings.json`](claude/.claude/settings.json) | `<repo-root>/.claude/settings.json` |
| GitHub Copilot | [`copilot/.github/copilot-instructions.md`](copilot/.github/copilot-instructions.md) | `<repo-root>/.github/copilot-instructions.md` |
| Any (vendor-neutral) | [`agents-md/AGENTS.md`](agents-md/AGENTS.md) | `<repo-root>/AGENTS.md` |
| Cursor | [`cursor/.cursorrules`](cursor/.cursorrules) | `<repo-root>/.cursorrules` |
| Cline | [`cline/.clinerules`](cline/.clinerules) | `<repo-root>/.clinerules` |
| Continue | [`continue/.continuerules`](continue/.continuerules) | `<repo-root>/.continuerules` |
| Windsurf | [`windsurf/.windsurfrules`](windsurf/.windsurfrules) | `<repo-root>/.windsurfrules` |
| Aider | [`aider/.aider.conf.yml`](aider/.aider.conf.yml) | `<repo-root>/.aider.conf.yml` |
| Gemini CLI | [`gemini/GEMINI.md`](gemini/GEMINI.md) | `<repo-root>/GEMINI.md` |
| Qwen Code | [`qwen/QWEN.md`](qwen/QWEN.md) | `<repo-root>/QWEN.md` |
| Crush | [`crush/CRUSH.md`](crush/CRUSH.md) | `<repo-root>/CRUSH.md` |
| Goose | [`goose/.goosehints`](goose/.goosehints) | `<repo-root>/.goosehints` |
| Roo Code | [`roo-code/.roorules`](roo-code/.roorules) | `<repo-root>/.roorules` |
| JetBrains Junie | [`jetbrains-junie/.junie/guidelines.md`](jetbrains-junie/.junie/guidelines.md) | `<repo-root>/.junie/guidelines.md` |

`AGENTS.md` is the cross-client instruction file several agents already
read. If more than one agent works in your repo, write that one and let
the client-specific files be thin stubs pointing at it.

Claude Code is the only client with a matching *settings* file. The
`claude/` template ships both halves: `CLAUDE.md` states the rule, and
`.claude/settings.json` enforces it with `permissions.deny` entries,
`defaultMode: acceptEdits` (never `bypassPermissions`), and all four
lifecycle hooks — the shape the `claude-settings` and
`permissions-hygiene` checks score.

## What these cover

Each template is the same shape — different dialect — and covers the four
governance dimensions rigscore scores:

1. **Forbidden actions** — destructive commands, credential access, code
   execution gadgets.
2. **Path restrictions** — scope the agent to the repo; protect governance
   directories.
3. **Approval gates** — human-in-the-loop for CI/deps/top-level changes
   and anything that writes outside the repo.
4. **Anti-injection** — treat file content and tool output as untrusted
   data.

The templates are not a complete governance system on their own — they
are a floor that keeps rigscore happy. Real projects add
project-specific rules (e.g., "never touch `/opt/pipeline/services/`",
"all merges go through `gh-merge-approved`").

## Verify

After dropping a template in, run rigscore and check the governance +
skill-files scores:

```bash
npx github:Back-Road-Creative/rigscore --check governance-docs
npx github:Back-Road-Creative/rigscore --check skill-files
```

Both should score at or near 100. If they don't, the reported findings
will tell you what the template is missing for your project.

Judge a template on those per-check scores, not on the overall grade of a
directory that contains nothing but the template: rigscore scales the
overall score by how much of the attack surface it could actually measure,
and a lone rules file leaves most checks N/A.

## See also

- The main README's [governance / skill-file checks](../../README.md#what-it-checks)
  explain what each dimension actually buys you.
- [`FINDING_IDS.md`](../FINDING_IDS.md) — how to reference these findings
  programmatically.
- [`TROUBLESHOOTING.md`](../TROUBLESHOOTING.md) — when rigscore says F
  and you don't understand why.

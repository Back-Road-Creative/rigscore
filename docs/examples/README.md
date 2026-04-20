# Client examples

Starter skill / rules files for the AI coding clients rigscore knows how
to score. These templates are calibrated to pass rigscore's default
profile (`skill-files`, `claude-md` / governance coverage, coherence
signals) without needing further tuning. Copy the one for your client,
drop it at the indicated path, then edit to match your project's real
forbidden-actions, path restrictions, and approval gates.

| Client | Template | Install path |
|---|---|---|
| Cursor | [`cursor/.cursorrules`](cursor/.cursorrules) | `<repo-root>/.cursorrules` |
| Cline | [`cline/.clinerules`](cline/.clinerules) | `<repo-root>/.clinerules` |
| Continue | [`continue/.continuerules`](continue/.continuerules) | `<repo-root>/.continuerules` |
| Windsurf | [`windsurf/.windsurfrules`](windsurf/.windsurfrules) | `<repo-root>/.windsurfrules` |
| Aider | [`aider/.aider.conf.yml`](aider/.aider.conf.yml) | `<repo-root>/.aider.conf.yml` |

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
npx github:Back-Road-Creative/rigscore --check claude-md
npx github:Back-Road-Creative/rigscore --check skill-files
```

Both should score at or near 100. If they don't, the reported findings
will tell you what the template is missing for your project.

## See also

- The main README's [governance / skill-file checks](../../README.md#what-it-checks)
  explain what each dimension actually buys you.
- [`FINDING_IDS.md`](../FINDING_IDS.md) — how to reference these findings
  programmatically.
- [`TROUBLESHOOTING.md`](../TROUBLESHOOTING.md) — when rigscore says F
  and you don't understand why.

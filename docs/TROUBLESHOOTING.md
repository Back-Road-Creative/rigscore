# Troubleshooting / FAQ

Common issues, in rough order of "new-user complaints."

## "rigscore gives my project F — why?"

Most common reason: your project doesn't exercise the full check surface.
rigscore scales the overall score by **applicable coverage** — if fewer
than 50 points of check weight apply (no MCP config, no Dockerfile, no
skill files, no `.claude/settings.json`, etc.), the score is scaled down
proportionally.

This is intentional: a project where only a handful of checks can reach a
verdict should not be able to claim a perfect 100.

rigscore does this to itself — the self-score is 35/100 F. See the
[Dogfooding](../README.md#dogfooding) section for the calibration and the
["Coverage scaling"](../README.md#scoring) note for the math. A lower
fail-under than the public default is normal for projects that don't
exercise the full check surface.

Quick diagnostic:

```bash
npx github:Back-Road-Creative/rigscore --json | \
  jq '.results[] | {id, score, findings: (.findings | length)}'
```

If half your checks show `score: -1` (N/A), you're in coverage-scaling
territory, not a security-hygiene problem per se.

## "My score changed after upgrading"

Expected — check the `CHANGELOG.md` for the version you upgraded to. New
checks or weight recalibrations can shift the score.

The specific cases that move scores:

- **New checks added.** Adding a new scored check changes the denominator
  and can shift existing scores; advisory (weight-0) additions do not.
- **Weight changes.** Documented in `CHANGELOG.md`.
- **Coverage scaling recalibration.** Changes to `COVERAGE_PENALTY_THRESHOLD`
  or the coverage math in `src/scoring.js` are called out explicitly in
  the changelog. These ship with characterization tests
  (`test/scoring-coverage.test.js`) that pin exact behavior — your score
  moves because a documented recalibration moved it, not because of
  hidden drift.

If the score moved and `CHANGELOG.md` doesn't explain it, open an issue.

## "rigscore hangs"

A few known causes:

- **Very large directories.** Recursive / deep mode on a repo with
  hundreds of projects or a huge `node_modules` can take minutes.
  `--deep` in particular is a recursive source scan. Try scoping with
  `--check <id>` first or running against a subdirectory.
- **Network probes with `--online`.** `site-security` and MCP registry
  refresh make outbound HTTP calls. A slow network or unreachable host
  can block for the duration of each call.
- **Watch mode.** `--watch` is long-running by design. It debounces file
  changes at 500ms and re-scans. `Ctrl-C` to exit.

If a specific check hangs, isolate it:

```bash
npx github:Back-Road-Creative/rigscore --check docker-security
```

There is no request-timeout or walk-depth config key today. If you need
one, open an issue — it's a known gap.

## "`npm ci` fails with engine mismatch"

rigscore requires **Node `>=18`** (`package.json` `engines`). Node 16 and
earlier are not supported. Pin your CI to Node 18 or 20.

```yaml
# GitHub Actions
- uses: actions/setup-node@v4
  with:
    node-version: '20'
```

## "`npx github:Back-Road-Creative/rigscore@v1.0.0` 404s"

The `@v<tag>` suffix requires the tag actually be pushed to the GitHub
remote. If a release is announced in `CHANGELOG.md` but the tag hasn't
been cut yet, the `@tag` form 404s.

Workarounds, in order of preference:

1. Pin to a commit SHA: `npx github:Back-Road-Creative/rigscore#<sha>`.
2. Use `@main` at your own risk (rolling latest):
   `npx github:Back-Road-Creative/rigscore#main`.
3. Pull the Docker image if one is published for that version:
   `ghcr.io/back-road-creative/rigscore:<tag>`.

rigscore is not published to npm by design — see the
[Distribution](../README.md#distribution) section for the rationale.

## "ANSI escape warnings in my skill files"

rigscore flags skill files that contain terminal-control sequences
(Unicode bidi overrides, zero-width joiners, homoglyphs from Greek /
Cyrillic / Armenian / Georgian / Cherokee). This is intentional — these
are known prompt-injection vectors from the ToxicSkills and Rules File
Backdoor classes. If the finding is a false positive because a legitimate
multilingual template is involved, suppress it precisely:

```bash
npx github:Back-Road-Creative/rigscore \
  --ignore skill-files/injection,skill-files/shell-exec
```

Or at the config level in `.rigscorerc.json`:

```json
{
  "suppress": ["skill-files/injection"]
}
```

See [`FINDING_IDS.md`](FINDING_IDS.md) for the full list of stable IDs.

## "How do I re-pin the pre-commit hook after upgrading"

Just re-run `--init-hook`:

```bash
npx github:Back-Road-Creative/rigscore --init-hook
```

If the existing hook file already contains the string `rigscore`, the
installer skips — it won't stamp twice. To force a fresh install, delete
the rigscore line from `.git/hooks/pre-commit` and re-run. The installed
line is:

```sh
npx github:Back-Road-Creative/rigscore --fail-under 70 --no-cta || exit 1
```

## "On WSL2, permissions-hygiene is flagging Windows files"

NTFS-mounted paths (`/mnt/c/...`) don't have real POSIX permission bits —
they translate through a WSL metadata layer. `permissions-hygiene` may
see sensitive files as world-readable when they aren't.

Workaround: move the project into the WSL filesystem (`~/projects/...`)
and scan there. If you must scan `/mnt/`, suppress the specific finding:

```bash
--ignore permissions-hygiene/sensitive-file-world-readable
```

See the [Platform notes](../README.md#platform-notes) section for the
full WSL2 guidance.

## "A finding disappeared after I renamed a file"

rigscore doesn't persist findings across scans (except the `.rigscore-state.json`
MCP shape hash — see the [State file](../README.md#state-file)). A
finding disappearing means the scanner didn't trip on that file this run.
If you expected it to trip, try running that check in isolation with
`--verbose` and check that the file is in scope.

## "The CI baseline diff is flagging findings I already suppressed"

Baseline mode (`--baseline <path>`) stores the current finding set and
compares subsequent scans against it. Suppressions via `--ignore` / the
`suppress:` config still filter findings *before* the baseline compare,
but the baseline file itself is a snapshot — if you added a suppression
after the baseline was written, the suppressed finding is no longer in
the baseline but also no longer in the current run, so it won't appear as
"new." If it does, regenerate the baseline:

```bash
rm <baseline-path>
npx github:Back-Road-Creative/rigscore --baseline <baseline-path>  # writes fresh
```

## See also

- [`FINDING_IDS.md`](FINDING_IDS.md) — stable IDs for `--ignore` / `suppress:`
- [`examples/`](examples/) — starter rules templates for Cursor / Cline /
  Continue / Windsurf / Aider
- Main [`README.md`](../README.md) — check list and scoring details
- `CHANGELOG.md` — score-affecting changes by version

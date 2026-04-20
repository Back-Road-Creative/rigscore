# Release notes — v1.0.0 (draft, not published)

> Draft notes for the upcoming `v1.0.0` release. **Not a GitHub release yet.**
> The user tags and publishes manually; see "User-required manual steps"
> at the bottom.

## Headline

First tagged `1.x` release. Nothing new is scored; this is a packaging,
CI-matrix, and distribution milestone that stabilises the API, documents
every check, and draws a clean line in the CHANGELOG.

## Session-scope PRs (Moat & Ship)

Queried via `gh pr list --state merged --search "merged:>=2026-04-20"` and
the in-flight agent PRs described below. Workstream breakdown:

### Pre-session hardening (already merged)

- #84 — `skill-files`: reduce false positives in defensive pattern detection.
- #85 — `scanner`: preserve per-file findings across dedup.
- #86 — `instruction-effectiveness`: tighten `looksLikeFilePath` heuristic.

### Agent A — check quality (PR pending; check the A worktree)

- SARIF per-finding `ruleIds` and fix-matcher `findingId` switch (backlog 3.2
  and 3.3 folded in).
- `instruction-effectiveness` dead-ref classification and `skill-files`
  skill-directory + pattern-id allowlist for legitimate operator usage.
- Evidence snippet on every finding.
- Target: `/home/joe` dead-ref count under 50.

### Agent B — config + scoring (PR pending; check the B worktree)

- `--profile home|monorepo` added alongside existing `default|minimal|ci`.
- `--baseline <sha|file>` for new-findings-only CI gating.
- `suppress` glob + regex support; `~/.rigscorerc.json` merging.
- `rigscore init` (base), `rigscore explain <id>`, `rigscore diff`.
- CI self-scan threshold owned here (Agent C set it to 30 to match
  dev-local baseline; Agent B's final value wins on rebase).

### Agent C — ship (this PR)

- `CHANGELOG.md` covering v0.1.0 through v0.9.0 + `[Unreleased]`.
- CI matrix expanded to `ubuntu-latest` + `macos-latest`, Node 18/20.
- `rigscore init --example` scaffolder for demo projects.
- `Dockerfile` + `.github/workflows/docker-publish.yml` drafts (image
  publish gated on `workflow_dispatch`; no auto-publish on tags yet).
- README + CHANGELOG section explaining why npm publish stays off.

### Agent D — fixture-based dogfood (PR pending; check the D worktree)

- `test/fixtures/scored-project/` reference fixture used by integration
  tests and (eventually) by `rigscore init --example`.

## Deferred to v1.1.0

The following are intentionally **not** shipped in v1.0.0 — they need a
human to pull the trigger:

- **Docker image publish to GHCR.** The workflow is in place but gated on
  `workflow_dispatch` only. Flip to `push: tags: ['v*.*.*']` when ready.
- **GitHub Action Marketplace listing.** `action.yml` is ready; the listing
  itself is a manual GitHub UI action tied to a tagged release.
- **npm publish.** Deliberately off; see `CLAUDE.md` and the README
  "Distribution" section. Revisit in v1.1.0 only if there is a concrete
  reason.

## User-required manual steps to ship v1.0.0

The agents cannot perform these — they're hard-to-reverse:

1. Merge Agents A, B, C, D PRs to `main` in whatever order keeps CI green
   (C is mostly orthogonal; A before B before E for scoring reasons).
2. Bump `package.json` version to `1.0.0` and land that commit on `main`.
3. Push the tag: `git tag v1.0.0 && git push origin v1.0.0`.
4. Create the GitHub Release from the pushed tag, pasting the `[1.0.0]`
   section of `CHANGELOG.md` as the body.
5. (v1.1.0, deferred) Flip the trigger in
   `.github/workflows/docker-publish.yml`, re-run, and submit the
   Marketplace listing.

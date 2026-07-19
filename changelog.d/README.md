# changelog.d — one file per change

**Do not edit `CHANGELOG.md` in a pull request.** Add a fragment here instead:

```
changelog.d/<id>.<type>.md      e.g. changelog.d/282.fixed.md
```

- `<id>` — the PR (or issue) number.
- `<type>` — one of `added`, `changed`, `deprecated`, `removed`, `fixed`,
  `security`, `docs`. An unknown type fails the test suite rather than silently
  vanishing at release.
- The body is the markdown list item(s) exactly as they should appear under
  `### <Type>`, starting with `- `.

Why: every PR used to append to the same `### Fixed` list, so any two PRs open at
once collided on the same lines. One file per change means two PRs never touch
the same line, so the conflict cannot happen — locally or on GitHub.

Preview what the next release will say:

```bash
npm run changelog
```

Maintainers, at release time — folds every fragment into `CHANGELOG.md`, opens a
fresh `## [Unreleased]`, and deletes the fragments:

```bash
node scripts/assemble-changelog.js --release 2.1.0
```

The published GitHub release notes are sourced from this folded `## [<version>]`
section (`release.yml` reads it via `assemble-changelog --notes <version>`), so
the maintainer must run `--release <version>` in the version-bump PR **before**
tagging; the workflow falls back to the raw git log only when the section is absent.

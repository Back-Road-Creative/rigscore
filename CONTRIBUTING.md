# Contributing to rigscore

Thanks for your interest in improving rigscore. This guide covers how to propose
changes and get them merged.

## Reporting

- **Bugs / features:** open an issue using the templates under
  [`.github/ISSUE_TEMPLATE/`](.github/ISSUE_TEMPLATE/).
- **Security vulnerabilities:** do **not** open a public issue — follow the
  private disclosure process in [`SECURITY.md`](SECURITY.md).

## Development setup

rigscore is a Node CLI. Requirements: Node **>= 18.17** (the CI floor).

```bash
git clone https://github.com/Back-Road-Creative/rigscore.git
cd rigscore
npm ci        # installs deps and wires the git pre-commit hook via husky
```

Run the CLI from source: `node bin/rigscore.js --help`.

## The gates (run before you push)

CI runs these on every push and PR — run them locally first:

```bash
npm test            # vitest suite
npm run verify:docs # every check must have a docs/checks/<id>.md page
npm run test:fixture # dogfood self-scan stays stable
```

- **Add or change a check?** Add or update its `docs/checks/<id>.md` in the *same*
  change — `verify:docs` blocks a check without a doc page. Docs and code never
  land separately.
- **Tests first.** For a behavior change, add or extend a test that fails before
  your change and passes after. Never weaken or delete a test to make the suite
  pass.

## Changelog

**Do not edit `CHANGELOG.md` directly.** Add a one-file-per-change fragment under
[`changelog.d/`](changelog.d/README.md):

```
changelog.d/<PR-number>.<type>.md      # type ∈ added|changed|deprecated|removed|fixed|security|docs
```

The body is the markdown list item(s) exactly as they should appear under the
`### <Type>` heading, starting with `- `. Preview with `npm run changelog`. This
one-file-per-change layout is why two open PRs never collide on the same lines.

## Commits & pull requests

- **Conventional commits** (`feat:`, `fix:`, `docs:`, `chore:`, `test:`, …).
- Keep a PR to one logical change; include a short summary and the gate output
  in the description.
- **Pin GitHub Actions to a commit SHA**, never a moving tag — rigscore
  SHA-pins every action, and its own `ci-agent-caps` check flags unpinned ones.

## Conduct

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

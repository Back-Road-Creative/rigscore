# scored-project fixture

Realistic-but-problematic AI dev project used as rigscore's dogfood fixture.

## Why

Scanning rigscore against itself hits ~half of the 19 checks as N/A (no
`.mcp.json`, no `.env`, no skills, no Dockerfile, etc.). That leaves the
other half of the check surface unexercised by CI. This fixture provides a
committed directory that intentionally fires findings across most checks so
behavioral regressions surface as test failures.

The assertion suite lives at `test/fixture-dogfood.test.js` and imports the
scanner directly from `src/index.js` — no CLI shell-out. See
`EXPECTED-FINDINGS.md` for the intended finding list.

## Shape

- `.cursorrules` — governance file (mostly OK, missing three categories,
  contains a Cyrillic homoglyph, two dead file references).
- `.claude/skills/` — three skill dirs:
  - `operator-sudo/` — legitimate operator skill with `sudo` commands
    (expected privilege-escalation + shell-execution WARNINGs; post-Agent-A
    the sudo allowlist change may re-classify the sudo one).
  - `destructive-unguarded/` — unguarded `curl | bash` + exfiltration pattern.
  - `clean-skill/` — baseline-clean.
- `.mcp.json` — three servers: one pinned, one typosquat+unpinned+`@latest`,
  one with 4 sensitive env vars.
- `.env` + `.env.example` — `.env` intentionally NOT in `.gitignore`;
  placeholder uses an `AKIA[A-Z]{16}`-shape-only string (`AKIAXXXX…`) so
  rigscore's prefix-based detectors still fire while gitleaks / TruffleHog /
  GitHub push-time secret scanning do not.
- `docker-compose.yml` — two services with missing `cap_drop`, no `user`,
  no memory limit, no loopback bind.
- `package.json`, `requirements.txt` — enough markers to make the directory
  look like a real project to `site-security` and `credential-storage`.
- `scripts/mcp-helper.js` — includes a Cyrillic-`а` homoglyph in a banner
  string.
- `hooks/pre-commit.sh` — `curl | bash` pattern outside `.git/hooks` (the
  fixture is deliberately not a git repo, so the git-hooks check returns
  N/A; the file is still scanned by deep-secrets and site-security).

## How to regenerate the expected counts

```bash
UPDATE_FIXTURES=1 npm run test:fixture
```

Re-runs the scanner and updates the locked count/score range in place. Use
only when an intentional change to a check's behavior justifies a new
baseline — and land the fixture update in the same PR as the check change.

## Adding new-check coverage

When a new rigscore check ships, mirror it here:

1. Add whatever input file(s) the check expects (e.g., a `.windsurfrules`
   or `.continuerules` variant, a new config shape, etc.).
2. Document the intended finding bullet in `EXPECTED-FINDINGS.md`.
3. Run `UPDATE_FIXTURES=1 npm run test:fixture` to regenerate the committed
   count/score, then verify the diff reflects only the new check.

## Fake secrets — hard rule

Every placeholder in this fixture is an obvious stub. Never substitute
real-looking values; rigscore's secret patterns treat `AKIA[0-9A-Z]{16}`
matches as real keys unless the surrounding line contains `example|
placeholder|demo|sample|template|your_?key|xxx|changeme|replace_?me`.
The current placeholder `AKIAXXXXXXXXXXXXXXXX` matches the shape regex
(so the detector still fires in tests) but contains `xxx`, satisfying the
exception. It deliberately avoids AWS's documented canonical example
string because gitleaks, TruffleHog, and GitHub push-time secret
scanning hard-code that exact literal as a known fingerprint and would
block downstream consumers that scan tracked source.

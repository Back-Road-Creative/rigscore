## Summary

Five production-readiness gaps from the 2026-05-27 health report, consolidated into one CI/Docker polish PR. Companion to #123 (which added the `@vitest/coverage-v8` peer dep so this PR could stay under the 300-sum cap).

1. **Dockerfile multi-arch digest pin.** `FROM node:20-alpine` was tag-pinned only — a future image rebuild could pick up a different base image with no code change. Pinned to the manifest-list digest `sha256:fb4cd12c…` resolved against Docker Hub on 2026-05-27. Includes an inline refresh-procedure comment with the exact `curl | python3` one-liner. (Production #4)
2. **Coverage gate.** `vitest.config.js` now declares `coverage.provider: 'v8'` with `lines: 40` threshold (matches the historical baseline noted in CLAUDE.md). `ci.yml` test step switched to `npm test -- --coverage`. Local run reports 84.05% lines — well clear of the gate. (Production #5)
3. **release.yml docs-first gate.** Added `npm run verify:docs` between `npm test` and the release step, mirroring `ci.yml`. Without this, a release could ship a check whose `docs/checks/<id>.md` is missing or stale, and `rigscore explain` would break against the just-released artifact. (Production #6)
4. **headlessmode job split + least-privilege.** Moved the cross-repo headlessmode post into its own `headlessmode-post` job: declares `permissions: { contents: read }` (nothing in this job writes to rigscore), explicit `if: needs.release.outputs.released == 'true'` guard, explicit PAT-presence guard so forks without `HEADLESSMODE_PAT` skip cleanly instead of failing on `git clone`, version + changelog passed through job outputs. (Production #7)
5. **vitest testTimeout doc.** Added a comment to `vitest.config.js` explaining the 10s testTimeout rationale (long-pole is spawn-based CLI tests; macOS CI cold-start can take 2-3s) and a per-test override example. (Production #8)

## Test plan

- [x] `npm test -- --coverage` locally — `Test Files 85 passed, Tests 1049 passed | 2 skipped`, **All files lines = 84.05%** (gate is 40%), exit code 0
- [x] `release.yml` validated via `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml'))"` (no syntax errors); job graph: `release` → `headlessmode-post (needs: release, if: released=='true')`
- [x] Dockerfile digest resolved live from `https://hub.docker.com/v2/repositories/library/node/tags/20-alpine` — `sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293`
- [x] Diff: 79 insertions, 6 deletions (85 sum, under cap)

# Profile: `ci`

For CI pipelines. **Identical to `default` today** — the weight map is a copy
of `default`'s. It exists as a stable, separately-named target so a future
release can tune CI-specific weights (e.g. de-emphasising checks that a
sandboxed runner cannot reach) without changing what a local `default` scan
reports.

## Weights

Identical to [`default`](./default.md) — see that page for the full table.

## When to use

- CI jobs that want a name expressing intent (`--profile ci`) and forward
  compatibility if the CI weights ever diverge from `default`.
- Pair with `--ci` (which sets `--sarif --no-color --no-cta`) and a
  `--fail-under` threshold calibrated to your project shape.

## Usage

```bash
rigscore --profile ci --ci --fail-under 70 .
```

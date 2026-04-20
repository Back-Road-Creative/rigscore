# Profile: `monorepo`

For multi-project repositories. Uses the same scoring weights as `default`,
but sets sensible defaults for recursive traversal:

- `recursive: true`
- `depth: 3`

When the CLI is invoked with `--profile monorepo`, it enables recursive
mode at depth 3 unless the user passes `--recursive` or `--depth`
explicitly (CLI flags still win).

## Weights

Identical to `default` — see [README.md#scoring](../../README.md).

## Usage

```bash
rigscore --profile monorepo /path/to/monorepo
# equivalent to: rigscore -r --depth 3 /path/to/monorepo
```

Or via `.rigscorerc.json` at the monorepo root:

```json
{ "profile": "monorepo" }
```

## When NOT to use

For a single-project repo, `default` is correct. The `monorepo` profile's
recursive hints add overhead and can surface noisy per-subproject scores
when only one project exists.

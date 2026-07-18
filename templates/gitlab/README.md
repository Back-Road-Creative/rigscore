# rigscore GitLab CI/CD component

`rigscore.gitlab-ci.yml` is a ready-to-include GitLab CI/CD component — the
parameterized, reusable version of the `.gitlab-ci.yml` recipe in the main
README. It runs a rigscore scan whose exit code gates the pipeline and keeps the
SARIF stream as an artifact.

## Include it

Straight from GitHub (no GitLab mirror required):

```yaml
include:
  - remote: 'https://raw.githubusercontent.com/Back-Road-Creative/rigscore/v2.1.0/templates/gitlab/rigscore.gitlab-ci.yml'
```

Or, if you mirror rigscore into a GitLab instance and publish it to that
instance's CI/CD Catalog, use the component form:

```yaml
include:
  - component: $CI_SERVER_FQDN/<your-namespace>/rigscore/rigscore@v2.1.0
    inputs:
      fail-under: '80'
      profile: ci
```

## Inputs

| Input        | Default    | Purpose                                                             |
| ------------ | ---------- | ------------------------------------------------------------------- |
| `stage`      | `test`     | Pipeline stage the job runs in.                                     |
| `fail-under` | `70`       | Minimum score; the job (and pipeline) fails below it.               |
| `profile`    | `default`  | Scoring profile (`default`, `minimal`, `ci`, `home`, `monorepo`).   |
| `image`      | `node:20`  | Container image. Use `ghcr.io/back-road-creative/rigscore:<tag>` to skip the `npx` fetch. |
| `ref`        | `v2.1.0`   | rigscore tag to run (pinned for supply-chain stability).            |

## SARIF

rigscore emits SARIF v2.1.0 to `rigscore.sarif`, kept as a job artifact
(`when: always`, so a failing scan is still downloadable). SARIF is consumed
natively by GitHub Advanced Security; GitLab's own Security Dashboard expects its
`gl-sast-report.json` schema rather than SARIF, so the file is published as a
plain artifact — download it, or convert it, rather than wiring it to
`artifacts:reports:sast` (which would silently not populate the dashboard).

The same one-line CLI invocation works on any CI platform — see the
"GitLab CI" and "SARIF" sections of the main README for the raw recipe.

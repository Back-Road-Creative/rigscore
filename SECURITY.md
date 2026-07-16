# Security Policy

## Supported versions

rigscore is distributed from this repository (`npx github:Back-Road-Creative/rigscore`).
Only the latest released tag receives security fixes. Pin a released `v*` tag; `main`
is unstable and unsupported for production gating.

## Reporting a vulnerability

Please report suspected vulnerabilities privately. Do **not** open a public issue for
a security report.

- Preferred: open a private advisory via GitHub's **Security → Report a vulnerability**
  tab on this repository (Private Vulnerability Reporting).

Please include:

- affected version / commit,
- a description of the issue and its impact,
- reproduction steps or a proof of concept,
- any suggested remediation.

## What to expect

- Acknowledgement within 5 business days.
- An initial assessment and severity triage within 10 business days.
- Coordinated disclosure: we will agree on a disclosure timeline with you before any
  public write-up, and credit reporters who want it.

## Scope

In scope: the scanner code under `src/`, `bin/`, and `scripts/`; the release/supply-chain
workflows under `.github/workflows/`; and the published action (`action.yml`).

Out of scope: findings produced *about a scanned project* (rigscore reports on your
config; it is not itself the vulnerable surface there), and issues in third-party tools
rigscore points at. See [`THREAT-MODEL.md`](THREAT-MODEL.md) for what rigscore does and
does not inspect.

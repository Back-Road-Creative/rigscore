# site-security

**Enforcement grade:** `mechanical` — issues HTTPS probes and compares response headers, TLS cert fields, and structured path-status codes against known-good invariants. Deterministic for a given remote response.

## Purpose

Probes deployed web endpoints listed in `.rigscorerc.json` under `sites: [...]` for four classes of exposure: missing or weak HTTP security headers (CSP, HSTS, X-Frame-Options, X-Content-Type-Options, plus advisory Referrer-Policy and Permissions-Policy), sensitive paths reachable with HTTP 200 (`.env`, `.git/config`, `wp-admin/`, backup archives, admin panels — 30+ paths), PII and secret patterns leaking into HTML or JS served to browsers (emails outside an allowlist, phone numbers, API key patterns, internal IPs, `<meta name="generator">` fingerprints), and SSL certificate expiry via a direct TLS probe. Unlike every other rigscore check, this one is out-of-process: it requires `--online` and makes outbound HTTPS/TCP calls to the configured URLs. No OWASP Agentic Top 10 mapping — the threats here are classic web hygiene (OWASP Top 10 2021 A05/A01), not agentic-specific.

## Triggers

| Condition | Severity | SARIF ruleId | Remediation summary |
|---|---|---|---|
| `--online` flag not set | SKIPPED | — | Re-run with `--online`. |
| No sites configured | INFO (N/A) | `site-security/no-sites-configured` | Add a `sites: ["https://example.com"]` array to `.rigscorerc.json`. |
| A `sites` entry `new URL()` cannot parse (that entry is skipped, the rest still run) | INFO | `site-security/invalid-url` | Fix the entry in `.rigscorerc.json`. |
| A `sites` entry whose scheme is not `http:` / `https:` (e.g. `file:`, `ftp:`) — skipped before any probe | INFO | `site-security/unsupported-scheme` | Point the entry at an `http(s)` URL. |
| Missing CSP / HSTS / X-Frame-Options / X-Content-Type-Options | CRITICAL | `site-security/missing-security-header` | Add header at server/CDN. |
| Present critical header | PASS | — | — |
| Missing Referrer-Policy or Permissions-Policy | WARNING | `site-security/missing-advisory-header` | Add advisory header. |
| Unreachable URL during header probe | WARNING | `site-security/cannot-reach` | Verify site is up and resolvable. |
| `X-Powered-By` disclosed | WARNING | `site-security/x-powered-by-disclosed` | Suppress `X-Powered-By`. |
| `Server` header contains any digit (read as a version) | WARNING | `site-security/server-header-version` | Strip version from `Server`. |
| Exposed sensitive path returns HTTP 200 (allowlist: `robots.txt`, `sitemap.xml`, `.well-known/security.txt`) | CRITICAL | `site-security/exposed-path-accessible` | Block path via server/CDN rules. |
| No sensitive paths exposed | PASS | — | — |
| Emails (non-allowlisted) found in HTML | CRITICAL | `site-security/pii-email-leak` | Remove PII from public pages. |
| Phone numbers (US format) found in HTML | WARNING | `site-security/pii-phone-leak` | Review for unintended PII exposure. |
| Secret-key pattern found in page source | CRITICAL | `site-security/secret-in-page-source` | Rotate the key, remove from client bundle, move to server env. |
| Internal IP address (RFC1918) in HTML | WARNING | `site-security/internal-ip-disclosed` | Strip internal IPs from public output. |
| `<meta name="generator">` discloses build tool | WARNING | `site-security/generator-tag-disclosed` | Remove the generator tag. |
| SSL cert expired | CRITICAL | `site-security/ssl-certificate-expired` | Renew the certificate. |
| SSL cert expires in <30 days | WARNING | `site-security/ssl-certificate-expiring-soon` | Renew before expiry. |
| SSL cert valid ≥30 days | PASS | — | — |
| Cannot reach `<host>:443` for cert probe | WARNING | `site-security/ssl-check-failed` | Check DNS/firewall for the host. |

Analytics-style IDs matching `^G-…`, `^UA-…-…`, `^GTM-…`, `^ca-pub-…`, `^AW-…` are explicitly allowlisted from the secret-pattern trigger. Email allowlist covers `example.com`, `schema.org`, `w3.org`, `sitemaps.org`, `xmlns.com`, `purl.org`, `ogp.me`, `rdfs.org`.

## Weight rationale

Advisory — weight 0. Two reasons: (1) **scope** — this check targets deployed websites, which is orthogonal to rigscore's moat of local AI-dev governance; a repo with no web surface should not be penalized for having no `sites` configured, and projects that deploy to multiple domains shouldn't have their score dominated by a 30-path web sweep. (2) **dependency on `--online`** — the default rigscore run is offline-only, so scoring a check that silently returns N/A in the default mode would mean most CI runs under-score relative to occasional online runs, making the score non-comparable across runs. Keeping it advisory lets teams add `sites: [...]` and `--online` when they want the signal, without mutating the comparable score.

## Fix semantics

No `fixes` export. `--fix --yes` is a no-op.

- Remediations are all server-side (CDN rules, response headers, cert renewal, content edits in a CMS) and live outside the scanned repo. Even a site fully managed in-repo via a static generator would need a build+deploy step before a fix could be verified — outside the scope of a local scanner.

## SARIF

- Tool component: `rigscore`; rule IDs are the per-finding `site-security/*` ids in the Triggers table, with `site-security` as the check-level fallback rule.
- Level mapping: CRITICAL → `error`, WARNING → `warning`, INFO → `note`, PASS/SKIPPED → `none`.
- Location data: no file path — findings reference URLs, not repo artifacts. The scanned URL is in the message text.

## Example

```
ⓘ site-security — advisory (2 sites scanned)
  CRITICAL Missing security header: content-security-policy
    https://example.com does not set content-security-policy
    Fix: add Content-Security-Policy to server/CDN response headers.
  CRITICAL Exposed path accessible: /.env
    https://example.com/.env returned HTTP 200
  WARNING SSL certificate expires in 12 day(s)
    Expires: 2026-05-01T00:00:00.000Z
```

## Scope and limitations

- Requires `--online`. Without it, returns SKIPPED and makes zero network calls (consistent with rigscore's default-offline posture).
- Requires `sites: [...]` in `.rigscorerc.json`. Without it, returns N/A.
- Concurrency: exposed-path probes run with a fan-out of 5 per site. Header, PII, and SSL probes are sequential.
- HTML PII scan is regex-based and bounded by what the server returns on GET `/` — it does not crawl.
- SSL probe uses a direct TCP-connect to port 443; hosts behind clients or HTTP-only sites are skipped silently.

## Sources

Primary sources this check is grounded in (evidence-backed, not best-practice vibes):

- [OWASP Secure Headers Project](https://owasp.org/www-project-secure-headers/) — the response-header baseline the online probes check.

# Expected findings — scored-project fixture

This fixture is intentionally imperfect. Each bullet below describes a rigscore
finding the fixture was designed to fire, keyed by check id and finding title.
The `test/fixture-dogfood.test.js` suite locks the total count and score range,
plus a handful of specific critical findings, so that any drift in check
behavior surfaces as a test failure.

The fixture is scanned with `HOME` set to an empty directory (see
`fixture-dogfood.test.js`) so that home-profile instruction/skill files do not
leak into the assertion.

---

## env-exposure (weight 8)

- `env-exposure/env-file-found-but-not-in-gitignore` (CRITICAL) — `.env` exists
  and `.gitignore` intentionally omits it, so secrets would be committed.
- `env-exposure/env-is-world-readable` (WARNING) — `.env` has mode 0644 by
  default on POSIX; rigscore flags world-readable secret files.

## mcp-config (weight 14)

- `mcp-config/mcp-server-filesystem-typo-uses-unpinned-version-latest` (WARNING)
  — the typosquat server pins `@latest`, an unstable tag.
- `mcp-config/mcp-server-filesystem-typo-uses-unpinned-npx-package` (WARNING) —
  same server runs under `npx` without a stable version pin.
- `mcp-config/mcp-server-filesystem-typo-package-...` (WARNING) —
  `@modelcontextprotocol/server-filestystem` (double `t`) typosquats the real
  `@modelcontextprotocol/server-filesystem`.
- `mcp-config/mcp-server-env-wildcard-receives-4-sensitive-env-vars` (CRITICAL)
  — the `env-wildcard` server is handed four `SENSITIVE_ENV_KEYS` at once.
- Three INFO findings: `runtime tool pin not recorded` for each of the three
  servers (expected first-run rug-pull baseline state).

## docker-security (weight 6)

Two services (`webapp`, `ollama`) each trigger:

- `docker-security/container-<name>-missing-cap-drop-all` (WARNING)
- `docker-security/container-<name>-missing-no-new-privileges` (INFO)
- `docker-security/container-<name>-has-no-user-directive` (WARNING)
- `docker-security/container-<name>-has-no-memory-limit` (INFO)

Eight findings total — two per service × four patterns.

## network-exposure (advisory, weight 0)

- `network-exposure/docker-port-8080-open-webui-exposed-without-loopback-bind`
  (WARNING) — webapp binds 8080 without `127.0.0.1:`.
- `network-exposure/docker-port-11434-ollama-exposed-without-loopback-bind`
  (WARNING) — ollama port 11434 same issue.

## skill-files (weight 10)

- Homoglyph in `.cursorrules` (WARNING) — Cyrillic `а` embedded in the
  "Exotic Branding" section.
- `operator-sudo` skill: shell-execution WARNING (backticked `sudo ...`
  commands) and privilege-escalation WARNING (sudo keyword).
- `destructive-unguarded` skill: shell-execution WARNING, data-exfiltration
  WARNING (`send ... to https?`), and non-TLS URL WARNING
  (`http://config.example.com/...`).
- `clean-skill` fires no findings (baseline).

## unicode-steganography (weight 4)

- `unicode-steganography/homoglyph-characters-in-cursorrules` (WARNING) —
  same Cyrillic `а` as skill-files, scored separately per design.

## instruction-effectiveness (advisory, weight 0)

- Two `dead-file-reference-in-cursorrules` (WARNING) — `docs/ARCHITECTURE_DEAD.md`
  and `docs/runbook-missing.md` are referenced but do not exist.
- One `vague-instruction-in-cursorrules` (INFO) — "use your best judgment".

## claude-md (weight 10)

- `governance-file-is-short-under-50-lines` (WARNING) — `.cursorrules` sits
  just under the 50-line threshold when trimmed.
- Three `governance-file-missing-*` (WARNING) — network restrictions,
  anti-injection, shell restrictions are intentionally absent.

## workflow-maturity (advisory, weight 0)

- Three `skill-<name>-has-no-eval` (INFO) — one per fixture skill dir.
- Three `mcp-server-<name>-has-1-discoverable-consumer` (WARNING) — the repo
  only references each MCP server once, below the "graduate to code" threshold.

## claude-settings (weight 8)

- `no-claude-settings-found` (INFO) — fixture intentionally omits
  `.claude/settings.json` so this surfaces as N/A-adjacent INFO.

## Ancillary / N/A

- `git-hooks/not-a-git-repository` (INFO) — fixture is not a git repo, so
  git-hooks check returns N/A.
- `credential-storage/no-ai-client-config-files-found` (INFO) — N/A, no
  home-level AI client configs under the empty HOME.
- `permissions-hygiene` scores 100 — fixture is nothing unusual.
- `coherence` returns N/A — no Claude settings to cross-check against.
- `windows-security`, `site-security`, `infrastructure-security` are N/A on
  Linux without opt-in configuration.
- `documentation`, `skill-coherence`, `deep-secrets` are N/A or advisory with
  no findings for this fixture shape.

---

## Mechanical totals

Total actionable findings (critical + warning + info): **~42**
(locked as a range with ±4 tolerance in the assertion suite.)

Overall score: **~26/100** (locked as 20–35 in the assertion suite).

Regenerate by running:

```
UPDATE_FIXTURES=1 npm run test:fixture
```

This updates the committed `EXPECTED-FINDINGS.md` range and any snapshot with
the current observed values, so intentional check-surface changes land with a
traceable fixture update in the same PR.

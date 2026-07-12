# CycloneDX AI-BOM export (`--cyclonedx`)

`rigscore --cyclonedx . > ai-bom.json` prints a **CycloneDX 1.6** BOM of the AI components rigscore
discovers during a scan — so an auditor asking *"what AI wiring does this repo pull in?"* gets a
machine-readable answer. Schema worked from:
<https://raw.githubusercontent.com/CycloneDX/specification/master/schema/bom-1.6.schema.json>

## What lands in the BOM

| Discovered thing | CycloneDX shape |
| --- | --- |
| MCP server in `.mcp.json` / `.vscode/mcp.json` | `components[]`, `type: application`, `bom-ref: mcp-server:<name>` |
| npm-launched MCP server with a **stable version pin** | that component's `version` + `purl` (`pkg:npm/…`) |
| AI client configs (`.mcp.json`, `.vscode/mcp.json`, `.claude/settings.json`) | `components[]`, `type: file` + SHA-256 content digest |
| Governance files (`CLAUDE.md`, `AGENTS.md`, `.cursorrules`, …) | `components[]`, `type: file` + SHA-256 content digest |
| All of the above | a flat `dependencies[]` graph rooted at `metadata.component` |

## Facts that ride on `properties` — and why

CycloneDX 1.6 has **no first-class AI/agent component type** — an Agent-BOM is still an open spec
proposal ([CycloneDX/specification#895](https://github.com/CycloneDX/specification/issues/895)) — so
rather than invent fields 1.6 does not define, AI facts are emitted as `properties` name/value rows
(duplicate names are legal in 1.6, so one `env-key` row per key):

| Property | Fact |
| --- | --- |
| `rigscore:mcp:transport` | `stdio` / `sse` / `http` |
| `rigscore:mcp:command`, `rigscore:mcp:args` | how the server is launched |
| `rigscore:mcp:env-key` (repeats) | each **declared env var name**. Values are never emitted — they are credentials |
| `rigscore:mcp:config-shape-sha256` | rigscore's rug-pull hash of `{command, args, envKeys}`. Not an artifact digest, so it does not belong in `hashes` |
| `rigscore:mcp:runtime-tool-sha256` | the pinned `tools/list` hash from `.rigscore-state.json`, when pinned |
| `rigscore:file:role` | `governance` or `ai-client-config` |
| `rigscore:score`, `rigscore:profile` | the scan's score and profile (on `metadata`) |

The config file each server is declared in, and a network server's endpoint URL, ride on
`externalReferences` (`configuration` / `other`) — 1.6 constructs that do exist.

## Limits

- **Not schema-validated in CI.** `test/cyclonedx.test.js` asserts the emitted document against the
  1.6 **required-field contract** (required fields, closed `type` enums, `bom-ref` uniqueness and
  resolvability), hand-transcribed from the schema above — a JSON-Schema validator does *not* run.
  Wiring one is a one-command follow-up: `npm i -D @cyclonedx/cyclonedx-library@^7.1.0` (v7, not v8+:
  v8 needs Node ≥20.18 and the CI matrix includes 18.17), then assert
  `new Validation.JsonStrictValidator('1.6').validate(json)` is `null` — the emitted BOM passes that
  today; the dep was dropped only because its lockfile churn trips our pre-push diff-cap gate.
- **Repo-scoped.** Home-dir client configs the scan also reads (`~/.cursor/mcp.json`, …) are
  excluded: a BOM is shippable and must not carry a developer's machine layout.
- **Single project.** `--cyclonedx` with `--recursive` exits 2 (a BOM has one `metadata.component`);
  `--sarif` (and `--ci`, which implies it) wins if both output flags are passed.
- **No models or datasets** are guessed in — rigscore does not discover them, so no
  `machine-learning-model` components or `modelCard` blocks appear.

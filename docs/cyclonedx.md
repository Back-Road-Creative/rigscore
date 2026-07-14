# CycloneDX AI-BOM export (`--cyclonedx`)

`rigscore --cyclonedx . > ai-bom.json` prints a **CycloneDX 1.6** BOM of the AI components rigscore
discovers during a scan — so an auditor asking *"what AI wiring does this repo pull in?"* gets a
machine-readable answer. Schema worked from:
<https://raw.githubusercontent.com/CycloneDX/specification/master/schema/bom-1.6.schema.json>

## Schema validation

The emitted BOM is validated in CI against the **real** CycloneDX 1.6 JSON schema —
`test/cyclonedx.test.js` runs the upstream `Validation.JsonStrictValidator('1.6')` from
[`@cyclonedx/cyclonedx-library`](https://www.npmjs.com/package/@cyclonedx/cyclonedx-library), not a
hand-transcribed restatement of it. A companion negative test mutates a component `type` to an
off-spec value and requires the validator to reject it, so a validator that silently no-opped could
not produce a green run.

> **Pin the dep to v7, not v8+.** v8 requires Node ≥20.18; the CI matrix (`.github/workflows/ci.yml`)
> still includes **18.17**, which `package.json` `engines` also declares support for. v7 needs only
> Node ≥14. Bump to v8 *only* together with dropping the 18.17 leg.
>
> The library's XML validator pulls the native addon `libxmljs2`, but only as an **optional**
> dependency — rigscore validates JSON only (pure-JS `ajv`), so a failed native build is harmless and
> does not fail `npm ci`.

## What lands in the BOM

| Discovered thing | CycloneDX shape |
| --- | --- |
| MCP server in **any** repo-level client config | `components[]`, `type: application`, `bom-ref: mcp-server:<name>` |
| npm-launched MCP server with a **stable version pin** | that component's `version` + `purl` (`pkg:npm/…`) |
| AI client configs (every repo-level MCP config, plus `.claude/settings.json`) | `components[]`, `type: file` + SHA-256 content digest |
| Governance files (`CLAUDE.md`, `AGENTS.md`, `.cursorrules`, …) | `components[]`, `type: file` + SHA-256 content digest |
| All of the above | a flat `dependencies[]` graph rooted at `metadata.component` |

**Repo-level** means every committed, in-repo MCP config the client registry declares —
today `.mcp.json`, `.vscode/mcp.json`, `.gemini/settings.json` and `opencode.json`. The BOM
reads that set from the registry (`repoMcpRelPaths()`), the same source of truth the
rug-pull pin uses, so a client added to rigscore is inventoried without touching this
exporter. Home-dir configs (`~/.cursor/mcp.json`, …) are excluded on purpose: a BOM is
shippable and must not carry a developer's machine layout.

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

- **Repo-scoped.** Home-dir client configs the scan also reads (`~/.cursor/mcp.json`, …) are
  excluded: a BOM is shippable and must not carry a developer's machine layout.
- **Single project.** `--cyclonedx` with `--recursive` exits 2 (a BOM has one `metadata.component`);
  `--sarif` (and `--ci`, which implies it) wins if both output flags are passed.
- **No models or datasets** are guessed in — rigscore does not discover them, so no
  `machine-learning-model` components or `modelCard` blocks appear.

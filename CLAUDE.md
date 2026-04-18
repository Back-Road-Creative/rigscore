# pkg-rigscore

AI dev security scoring tool. Moat-first: MCP supply chain, governance coherence, prompt injection — not generic checks.

## Key Constraints

- Zero deps beyond chalk + yaml
- Scoring weighted ~48% moat (mcp-config 14 + coherence 14 + skill-files 10 + claude-md 10) / ~52% hygiene (secrets 22, docker/infra 12, permissions/hooks/unicode/settings 18); weights live in `src/constants.js`
- `--fix` never modifies governance content
- Distributed via GitHub only: `npx github:Back-Road-Creative/rigscore` (npm intentionally dropped)

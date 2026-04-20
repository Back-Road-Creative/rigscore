# Vanilla Next.js (no AI tooling) — rigscore fixture

A minimal realistic Next.js project with zero AI/agent tooling markers:
no `.claude/`, no `.cursorrules`, no `.mcp.json`, no `AGENTS.md`.

Used by `test/no-ai-tooling-fixtures.test.js` to assert rigscore gracefully
declines rather than scoring a vanilla project "F" just for lacking AI
governance.

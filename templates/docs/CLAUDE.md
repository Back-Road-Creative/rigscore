# CLAUDE.md

The agent contract for {{PROJECT_NAME}} lives in `AGENTS.md`, the vendor-neutral instruction file.
Read it first. It governs Claude Code exactly as it governs every other agent, so there is one
contract rather than two that drift apart.

@AGENTS.md

## Claude-specific

Only genuinely Claude-specific rules belong below. A rule that would apply to any agent goes in
`AGENTS.md`.

- Prefer the Read, Edit, Glob, and Grep tools over their shell equivalents. They are auditable and
  they honour the boundary that `AGENTS.md` sets.
- Claude's settings file carries the machine-enforced half of these rules — deny lists, hooks,
  permission modes. This file states the rules; settings enforce the ones a machine can enforce.

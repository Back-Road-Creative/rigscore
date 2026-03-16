#!/usr/bin/env node

import { run } from '../src/index.js';

const args = process.argv.slice(2);

if (args.includes('--version')) {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const pkg = require('../package.json');
  console.log(`rigscore v${pkg.version}`);
  process.exit(0);
}

if (args.includes('--help') || args.includes('-h')) {
  console.log(`rigscore — AI dev environment configuration hygiene checker

Usage:
  rigscore [directory] [options]

Options:
  --json             Output results as JSON
  --badge            Generate a markdown badge
  --no-color         Disable colored output
  --no-cta           Suppress promotional call-to-action
  --check <id>       Run a single check by ID
  --recursive, -r    Scan subdirectories as separate projects
  --depth <N>        Recursion depth (default: 1, implies --recursive)
  --version          Show version
  --help, -h         Show this help

Checks:
  claude-md           CLAUDE.md governance (20 pts)
  mcp-config          MCP server configuration (15 pts)
  env-exposure        Secret exposure (20 pts)
  docker-security     Docker/K8s/Podman security (15 pts)
  git-hooks           Git hooks (10 pts)
  skill-files         Skill file safety (10 pts)
  permissions-hygiene File permissions hygiene (10 pts)

Examples:
  rigscore                          Scan current directory
  rigscore /path/to/project         Scan a specific project
  rigscore --json                   JSON output for CI
  rigscore . -r --depth 2           Scan monorepo (2 levels deep)
  rigscore --check docker-security  Run only Docker/K8s check`);
  process.exit(0);
}

run(args);

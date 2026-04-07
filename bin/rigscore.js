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
  --sarif            Output SARIF v2.1.0 for GitHub Advanced Security
  --badge            Generate a markdown badge
  --ci               CI mode (--sarif --no-color --no-cta)
  --fail-under <N>   Exit code 1 if score < N (default: 70)
  --profile <name>   Scoring profile (default, minimal, ci)
  --no-color         Disable colored output
  --no-cta           Suppress promotional call-to-action
  --check <id>       Run a single check by ID
  --recursive, -r    Scan subdirectories as separate projects
  --depth <N>        Recursion depth (default: 1, implies --recursive)
  --deep             Enable deep source secret scanning
  --online           Enable online MCP supply chain verification
  --fix              Show auto-fixable issues (dry run)
  --fix --yes        Apply safe auto-remediations
  --watch            Watch for changes and re-run automatically
  --init-hook        Install a pre-commit hook that runs rigscore
  --version          Show version
  --help, -h         Show this help

Checks (moat-heavy weighting):
  mcp-config              MCP server configuration (14 pts)
  coherence               Cross-config coherence (14 pts)
  skill-files             Skill file safety (10 pts)
  claude-md               CLAUDE.md governance (10 pts)
  deep-secrets            Deep source secret scanning (--deep, 8 pts)
  env-exposure            Secret exposure (8 pts)
  claude-settings         Claude settings safety (8 pts)
  credential-storage      Credential storage hygiene (6 pts)
  docker-security         Docker/K8s/Podman security (6 pts)
  infrastructure-security Infrastructure safety (6 pts)
  unicode-steganography   Unicode steganography (4 pts)
  permissions-hygiene     File permissions hygiene (4 pts)
  git-hooks               Git hooks (2 pts)
  site-security           Deployed site security (--online, advisory)

Examples:
  rigscore                          Scan current directory
  rigscore /path/to/project         Scan a specific project
  rigscore --json                   JSON output for CI
  rigscore --ci --fail-under 80     CI with strict threshold
  rigscore . -r --depth 2           Scan monorepo (2 levels deep)
  rigscore --check docker-security  Run only Docker/K8s check`);
  process.exit(0);
}

run(args);

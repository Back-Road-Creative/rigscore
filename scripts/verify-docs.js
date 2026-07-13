#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  verifyCheckDocs,
  formatVerifyResult,
  TEMPLATE_RELATIVE,
} from '../src/lib/verify-docs.js';

const __filename = fileURLToPath(import.meta.url);
const DEFAULT_REPO_ROOT = path.resolve(__filename, '..', '..');

const HELP = `verify-docs — docs-first gate for rigscore checks

Usage:
  node scripts/verify-docs.js            Verify every src/checks/*.js has a
                                         complete doc page at docs/checks/<id>.md.
  node scripts/verify-docs.js --stub <id>
                                         Create docs/checks/<id>.md from the
                                         canonical template (idempotent).
  node scripts/verify-docs.js --cwd <path>
                                         Run the verify or stub against the
                                         given repo root instead of this script's
                                         install dir. \`--root\` is an alias.
  node scripts/verify-docs.js --help     Show this help.

Exit codes:
  0  ok (or stub created / already present)
  1  doc gate failed (offenders or orphans)
  2  I/O or argument error
`;

function printUsageHintAndExit(msg) {
  process.stderr.write(`verify-docs: ${msg}\n`);
  process.stderr.write('Run `node scripts/verify-docs.js --help` for usage.\n');
  process.exit(2);
}

/**
 * Pull `--cwd <path>` (alias `--root <path>`) out of an arg array.
 * Returns { repoRoot, rest } — `rest` is the original argv minus the
 * consumed flag + value. Defaults to DEFAULT_REPO_ROOT (the rigscore
 * install dir) when neither flag is present, so existing `npm run
 * verify:docs` behavior is preserved bit-identically.
 */
function parseRepoRoot(args) {
  const rest = [];
  let repoRoot = DEFAULT_REPO_ROOT;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--cwd' || arg === '--root') {
      if (i + 1 >= args.length) {
        printUsageHintAndExit(`${arg} requires a path argument`);
      }
      repoRoot = path.resolve(args[++i]);
      continue;
    }
    rest.push(arg);
  }
  // Validate that the chosen root is a real directory — clearer error
  // than a downstream readdir ENOENT.
  try {
    const stat = fs.statSync(repoRoot);
    if (!stat.isDirectory()) {
      printUsageHintAndExit(`--cwd target is not a directory: ${repoRoot}`);
    }
  } catch {
    printUsageHintAndExit(`--cwd target does not exist: ${repoRoot}`);
  }
  return { repoRoot, rest };
}

async function runVerify(repoRoot) {
  try {
    const result = await verifyCheckDocs({ root: repoRoot });
    const output = formatVerifyResult(result, { scriptName: 'verify:docs' });
    // Set exitCode rather than process.exit(): the ruleId report can run to
    // hundreds of lines, and process.exit() truncates an in-flight async write
    // when stdout is a pipe (i.e. every CI log).
    process.stdout.write(`${output}\n`);
    process.exitCode = result.ok ? 0 : 1;
  } catch (err) {
    process.stderr.write(`verify-docs: error: ${err && err.message ? err.message : err}\n`);
    process.exit(2);
  }
}

async function runStub(id, repoRoot) {
  if (!id || id.startsWith('-')) {
    printUsageHintAndExit('--stub requires a check id (e.g. --stub env-exposure)');
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    printUsageHintAndExit(`invalid check id: ${id} (expected kebab-case)`);
  }

  try {
    // Stub template always comes from the rigscore install — the user's
    // repo root may not contain docs/checks/_template.md.
    const templatePath = path.join(DEFAULT_REPO_ROOT, TEMPLATE_RELATIVE);
    const targetPath = path.join(repoRoot, 'docs', 'checks', `${id}.md`);

    if (fs.existsSync(targetPath)) {
      process.stdout.write(`stub: docs/checks/${id}.md already exists\n`);
      process.exit(0);
    }

    const template = await fs.promises.readFile(templatePath, 'utf8');
    const body = template.split('<check-id>').join(id);

    await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.promises.writeFile(targetPath, body, 'utf8');

    process.stdout.write(
      `stub: created docs/checks/${id}.md — fill in sections, then rerun npm run verify:docs\n`,
    );
    process.exit(0);
  } catch (err) {
    process.stderr.write(`stub: error: ${err && err.message ? err.message : err}\n`);
    process.exit(2);
  }
}

async function main() {
  const rawArgs = process.argv.slice(2);

  // --help is honored even with no other args, before --cwd validation,
  // so `verify-docs --help` works from anywhere.
  if (rawArgs[0] === '--help' || rawArgs[0] === '-h') {
    process.stdout.write(HELP);
    process.exit(0);
  }

  const { repoRoot, rest } = parseRepoRoot(rawArgs);

  if (rest.length === 0) {
    await runVerify(repoRoot);
    return;
  }

  if (rest[0] === '--stub') {
    if (rest.length !== 2) {
      printUsageHintAndExit('--stub takes exactly one argument: the check id');
    }
    await runStub(rest[1], repoRoot);
    return;
  }

  printUsageHintAndExit(`unknown argument: ${rest[0]}`);
}

main();

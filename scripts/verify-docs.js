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
const REPO_ROOT = path.resolve(__filename, '..', '..');

const HELP = `verify-docs — docs-first gate for rigscore checks

Usage:
  node scripts/verify-docs.js            Verify every src/checks/*.js has a
                                         complete doc page at docs/checks/<id>.md.
  node scripts/verify-docs.js --stub <id>
                                         Create docs/checks/<id>.md from the
                                         canonical template (idempotent).
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

async function runVerify() {
  try {
    const result = await verifyCheckDocs({ root: REPO_ROOT });
    const output = formatVerifyResult(result, { scriptName: 'verify:docs' });
    process.stdout.write(`${output}\n`);
    process.exit(result.ok ? 0 : 1);
  } catch (err) {
    process.stderr.write(`verify-docs: error: ${err && err.message ? err.message : err}\n`);
    process.exit(2);
  }
}

async function runStub(id) {
  if (!id || id.startsWith('-')) {
    printUsageHintAndExit('--stub requires a check id (e.g. --stub env-exposure)');
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    printUsageHintAndExit(`invalid check id: ${id} (expected kebab-case)`);
  }

  try {
    const templatePath = path.join(REPO_ROOT, TEMPLATE_RELATIVE);
    const targetPath = path.join(REPO_ROOT, 'docs', 'checks', `${id}.md`);

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
  const args = process.argv.slice(2);

  if (args.length === 0) {
    await runVerify();
    return;
  }

  if (args[0] === '--help' || args[0] === '-h') {
    process.stdout.write(HELP);
    process.exit(0);
  }

  if (args[0] === '--stub') {
    if (args.length !== 2) {
      printUsageHintAndExit('--stub takes exactly one argument: the check id');
    }
    await runStub(args[1]);
    return;
  }

  printUsageHintAndExit(`unknown argument: ${args[0]}`);
}

main();

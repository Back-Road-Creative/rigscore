#!/usr/bin/env node
/**
 * generate-facts.js — emit `rigscore-facts.json`, a machine-readable snapshot
 * of the live check registry. The site (headlessmode) renders its homepage
 * count/version, JSON-LD softwareVersion, and docs check tables FROM this file
 * instead of hand-maintained literals, so a rigscore release updates one JSON
 * file and every derived surface re-renders. Hand-written counts structurally
 * cease to exist.
 *
 * Every count is pulled from code at run time (the same dynamic-import trick
 * src/lib/verify-docs.js uses for WEIGHTS) — nothing here is hardcoded, so the
 * facts cannot silently drift from the registry.
 *
 * Usage:
 *   node scripts/generate-facts.js            print JSON to stdout
 *   node scripts/generate-facts.js --out FILE write JSON to FILE
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function repoRoot() {
  return path.resolve(__dirname, '..');
}

// Node ESM rejects relative filesystem paths as bare specifiers; import via
// file:// URL — the pattern src/lib/verify-docs.js:257 uses.
async function importFromRoot(root, ...rel) {
  return import(pathToFileURL(path.join(root, ...rel)).href);
}

// Exit codes are a documented contract (README "Exit codes" table + code 4 at
// src/cli/mcp-subcommands.js) with no single constant to import; enumerated
// here as the authoritative machine-readable list. These are meanings, not
// counts — the "never hardcode counts" rule does not apply.
const EXIT_CODES = [
  { code: 0, meaning: 'Scan completed; score at or above --fail-under (baseline mode: no new findings).' },
  { code: 1, meaning: 'Scan completed; score below --fail-under, or baseline mode found new findings.' },
  { code: 2, meaning: 'Configuration/argument/scan error, or bad input to an mcp-* subcommand.' },
  { code: 3, meaning: 'Subcommand pre-condition: mcp-verify found no pinned runtime tool hash for the server.' },
  { code: 4, meaning: 'mcp-verify drift: the pinned tool hash no longer matches the piped tools/list.' },
];

// Meta flags handled in bin/rigscore.js before parseArgs sees them, so they are
// absent from FLAG_DEFS below.
const META_FLAGS = ['--version', '--help', '-h'];

/**
 * Extract every flag token from the FLAG_DEFS dispatch table in src/index.js.
 * Parsing the parser's own registry keeps the flag list robust by construction:
 * a flag added to FLAG_DEFS auto-appears here (a hardcoded list would drift —
 * the exact failure class this file exists to kill).
 */
function extractCliFlags(root) {
  const src = fs.readFileSync(path.join(root, 'src', 'index.js'), 'utf8');
  const start = src.indexOf('const FLAG_DEFS');
  const body = start >= 0 ? src.slice(start) : src;
  const found = new Set(META_FLAGS);
  for (const m of body.matchAll(/'(--?[a-zA-Z][a-zA-Z-]*)'\s*:/g)) {
    found.add(m[1]);
  }
  return [...found].sort();
}

// Release date for the current version, from the dated CHANGELOG heading
// (`## [2.1.0] - 2026-07-15`). Falls back to the generation date if absent.
function releaseDate(root, version, fallback) {
  try {
    const log = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
    const esc = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = log.match(new RegExp(`^##\\s*\\[${esc}\\]\\s*-\\s*(\\d{4}-\\d{2}-\\d{2})`, 'm'));
    if (m) return m[1];
  } catch { /* fall through */ }
  return fallback;
}

/**
 * Build the facts object from the live registry.
 * @param {object} [opts]
 * @param {string} [opts.root] repo root (default: this script's parent dir).
 * @returns {Promise<object>}
 */
export async function generateFacts(opts = {}) {
  const root = path.resolve(opts.root || repoRoot());
  const generatedAt = new Date().toISOString().slice(0, 10);

  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const { WEIGHTS, FRAMEWORKS } = await importFromRoot(root, 'src', 'constants.js');
  const { loadChecks } = await importFromRoot(root, 'src', 'checks', 'index.js');

  const loaded = await loadChecks({ cwd: root });
  const checks = loaded
    .map((c) => ({
      id: c.id,
      weight: WEIGHTS[c.id] ?? 0,
      category: c.category ?? null,
      enforcementGrade: c.enforcementGrade ?? null,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const scoredCount = checks.filter((c) => c.weight > 0).length;
  const advisoryCount = checks.filter((c) => c.weight === 0).length;

  const enforcementGrades = {};
  for (const c of checks) {
    const g = c.enforcementGrade || 'ungraded';
    enforcementGrades[g] = (enforcementGrades[g] || 0) + 1;
  }

  const frameworks = Object.entries(FRAMEWORKS).map(([id, f]) => ({
    id,
    name: f.name,
    status: f.status,
    coverage: f.coverage,
    url: f.url,
    controlCount: Object.keys(f.controls || {}).length,
  }));

  return {
    generatedBy: 'scripts/generate-facts.js',
    generatedAt,
    version: pkg.version,
    date: releaseDate(root, pkg.version, generatedAt),
    checkCount: checks.length,
    scoredCount,
    advisoryCount,
    enforcementGrades,
    checks,
    frameworks,
    exitCodes: EXIT_CODES,
    cliFlags: extractCliFlags(root),
  };
}

async function main(argv) {
  const outIdx = argv.indexOf('--out');
  const outPath = outIdx >= 0 ? argv[outIdx + 1] : null;
  const facts = await generateFacts();
  const json = `${JSON.stringify(facts, null, 2)}\n`;
  if (outPath) {
    fs.writeFileSync(outPath, json);
  } else {
    process.stdout.write(json);
  }
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isMain) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`generate-facts: ${err.message}\n`);
    process.exit(1);
  });
}

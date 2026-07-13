import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { slugify } from '../utils.js';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json');

/**
 * Flatten all findings across check results into a single list.
 * Only actionable severities are baselined (skipped/pass are excluded).
 */
export function flattenFindings(results) {
  const out = [];
  for (const r of results || []) {
    for (const f of r.findings || []) {
      if (f.severity === 'skipped' || f.severity === 'pass') continue;
      out.push({
        checkId: r.id,
        findingId: f.findingId || `${r.id}/${slugify(f.title)}`,
        severity: f.severity,
        title: f.title,
      });
    }
  }
  return out;
}

/**
 * Build the baseline document shape.
 * { timestamp: ISO-8601, version: rigscore version, findings: [...] }
 */
export function buildBaseline(scanResult) {
  return {
    timestamp: new Date().toISOString(),
    version: pkg.version,
    findings: flattenFindings(scanResult.results),
  };
}

/**
 * Discriminated baseline loader — distinguishes a MISSING file from a
 * CORRUPT existing one, which a plain null collapses together.
 *
 *   - `missing`: the path does not exist (ENOENT). First run — the caller
 *     may legitimately mint a fresh baseline (documented regenerate flow:
 *     `rm <baseline> && rigscore --baseline`, docs/TROUBLESHOOTING.md).
 *   - `corrupt`: the file EXISTS but is unparseable JSON, has no findings
 *     array, or is otherwise unreadable. Never a valid committed state — a
 *     CI gate must NOT silently re-mint over it (that fails a regression
 *     gate OPEN when an attacker overwrites the committed baseline).
 *   - `ok`: a well-formed baseline document.
 *
 * @returns {{status: 'missing'|'corrupt'|'ok', baseline: object|null}}
 */
export function readBaseline(baselinePath) {
  let raw;
  try {
    raw = fs.readFileSync(baselinePath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { status: 'missing', baseline: null };
    // Present-but-unreadable (EACCES, EISDIR, …) is not "first run" either.
    return { status: 'corrupt', baseline: null };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 'corrupt', baseline: null };
  }
  if (!parsed || !Array.isArray(parsed.findings)) return { status: 'corrupt', baseline: null };
  return { status: 'ok', baseline: parsed };
}

/**
 * Back-compat loader. Returns the baseline document, or null if the file is
 * missing OR malformed. Callers that must distinguish the two (a gate that
 * cannot fail open on corruption) should use readBaseline() instead.
 */
export function loadBaseline(baselinePath) {
  const { status, baseline } = readBaseline(baselinePath);
  return status === 'ok' ? baseline : null;
}

/**
 * Persist a baseline JSON. Creates parent directories as needed.
 * Permission errors / disk-full surface as a clean stderr line + exit 2
 * rather than a Node stack trace.
 */
export function writeBaseline(baselinePath, baseline) {
  try {
    fs.mkdirSync(path.dirname(path.resolve(baselinePath)), { recursive: true });
    fs.writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + '\n');
  } catch (err) {
    process.stderr.write(`rigscore: could not write baseline ${baselinePath}: ${err.message}\n`);
    process.exit(2);
  }
}

/**
 * Return findings in `current` that are NOT in `baseline`. Matching key
 * is `findingId` (primary) plus severity (so severity upgrades surface).
 */
export function diffFindings(baselineFindings, currentFindings) {
  const seen = new Set();
  for (const f of baselineFindings || []) {
    seen.add(`${f.findingId}::${f.severity}`);
  }
  const added = [];
  for (const f of currentFindings || []) {
    const key = `${f.findingId}::${f.severity}`;
    if (!seen.has(key)) added.push(f);
  }
  return added;
}

/**
 * `rigscore diff <baseline> <current>` — JSON output of new findings.
 * Both arguments are paths to baseline-shaped JSON files. Current may
 * also be a raw scan-result JSON (with .results[]) — we handle both.
 */
export function runDiffSubcommand(args) {
  if (args.length < 2) {
    process.stderr.write('Error: rigscore diff <baseline> <current> — expected two paths.\n');
    process.exit(2);
  }
  const baseline = loadBaseline(args[0]);
  if (!baseline) {
    process.stderr.write(`Error: could not load baseline at ${args[0]}\n`);
    process.exit(2);
  }
  let current;
  try {
    const raw = fs.readFileSync(args[1], 'utf8');
    try {
      current = JSON.parse(raw);
    } catch (parseErr) {
      process.stderr.write(
        `rigscore: ${args[1]} is not valid JSON (${parseErr.message}). ` +
        `Fix the syntax and retry.\n`,
      );
      process.exit(2);
    }
  } catch (err) {
    process.stderr.write(`Error: could not load current at ${args[1]}: ${err.message}\n`);
    process.exit(2);
  }

  // Accept either baseline-shape {findings:[]} or scan-result {results:[]}.
  const currentFindings = Array.isArray(current.findings)
    ? current.findings
    : flattenFindings(current.results);

  const added = diffFindings(baseline.findings, currentFindings);
  const out = {
    baseline: { timestamp: baseline.timestamp, version: baseline.version, count: baseline.findings.length },
    current: { count: currentFindings.length },
    added,
    addedCount: added.length,
  };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  process.exit(added.length === 0 ? 0 : 1);
}

/**
 * Baseline-mode driver for `rigscore --baseline <path>`. On first run
 * writes the baseline + exits 0; on subsequent runs computes the diff
 * vs the saved baseline and exits 0 (no new findings) or 1 (new
 * findings, listed on stderr). Extracted from src/index.js run() for
 * readability; behavior is unchanged.
 *
 * @param {object} scanResult - The {results, score, config} from scan().
 * @param {string} baselinePath - Filesystem path passed to --baseline.
 * @returns {void} Always exits the process.
 */
export function runBaselineMode(scanResult, baselinePath) {
  const { status, baseline: existing } = readBaseline(baselinePath);
  // A corrupt COMMITTED baseline is never legitimate — refuse rather than
  // re-mint the current (possibly attacker-controlled) findings as the new
  // "known" set, which would fail this regression gate OPEN. Mirrors
  // verifyState()/runDiffSubcommand, which already fail closed on corruption.
  if (status === 'corrupt') {
    process.stderr.write(
      `rigscore: baseline ${baselinePath} is malformed ` +
      `(unparseable JSON or missing findings array); refusing to silently ` +
      `re-mint. Fix or regenerate it.\n`,
    );
    process.exit(2);
  }
  if (status === 'missing') {
    const newBaseline = buildBaseline(scanResult);
    writeBaseline(baselinePath, newBaseline);
    process.stderr.write(
      `rigscore: wrote new baseline to ${baselinePath} ` +
      `(${newBaseline.findings.length} findings pinned).\n`,
    );
    process.exit(0);
  }
  const currentFindings = flattenFindings(scanResult.results);
  const added = diffFindings(existing.findings, currentFindings);
  if (added.length === 0) {
    process.stderr.write(`rigscore: no new findings vs baseline (${existing.findings.length} pinned).\n`);
    process.exit(0);
  }
  process.stderr.write(
    `rigscore: ${added.length} new findings vs baseline ` +
    `(baseline timestamp: ${existing.timestamp}):\n`,
  );
  for (const f of added) {
    process.stderr.write(`  [${f.severity}] ${f.findingId} — ${f.title}\n`);
  }
  // Baseline semantics: any new finding fails. The early-return above
  // guarantees added.length > 0 by the time we reach here.
  process.exit(1);
}

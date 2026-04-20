import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

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
        findingId: f.findingId || `${r.id}/${(f.title || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60)}`,
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
 * Load a baseline JSON from disk. Returns null if file is missing or
 * malformed (caller treats as "no baseline yet — create one").
 */
export function loadBaseline(baselinePath) {
  try {
    const raw = fs.readFileSync(baselinePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.findings)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Persist a baseline JSON. Creates parent directories as needed.
 */
export function writeBaseline(baselinePath, baseline) {
  fs.mkdirSync(path.dirname(path.resolve(baselinePath)), { recursive: true });
  fs.writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + '\n');
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
    current = JSON.parse(raw);
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

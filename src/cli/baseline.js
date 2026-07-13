import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { slugify, execSafe } from '../utils.js';

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
 * Discriminated baseline loader — distinguishes a MISSING file (ENOENT; first
 * run, mint is legitimate) from a CORRUPT existing one (unparseable, no findings
 * array, or unreadable — never a valid committed state; a CI gate must NOT
 * silently re-mint over it) from `ok` (a well-formed document). A plain null
 * collapses missing and corrupt together — that is the fail-open bug.
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
  return classifyBaseline(raw);
}

/**
 * Classify a baseline body: 'ok' with the parsed document, or 'corrupt' for
 * unparseable JSON or a document with no findings array. Shared by the
 * working-tree loader (readBaseline) and the committed loader.
 * @returns {{status: 'corrupt'|'ok', baseline: object|null}}
 */
function classifyBaseline(raw) {
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
 * Resolve the baseline as COMMITTED AT HEAD — the provenance fix that mirrors
 * `--verify-state` (#263). A CI regression gate must trust only the version a
 * human committed and reviewed, never the working-tree copy an attacker can
 * delete or overwrite in their PR. `git show HEAD:<repo-relative-path>` is the
 * authority; the working tree is still what gets scanned for findings.
 *
 *   { inRepo:false }                        — not a git repo → caller uses the working tree
 *   { inRepo:true, status:'absent' }        — git repo, nothing committed at HEAD (first run)
 *   { inRepo:true, status:'corrupt' }       — committed but unparseable → hard-fail
 *   { inRepo:true, status:'ok', baseline }  — the committed authority
 *
 * @returns {Promise<object>}
 */
async function readCommittedBaseline(baselinePath) {
  const abs = path.resolve(baselinePath);
  const top = await execSafe('git', ['-C', path.dirname(abs), 'rev-parse', '--show-toplevel']);
  if (top === null) return { inRepo: false }; // not a git repo (or git unavailable)
  const rel = path.relative(top.trim(), abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return { inRepo: true, status: 'absent' };
  const raw = await execSafe('git', ['-C', top.trim(), 'show', `HEAD:${rel}`]);
  if (raw === null) return { inRepo: true, status: 'absent' }; // no HEAD / not tracked
  return { inRepo: true, ...classifyBaseline(raw) };
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
export async function runBaselineMode(scanResult, baselinePath, { refresh = false } = {}) {
  // Explicit regenerate. Under git-HEAD provenance a plain re-run no longer
  // re-mints (the gate reads HEAD), so `--baseline-refresh` is the one
  // sanctioned way to (re)write the working-tree baseline for a human to commit.
  if (refresh) {
    mintBaseline(scanResult, baselinePath, 'refreshed baseline at', ' — review and commit it.');
  }

  // In a git repo the COMMITTED baseline is the sole authority — a deleted or
  // corrupt working-tree copy cannot launder findings (mirrors --verify-state).
  const committed = await readCommittedBaseline(baselinePath);
  if (committed.inRepo && committed.status === 'corrupt') failCorrupt(baselinePath, 'committed (HEAD)');
  if (committed.inRepo && committed.status === 'ok') diffAndExit(committed.baseline, scanResult);

  // Not a git repo, or a git repo with nothing pinned at HEAD: fall back to the
  // working-tree loader (preserves non-git usage and the documented first run).
  const { status, baseline: existing } = readBaseline(baselinePath);
  if (status === 'corrupt') failCorrupt(baselinePath, 'working-tree');
  if (status === 'missing') mintBaseline(scanResult, baselinePath, 'wrote new baseline to', '');
  diffAndExit(existing, scanResult);
}

/** Refuse a corrupt baseline (never silently re-mint). Always exits 2. */
function failCorrupt(baselinePath, which) {
  process.stderr.write(
    `rigscore: ${which} baseline ${baselinePath} is malformed ` +
    `(unparseable JSON or missing findings array); refusing to silently ` +
    `re-mint. Fix or regenerate it with \`rigscore --baseline ${baselinePath} --baseline-refresh\`.\n`,
  );
  process.exit(2);
}

/** Write a fresh baseline from the current findings. Always exits 0. */
function mintBaseline(scanResult, baselinePath, verb, suffix) {
  const fresh = buildBaseline(scanResult);
  writeBaseline(baselinePath, fresh);
  process.stderr.write(`rigscore: ${verb} ${baselinePath} (${fresh.findings.length} findings pinned)${suffix}.\n`);
  process.exit(0);
}

/** Diff current findings against a resolved baseline. Exits 0 (clean) or 1 (new findings). */
function diffAndExit(existing, scanResult) {
  const added = diffFindings(existing.findings, flattenFindings(scanResult.results));
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
  process.exit(1);
}

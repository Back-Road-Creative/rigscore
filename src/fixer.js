import { getRegisteredFixes } from './checks/index.js';
import { listPacks, loadPack, installPack, formatInstallReport, TEMPLATES_DIR } from './cli/packs.js';
import { SEVERITY } from './constants.js';

/**
 * Safe auto-remediation for rigscore findings.
 *
 * Fixes are self-registered by check modules (via named `fixes` export arrays)
 * and collected during loadChecks(). This module reads them from checks/index.js
 * via getRegisteredFixes().
 *
 * Matching precedence (2026-04-20, Moat & Ship Agent A):
 *   1. If the fixer declares `findingIds: string[]`, match any finding whose
 *      `findingId` appears in that list. This is the preferred form — immune
 *      to title rewording.
 *   2. Otherwise, fall back to the legacy `fixer.match(finding)` predicate.
 *      Legacy matchers typically use title substring checks; rewording a
 *      check's finding title silently orphans the fix, so a deprecation warn
 *      is emitted the first time a legacy matcher is used in a process.
 *
 * There are two remediation sources, and callers must keep them distinct in
 * their output — they are two different consents, not one. A file-level auto-fix
 * (findApplicableFixes / applyFixes, above) repairs a red check in a file that
 * already exists; a pack install (findApplicablePacks / installPacks, below)
 * scaffolds a whole starter baseline of files the repo never had. `--yes` means
 * "don't prompt me" and unlocks only the first; scaffolding requires the caller's
 * explicit `--install-packs` opt-in.
 *
 * Never modifies governance content: an auto-fix is append-only, and a pack
 * install writes NEW files only — installPack is never called with `force`, so
 * an existing file is reported `skipped (exists)` and left byte-for-byte alone.
 */

const warnedLegacyMatchers = new Set();

/**
 * Resolve all available fixers: self-registered from check modules.
 */
function resolveFixers() {
  return getRegisteredFixes();
}

/**
 * Return true when the given fixer matches the given finding. Consults
 * `fixer.findingIds` (preferred) first; falls back to `fixer.match()` with a
 * one-shot deprecation warning per fixer id per process.
 */
function fixerMatches(id, fixer, finding) {
  // Preferred path: explicit findingId equality. Immune to title rewording.
  if (Array.isArray(fixer.findingIds) && fixer.findingIds.length > 0) {
    if (finding && finding.findingId && fixer.findingIds.includes(finding.findingId)) {
      return true;
    }
  }
  // Fallback: legacy title-substring matcher. Emits a one-shot deprecation
  // warning the first time it is consulted for a given fixer in this process.
  if (typeof fixer.match === 'function') {
    const matched = fixer.match(finding);
    if (matched) {
      if (!warnedLegacyMatchers.has(id)) {
        warnedLegacyMatchers.add(id);
        process.stderr.write(
          `rigscore: fixer "${id}" matched via legacy title-substring predicate. ` +
          `Prefer findingId equality — set findingId on the finding and list it ` +
          `in fixer.findingIds to avoid silent fix orphaning if the title changes.\n`,
        );
      }
      return true;
    }
  }
  return false;
}

/**
 * Analyze scan results and return a list of applicable fixes.
 * Each fix: { id, description, finding }
 */
export function findApplicableFixes(results) {
  const allFixers = resolveFixers();
  const fixes = [];
  for (const checkResult of results) {
    for (const finding of checkResult.findings) {
      for (const [id, fixer] of Object.entries(allFixers)) {
        if (fixerMatches(id, fixer, finding)) {
          fixes.push({ id, description: fixer.description, finding, checkId: checkResult.id });
        }
      }
    }
  }
  return fixes;
}

/**
 * Apply fixes. Returns { applied: string[], skipped: string[] }.
 */
export async function applyFixes(fixes, cwd, homedir) {
  const allFixers = resolveFixers();
  const applied = [];
  const skipped = [];

  for (const fix of fixes) {
    const fixer = allFixers[fix.id];
    if (!fixer) {
      skipped.push(fix.description);
      continue;
    }
    try {
      // Pass the matched finding so finding-driven fixers (e.g. the coherence
      // MCP-server declaration) can read fields off it. File-discovery fixers
      // that ignore the third arg are unaffected.
      const success = await fixer.apply(cwd, homedir, fix.finding);
      if (success) {
        applied.push(fix.description);
      } else {
        skipped.push(fix.description + ' (already applied or not applicable)');
      }
    } catch (err) {
      skipped.push(fix.description + ` (error: ${err.message})`);
    }
  }

  return { applied, skipped };
}

/** A finding is RED — worth remediating — only at critical or warning. */
const RED = new Set([SEVERITY.CRITICAL, SEVERITY.WARNING]);

/**
 * Analyze scan results and return the packs that remediate a red finding.
 *
 * A pack claims the check ids it turns green in `pack.json.checks`; a check
 * with at least one critical/warning finding is red. The intersection is the
 * offer. Pure — writes nothing, which is exactly what `--fix`'s dry run needs.
 *
 * Each entry: { name, description, checks, targets } where `targets` are the
 * red check ids this pack claims (a subset of `checks`).
 */
export function findApplicablePacks(results, templatesDir = TEMPLATES_DIR) {
  const redCheckIds = new Set(
    (results || [])
      .filter((r) => (r.findings || []).some((f) => RED.has(f && f.severity)))
      .map((r) => r.id),
  );
  if (redCheckIds.size === 0) return [];

  const packs = [];
  for (const name of listPacks(templatesDir)) {
    let pack;
    try {
      pack = loadPack(name, templatesDir);
    } catch {
      continue; // A malformed manifest must not break --fix; `init` reports it loudly.
    }
    const targets = pack.checks.filter((id) => redCheckIds.has(id));
    if (targets.length > 0) {
      packs.push({ name, description: pack.description, checks: pack.checks, targets });
    }
  }
  return packs;
}

/**
 * Install the given packs into `cwd`. Only ever called behind `--yes
 * --install-packs` (or `init --<pack>`) — never as a side effect of `--yes`.
 *
 * Deliberately does NOT pass `force`: installPack skips a dest that already
 * exists, so this adds missing governance files and never rewrites one the
 * operator wrote. Returns { installed: string[], skipped: string[] } — the
 * installed entries are formatted per-pack reports naming every file as
 * `written` or `skipped (exists)`.
 */
export function installPacks(packs, cwd, templatesDir = TEMPLATES_DIR) {
  const installed = [];
  const skipped = [];
  for (const p of packs) {
    try {
      const report = installPack(p.name, cwd, { templatesDir }); // no force — never clobber
      installed.push(formatInstallReport(report, cwd).trimEnd());
    } catch (err) {
      skipped.push(`${p.name} (error: ${err.message})`);
    }
  }
  return { installed, skipped };
}

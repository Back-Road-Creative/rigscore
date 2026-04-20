import { getRegisteredFixes } from './checks/index.js';

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
 * Never modifies governance content.
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
        console.warn(
          `rigscore: fixer "${id}" matched via legacy title-substring predicate. ` +
          `Prefer findingId equality — set findingId on the finding and list it ` +
          `in fixer.findingIds to avoid silent fix orphaning if the title changes.`,
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
      const success = await fixer.apply(cwd, homedir);
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

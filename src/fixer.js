import { getRegisteredFixes } from './checks/index.js';

/**
 * Safe auto-remediation for rigscore findings.
 *
 * Fixes are self-registered by check modules (via named `fixes` export arrays)
 * and collected during loadChecks(). This module reads them from checks/index.js
 * via getRegisteredFixes().
 *
 * Never modifies governance content.
 */

/**
 * Resolve all available fixers: self-registered from check modules.
 */
function resolveFixers() {
  return getRegisteredFixes();
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
        if (fixer.match(finding)) {
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

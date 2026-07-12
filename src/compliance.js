import { FRAMEWORKS, NOT_APPLICABLE_SCORE, SEVERITY } from './constants.js';

/**
 * Compliance report — findings regrouped by framework control. Answers the auditor's
 * question ("evidence for control X?"), not the engineer's ("what's broken?").
 *
 * Honesty rules: a framework's upstream `status` always prints (a beta list never reads
 * as settled); a control no check supports prints as NOT EVIDENCED rather than being
 * omitted; a check with no honest home is listed as UNMAPPED.
 */

const BLOCKING = new Set([SEVERITY.CRITICAL, SEVERITY.WARNING]);

/** Roll a check result up to a one-word compliance verdict. */
function verdict(r) {
  if (r.score === NOT_APPLICABLE_SCORE) return 'N/A';
  const sevs = (r.findings || []).map((f) => f.severity);
  if (sevs.includes(SEVERITY.CRITICAL)) return 'CRITICAL';
  if (sevs.includes(SEVERITY.WARNING)) return 'WARN';
  return 'PASS';
}

/** @param {{results: Array, score: number}} scanResult @returns {string} plain-text report */
export function formatCompliance(scanResult) {
  const results = scanResult.results || [];
  const byId = new Map(results.map((r) => [r.id, r]));
  const out = [
    'rigscore compliance report',
    `Overall score: ${scanResult.score}`,
    '',
    'A check is listed under a control ONLY where it genuinely evidences it;',
    'NOT EVIDENCED marks an honest gap, not an oversight.',
  ];
  for (const fw of Object.values(FRAMEWORKS)) {
    const evidence = new Map(); // control -> evidencing check results
    for (const [checkId, control] of Object.entries(fw.map)) {
      const r = byId.get(checkId);
      if (!r) continue; // check didn't run (e.g. behind --check)
      if (!evidence.has(control)) evidence.set(control, []);
      evidence.get(control).push(r);
    }
    const cov = fw.coverage === 'full' ? 'full (every scored check is mapped)' : 'partial (intentionally sparse)';
    out.push('', '='.repeat(72), fw.name, `Status: ${fw.status}`, `Coverage: ${cov}`, `Source: ${fw.url}`);
    if (fw.note) out.push(`Note: ${fw.note}`);
    out.push('');

    // A documented control with no evidence must still surface, as NOT EVIDENCED.
    for (const id of [...new Set([...Object.keys(fw.controls), ...evidence.keys()])].sort()) {
      out.push(`  ${id} — ${fw.controls[id] || '(no title on record)'}`);
      const checks = (evidence.get(id) || []).slice().sort((a, b) => a.id.localeCompare(b.id));
      if (checks.length === 0) out.push('      NOT EVIDENCED by any rigscore check');
      for (const r of checks) {
        const score = r.score === NOT_APPLICABLE_SCORE ? 'n/a' : String(r.score);
        out.push(`      [${verdict(r).padEnd(8)}] ${r.id.padEnd(26)} score ${score.padStart(3)}`);
        for (const f of (r.findings || []).filter((x) => BLOCKING.has(x.severity))) {
          out.push(`          - ${f.severity}: ${f.title}`);
        }
      }
      out.push('');
    }
    const unmapped = results.map((r) => r.id).filter((id) => !(id in fw.map)).sort();
    if (unmapped.length > 0) out.push(`  UNMAPPED here (${unmapped.length}): ${unmapped.join(', ')}`, '');
  }
  return out.join('\n');
}

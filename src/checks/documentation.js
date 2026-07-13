import path from 'node:path';
import { NOT_APPLICABLE_SCORE } from '../constants.js';
import { calculateCheckScore } from '../scoring.js';
import { statSafe } from '../utils.js';
import { verifyCheckDocs } from '../lib/verify-docs.js';

const SELF_ID = 'documentation';

/**
 * NOTE — EXPANDERS.documentation in src/lib/verify-docs.js enumerates this check's legal
 * ruleIds by scraping the `case '…':` labels below. A reason with no case label here is
 * NOT enumerable, so documenting its id is rejected as a ghost and omitting it leaves the
 * gate vacuously green. Every reason ruleIdDrift() can emit must have a case label.
 */
function reasonLabel(reason) {
  switch (reason) {
    case 'missing': return 'missing doc';
    case 'incomplete': return 'incomplete doc';
    case 'weight-drift': return 'weight drift';
    case 'h1-mismatch': return 'H1 mismatch';
    case 'ruleid-ghost': return 'documented ruleId never emitted';
    case 'ruleid-undocumented': return 'emitted ruleId never documented';
    case 'ruleid-unexpandable': return 'unexpandable ruleId prefix';
    case 'ruleid-unverified': return 'ruleId not verifiable';
    default: return reason;
  }
}

/**
 * `ruleid-unverified` is INFO, not WARNING: the gate could not enumerate the id's value
 * set, so it is a "couldn't check", not a proven defect. It must still be a FINDING —
 * "couldn't check" must never look like "checked, fine", and any finding suppresses the
 * PASS below. The other three are proven drift: a stale SARIF ruleId silently breaks a
 * downstream repo's `--ignore <ruleId>` suppressions.
 */
const RULEID_SEVERITY = {
  'ruleid-ghost': 'warning',
  'ruleid-undocumented': 'warning',
  'ruleid-unexpandable': 'warning',
  'ruleid-unverified': 'info',
};

function ruleIdDetail(off) {
  const doc = `docs/checks/${off.id}.md`;
  const src = `src/checks/${off.id}.js`;
  if (off.reason === 'ruleid-ghost') {
    const emitted = (off.emitted || []).join(', ') || '(none)';
    return `${doc} documents \`${off.ruleId}\`, which ${src} never emits. It emits: ${emitted}. Rename the row to a real id or delete it.`;
  }
  if (off.reason === 'ruleid-undocumented') {
    return `${src} emits \`${off.ruleId}\`, but ${doc} never lists it. Add a ## Triggers row for it.`;
  }
  if (off.reason === 'ruleid-unexpandable') {
    return `${src} emits \`${off.ruleId}\`, a bare prefix that would make EVERY documented id pass vacuously. Add an expander for ${off.id} in src/lib/verify-docs.js.`;
  }
  return `${doc} documents \`${off.ruleId}\`, which only prefix-matches \`${off.prefix}\${...}\` — a value set that is not statically enumerable, so this id is NOT verified.`;
}

function offenderDetail(off) {
  if (off.reason === 'missing') {
    return `docs/checks/${off.id}.md does not exist.`;
  }
  if (off.reason === 'incomplete') {
    const missing = (off.missingSections || []).map((s) => `## ${s}`).join(', ');
    return `docs/checks/${off.id}.md is missing sections: ${missing}.`;
  }
  if (off.reason === 'weight-drift') {
    return `docs/checks/${off.id}.md does not state the expected weight ${off.expectedWeight}.`;
  }
  if (off.reason === 'h1-mismatch') {
    return `docs/checks/${off.id}.md has H1 "${off.got}" but should match check id "${off.id}".`;
  }
  return `docs/checks/${off.id}.md has a docs-gate violation (${off.reason}).`;
}

export default {
  id: SELF_ID,
  enforcementGrade: 'mechanical',
  name: 'Check documentation coverage',
  category: 'process',

  async run(context) {
    const { cwd } = context;
    const findings = [];

    const checksDir = path.join(cwd, 'src', 'checks');
    const docsDir = path.join(cwd, 'docs', 'checks');
    const [checksStat, docsStat] = await Promise.all([
      statSafe(checksDir),
      statSafe(docsDir),
    ]);

    if (!checksStat || !checksStat.isDirectory() || !docsStat || !docsStat.isDirectory()) {
      findings.push({
        severity: 'skipped',
        title: 'Documentation check skipped (not a rigscore-style repo)',
        detail: 'This check only runs when both src/checks/ and docs/checks/ exist (rigscore itself or plugin repos).',
      });
      return { score: NOT_APPLICABLE_SCORE, findings };
    }

    let result;
    try {
      result = await verifyCheckDocs({ root: cwd });
    } catch (err) {
      findings.push({
        severity: 'skipped',
        title: 'Documentation check could not run',
        detail: `verifyCheckDocs failed: ${err.message}`,
      });
      return { score: NOT_APPLICABLE_SCORE, findings };
    }

    for (const off of result.offenders) {
      // Self-exempt: suppress only the "missing" finding for this check itself.
      // Other reasons (incomplete/weight-drift/h1-mismatch) are real bugs and must surface.
      if (off.id === SELF_ID && off.reason === 'missing') continue;

      findings.push({
        findingId: `documentation/docs-gate-${off.reason}`,
        severity: 'warning',
        title: `Docs gate: ${off.id} — ${reasonLabel(off.reason)}`,
        detail: offenderDetail(off),
        remediation: `See docs/checks/_template.md. To scaffold a stub: npm run verify:docs -- --stub ${off.id}`,
      });
    }

    for (const orphan of result.orphans) {
      findings.push({
        findingId: 'documentation/orphan-doc',
        severity: 'info',
        title: `Orphan doc: docs/checks/${orphan}.md`,
        detail: `docs/checks/${orphan}.md has no matching src/checks/${orphan}.js. Remove the doc or add the check module.`,
      });
    }

    // verifyCheckDocs() folds ruleIdOffenders into its `ok` verdict, so `npm run
    // verify:docs` has always gated on these. Without this loop the CLI, the GitHub
    // Action and the Docker image reported a serene "All N checks documented" while
    // SARIF ruleIds had silently drifted out from under downstream `--ignore` rules.
    for (const off of result.ruleIdOffenders || []) {
      findings.push({
        findingId: `documentation/docs-gate-${off.reason}`,
        severity: RULEID_SEVERITY[off.reason] || 'warning',
        title: `Docs gate: ${off.id} — ${reasonLabel(off.reason)}`,
        detail: ruleIdDetail(off),
        remediation: `Reconcile the ## Triggers table in docs/checks/${off.id}.md with the findingIds src/checks/${off.id}.js actually emits.`,
      });
    }

    if (findings.length === 0) {
      findings.push({
        severity: 'pass',
        title: `All ${result.counts.checks} checks documented`,
        detail: `${result.counts.docs} doc pages match ${result.counts.checks} check modules with no offenders or orphans.`,
      });
    }

    return {
      score: calculateCheckScore(findings),
      findings,
    };
  },
};

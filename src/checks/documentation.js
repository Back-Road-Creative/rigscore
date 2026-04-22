import path from 'node:path';
import { NOT_APPLICABLE_SCORE } from '../constants.js';
import { calculateCheckScore } from '../scoring.js';
import { statSafe } from '../utils.js';
import { verifyCheckDocs } from '../lib/verify-docs.js';

const SELF_ID = 'documentation';

function reasonLabel(reason) {
  switch (reason) {
    case 'missing': return 'missing doc';
    case 'incomplete': return 'incomplete doc';
    case 'weight-drift': return 'weight drift';
    case 'h1-mismatch': return 'H1 mismatch';
    default: return reason;
  }
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

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { calculateCheckScore } from '../scoring.js';
import { NOT_APPLICABLE_SCORE } from '../constants.js';
import { walkDirSafe, relPosix, toPosix } from '../utils.js';
import { homeScopeEnabled } from '../lib/home-scope.js';

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.venv', '__pycache__', '.pytest_cache', '.ruff_cache',
]);

/**
 * Row exclude globs, matched against the row-relative POSIX path. `*` stops at a
 * separator, `**` crosses them — the same pragmatic subset instruction-effectiveness
 * uses for `crossRepoRefs`.
 */
function buildExcluder(patterns) {
  const globs = (Array.isArray(patterns) ? patterns : []).filter((p) => typeof p === 'string');
  if (globs.length === 0) return () => false;
  const regexes = globs.map((g) => {
    const withStars = g.replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '::DOUBLESTAR::').replace(/\*/g, '[^/]*').replace(/::DOUBLESTAR::/g, '.*');
    return new RegExp(`^${withStars}$`);
  });
  return (rel) => regexes.some((re) => re.test(rel));
}

/** A row is usable only if both sides are plain relative paths inside their base. */
function usableRow(row) {
  const ok = (v) => typeof v === 'string' && v.length > 0
    && !path.isAbsolute(v) && !toPosix(v).split('/').includes('..');
  return Boolean(row) && typeof row === 'object' && ok(row.tracked) && ok(row.deployed);
}

async function sha256(file) {
  try {
    return crypto.createHash('sha256').update(await fs.promises.readFile(file)).digest('hex');
  } catch { return null; }
}

export default {
  id: 'staged-copy-drift',
  enforcementGrade: 'mechanical',
  name: 'Staged copy drift',
  category: 'process',

  /**
   * A repo that tracks copies of assets DEPLOYED under the operator's home config dir
   * has two sources of truth, and a redeploy that never lands a commit leaves the
   * tracked copy stale — worse than an untracked file, because it still reads as
   * committed and reviewable. The live side is $HOME, so the verdict is operator-
   * machine-specific: the check is inert (N/A, no home read at all) unless the operator
   * opts in with --include-home-skills, which is what keeps CI runners and foreign
   * machines from scoring a repo on files they cannot see.
   */
  async run(context) {
    if (!homeScopeEnabled(context)) return { score: NOT_APPLICABLE_SCORE, findings: [] };

    const { cwd, homedir, config } = context;
    const rows = (Array.isArray(config?.stagedCopies) ? config.stagedCopies : []).filter(usableRow);
    const findings = [];
    let compared = 0;

    for (const row of rows) {
      const trackedRoot = path.join(cwd, row.tracked);
      const excluded = buildExcluder(row.exclude);
      const { files } = await walkDirSafe(trackedRoot,
        { skipDirs: SKIP_DIRS, skipHidden: false, maxFiles: 5000 });

      for (const file of files) {
        const rel = relPosix(trackedRoot, file);
        if (excluded(rel)) continue;
        const deployed = path.join(homedir, row.deployed, rel);
        const deployedHash = await sha256(deployed);
        // No twin = not deployed from this row. Deployment coverage is a different
        // tool's job; installer scripts and fixtures are legitimately tracked-only.
        if (deployedHash === null) continue;
        const trackedHash = await sha256(file);
        if (trackedHash === null) continue;
        compared++;
        if (trackedHash === deployedHash) continue;
        findings.push({
          findingId: 'staged-copy-drift/content-drift',
          severity: 'warning',
          title: `Staged copy drifted from the deployed file: ${row.tracked}/${rel}`,
          detail: `\`${relPosix(cwd, file)}\` and the deployed \`${toPosix(row.deployed)}/${rel}\` have different contents. One side changed without the other — a stale tracked copy still reads as committed and reviewable.`,
          remediation: 'Diff both copies and sync the direction you mean: commit the deployed version, or redeploy from the tracked one. There is no safe automatic direction.',
          evidence: `tracked ${trackedHash.slice(0, 8)} != deployed ${deployedHash.slice(0, 8)}`,
          context: { tracked: `${row.tracked}/${rel}`, deployed: `${toPosix(row.deployed)}/${rel}` },
        });
      }
    }

    if (findings.length === 0) {
      findings.push({
        severity: 'pass',
        title: rows.length === 0
          ? 'No staged copies configured (stagedCopies is empty)'
          : `Staged copies match their deployed twins (${compared} compared)`,
      });
    }

    return { score: calculateCheckScore(findings), findings, data: { rows: rows.length, compared } };
  },
};

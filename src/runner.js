import { WEIGHTS } from './constants.js';

/**
 * Weight to stamp on a result.
 *
 * `resolvedWeights` (from `resolveWeights` in config.js) is the profile +
 * overrides + disabled-checks map that scoring already uses. A check disabled
 * via `.rigscorerc.json` is expressed there as weight 0, so an entry MUST win
 * even when it is 0 — hence the explicit `in` test rather than `||`, which
 * would fall through on a legitimate zero and re-report the static weight.
 *
 * Callers that pass no map (direct `runChecks` consumers importing it from
 * scanner.js) keep the historical static-WEIGHTS behavior, including the
 * `check.weight` fallback for plugin ids absent from WEIGHTS.
 */
function resolveCheckWeight(check, resolvedWeights) {
  if (resolvedWeights && check.id in resolvedWeights) {
    return resolvedWeights[check.id];
  }
  return WEIGHTS[check.id] || check.weight || 0;
}

/**
 * Run an array of checks against a context, collect results.
 * Uses Promise.allSettled so one failing check doesn't block others.
 */
export async function runChecks(checks, context, options = {}) {
  const { checkFilter, resolvedWeights } = options;

  let filtered = checks;
  if (checkFilter) {
    filtered = checks.filter((c) => c.id === checkFilter);
  }

  const settled = await Promise.allSettled(
    filtered.map(async (check) => {
      const result = await check.run(context);

      // Defensive default — third-party `rigscore-check-*` plugins may not
      // declare `enforcementGrade`. Fall back to 'pattern' so reporter/SARIF
      // rendering does not crash on undefined grades.
      const enforcementGrade = check.enforcementGrade || 'pattern';

      // Validate result shape: must have numeric score and findings array
      if (!result || typeof result.score !== 'number' || !Array.isArray(result.findings)) {
        return {
          id: check.id,
          name: check.name,
          category: check.category,
          weight: resolveCheckWeight(check, resolvedWeights),
          enforcementGrade,
          score: 0,
          findings: [{
            severity: 'critical',
            title: `Check "${check.id}" returned invalid result`,
            detail: 'Expected { score: number, findings: Array } but got an invalid shape.',
          }],
        };
      }

      return {
        id: check.id,
        name: check.name,
        category: check.category,
        weight: resolveCheckWeight(check, resolvedWeights),
        enforcementGrade,
        score: result.score,
        findings: result.findings,
        ...(result.data !== undefined && { data: result.data }),
      };
    }),
  );

  return settled.map((outcome, i) => {
    if (outcome.status === 'fulfilled') {
      return outcome.value;
    }
    // Check threw — return score 0 with a CRITICAL finding
    const check = filtered[i];
    return {
      id: check.id,
      name: check.name,
      category: check.category,
      weight: resolveCheckWeight(check, resolvedWeights),
      enforcementGrade: check.enforcementGrade || 'pattern',
      score: 0,
      findings: [
        {
          severity: 'critical',
          title: `Check "${check.id}" failed to run`,
          detail: outcome.reason?.message || 'Unknown error',
        },
      ],
    };
  });
}

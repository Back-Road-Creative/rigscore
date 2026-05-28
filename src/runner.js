import { WEIGHTS } from './constants.js';

/**
 * Run an array of checks against a context, collect results.
 * Uses Promise.allSettled so one failing check doesn't block others.
 */
export async function runChecks(checks, context, options = {}) {
  const { checkFilter } = options;

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
          weight: WEIGHTS[check.id] || check.weight || 0,
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
        weight: WEIGHTS[check.id] || check.weight || 0,
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
      weight: WEIGHTS[check.id] || check.weight || 0,
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

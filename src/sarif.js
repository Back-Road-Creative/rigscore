import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { version } = require('../package.json');

const SEVERITY_MAP = {
  critical: 'error',
  warning: 'warning',
  info: 'note',
  pass: 'none',
  skipped: 'none',
};

/**
 * Convert rigscore scan results to SARIF v2.1.0 format.
 */
export function formatSarif(result) {
  const { results } = result;

  // Build rule definitions from check IDs
  const rules = results.map((r) => ({
    id: r.id,
    shortDescription: { text: r.name },
    defaultConfiguration: {
      level: 'warning',
    },
  }));

  // Build results from findings
  const sarifResults = [];
  for (const r of results) {
    for (const finding of r.findings) {
      const level = SEVERITY_MAP[finding.severity] || 'none';
      if (level === 'none') continue; // skip pass/skipped

      sarifResults.push({
        ruleId: r.id,
        level,
        message: {
          text: finding.detail ? `${finding.title}: ${finding.detail}` : finding.title,
        },
        locations: [
          {
            logicalLocations: [
              {
                name: r.category,
                kind: 'module',
              },
            ],
          },
        ],
      });
    }
  }

  return {
    $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'rigscore',
            version,
            informationUri: 'https://github.com/Back-Road-Creative/rigscore',
            rules,
          },
        },
        results: sarifResults,
      },
    ],
  };
}

/**
 * Convert recursive scan results to SARIF v2.1.0 with one run per project.
 */
export function formatSarifMulti(projects) {
  if (!projects || projects.length === 0) {
    return formatSarif({ results: [] });
  }

  const runs = projects.map((project) => {
    const single = formatSarif({ results: project.results });
    const run = single.runs[0];
    // Tag the run with the project path
    run.automationDetails = { id: project.path };
    return run;
  });

  return {
    $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json',
    version: '2.1.0',
    runs,
  };
}

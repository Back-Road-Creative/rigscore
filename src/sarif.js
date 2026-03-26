import { createRequire } from 'node:module';
import { OWASP_AGENTIC_MAP } from './constants.js';

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
 * Extract a file path from finding title or detail text.
 * Matches patterns like "in path/file.ext", "Found in file.ext",
 * "key found in config.json", or leading ".env.local is ...".
 */
function extractFilePath(text) {
  if (!text) return null;

  // "in <filepath>" or "Found in <filepath>" or "found in <filepath>"
  const inMatch = text.match(/(?:\bin|Found in)\s+([.\w][\w./-]*\.\w+)/i);
  if (inMatch) return inMatch[1];

  // Leading file reference: ".env.local is" or "Dockerfile has"
  const leadMatch = text.match(/^([.\w][\w./-]*\.\w+)\s+(?:is|has|file|not)/i);
  if (leadMatch) return leadMatch[1];

  return null;
}

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

      const tags = [];
      const owasp = OWASP_AGENTIC_MAP[r.id];
      if (owasp) tags.push(`owasp-agentic:${owasp}`);
      tags.push(`category:${r.category}`);

      const location = {
        logicalLocations: [
          {
            name: r.category,
            kind: 'module',
          },
        ],
      };

      // Extract physical file location from finding text
      const filePath = extractFilePath(finding.title) || extractFilePath(finding.detail);
      if (filePath) {
        location.physicalLocation = {
          artifactLocation: { uri: filePath },
        };
      }

      sarifResults.push({
        ruleId: r.id,
        level,
        message: {
          text: finding.detail ? `${finding.title}: ${finding.detail}` : finding.title,
        },
        properties: { tags },
        locations: [location],
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

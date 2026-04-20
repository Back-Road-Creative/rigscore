import { createRequire } from 'node:module';
import { OWASP_AGENTIC_MAP } from './constants.js';
import { stripAnsi } from './reporter.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json');

function safeText(value) {
  if (value == null || typeof value !== 'string') return value;
  return stripAnsi(value);
}

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
 * Derive a per-finding SARIF ruleId of the form `<checkId>/<slug>`.
 *
 * Priority:
 *   1. `finding.findingId` (already in `<checkId>/<slug>` form — preferred).
 *   2. Slugify `finding.title` and prefix with `checkId`.
 *   3. Fall back to bare `checkId` (tool-component rule).
 *
 * The bare `checkId` remains available as a SARIF rule definition (see
 * `rules` array) so consumers that ignore per-finding ruleIds still work.
 */
function deriveFindingRuleId(checkId, finding) {
  if (finding && typeof finding.findingId === 'string' && finding.findingId.length > 0) {
    return finding.findingId.includes('/') ? finding.findingId : `${checkId}/${finding.findingId}`;
  }
  if (finding && typeof finding.title === 'string' && finding.title.length > 0) {
    const slug = finding.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60);
    if (slug) return `${checkId}/${slug}`;
  }
  return checkId;
}

/**
 * Convert rigscore scan results to SARIF v2.1.0 format.
 */
export function formatSarif(result) {
  const { results } = result;

  // Build tool-component rule definitions. The check-level rule is kept as
  // the "anchor" rule so ruleIds of the form `<checkId>` (used as a fallback
  // when a finding has no findingId/title) still resolve. Per-finding rules
  // are added on demand below.
  const rules = results.map((r) => ({
    id: r.id,
    shortDescription: { text: r.name },
    defaultConfiguration: {
      level: 'warning',
    },
  }));
  const knownRuleIds = new Set(rules.map((r) => r.id));

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

      // Per-finding ruleId: <checkId>/<slug-or-findingId>. Register it in the
      // tool-component rules array so SARIF viewers can resolve the id.
      const ruleId = deriveFindingRuleId(r.id, finding);
      const safeTitle = safeText(finding.title);
      const safeDetail = safeText(finding.detail);
      if (!knownRuleIds.has(ruleId)) {
        knownRuleIds.add(ruleId);
        rules.push({
          id: ruleId,
          shortDescription: { text: safeTitle || r.name },
          defaultConfiguration: { level: 'warning' },
        });
      }

      const properties = { tags };
      if (finding.evidence) properties.evidence = safeText(finding.evidence);

      sarifResults.push({
        ruleId,
        level,
        message: {
          text: safeDetail ? `${safeTitle}: ${safeDetail}` : safeTitle,
        },
        properties,
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

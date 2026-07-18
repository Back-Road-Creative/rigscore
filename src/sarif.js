import { createRequire } from 'node:module';
import { OWASP_AGENTIC_MAP } from './constants.js';
import { FINDING_ID_RENAMES } from './findings.js';
import { stripAnsi } from './reporter.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json');

// Reverse of FINDING_ID_RENAMES: current check id → the deprecated ids that now
// alias to it. Surfaced as SARIF `reportingDescriptor.deprecatedIds` (§3.49.4)
// so a consumer keyed on an old ruleId (a baseline, a suppression) learns the
// id was renamed instead of silently matching nothing.
const DEPRECATED_IDS_BY_CURRENT = Object.entries(FINDING_ID_RENAMES).reduce(
  (acc, [oldId, currentId]) => {
    (acc[currentId] ||= []).push(oldId);
    return acc;
  },
  Object.create(null),
);

function safeText(value) {
  if (value == null || typeof value !== 'string') return value;
  return stripAnsi(value);
}

/**
 * Normalize an optional check-supplied string for SARIF: strip ANSI, trim, and
 * report empty/whitespace-only as absent. Callers omit the property entirely
 * rather than emitting `"remediation": null` / `""` noise into the bag.
 */
function optionalText(value) {
  if (typeof value !== 'string') return null;
  const text = stripAnsi(value).trim();
  return text.length > 0 ? text : null;
}

/**
 * A finding's `learnMore` becomes its rule's `helpUri` (SARIF 2.1.0 §3.49.12),
 * whose value MUST be a URI. Only absolute http(s) URLs are emitted — anything
 * else (relative text, a `javascript:` scheme) is dropped rather than handed to
 * a SARIF viewer to render as a clickable link.
 */
function safeHelpUri(value) {
  const text = optionalText(value);
  if (!text) return null;
  return /^https?:\/\//i.test(text) ? text : null;
}

/**
 * Severity → SARIF level. `none` means the finding is dropped from SARIF
 * entirely (see `formatSarif`), so it never carries a public ruleId. Exported
 * so the findingId-coverage gate reads the same map instead of hardcoding its
 * own pass/skipped set — one source of truth.
 */
export const SEVERITY_MAP = {
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
  const rules = results.map((r) => {
    const rule = {
      id: r.id,
      shortDescription: { text: r.name },
      defaultConfiguration: {
        level: 'warning',
      },
    };
    const deprecated = DEPRECATED_IDS_BY_CURRENT[r.id];
    if (deprecated && deprecated.length > 0) rule.deprecatedIds = [...deprecated];
    return rule;
  });
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
      const remediation = optionalText(finding.remediation);
      if (!knownRuleIds.has(ruleId)) {
        knownRuleIds.add(ruleId);
        const rule = {
          id: ruleId,
          shortDescription: { text: safeTitle || r.name },
          defaultConfiguration: { level: 'warning' },
        };
        // `learnMore` is a constant doc URL per finding class, so it is genuinely
        // rule-level: `helpUri` (§3.49.12) is a reportingDescriptor property and
        // never a result property. GitHub code scanning does not render helpUri,
        // so the same link also goes in `help` (§3.49.13), which it does render
        // beside each result.
        //
        // `remediation` deliberately does NOT go here: many findings share one
        // ruleId (`workflow-maturity/skill-no-eval` fires once per skill, each
        // with its own fix), so hoisting it would render the first finding's fix
        // next to every sibling's result. It stays per-result, below.
        const helpUri = safeHelpUri(finding.learnMore);
        if (helpUri) {
          rule.helpUri = helpUri;
          rule.help = {
            text: `Learn more: ${helpUri}`,
            markdown: `[Learn more](${helpUri})`,
          };
        }
        rules.push(rule);
      }

      const properties = { tags };
      if (finding.evidence) properties.evidence = safeText(finding.evidence);
      // The fix the check already computed, machine-readable for SARIF consumers
      // that read property bags (§3.8). Omitted outright when there is no fix.
      if (remediation) properties.remediation = remediation;
      // Enforcement-grade label per result — plugin-safe fallback to 'pattern'
      // mirrors scanner.js behavior for third-party `rigscore-check-*` modules
      // that don't declare the field.
      properties.enforcementGrade = r.enforcementGrade || 'pattern';

      // GitHub code scanning ignores property bags it does not understand, so a
      // property-bag-only remediation would be invisible in the one UI that
      // action.yml actually ships to. `message.text` is the per-result text it
      // always renders — the fix rides there too, per-result, never misattributed.
      const message = safeDetail ? `${safeTitle}: ${safeDetail}` : safeTitle;

      sarifResults.push({
        ruleId,
        level,
        message: {
          text: remediation ? `${message}\n\nFix: ${remediation}` : message,
        },
        properties,
        locations: [location],
      });
    }
  }

  const run = {
    tool: {
      driver: {
        name: 'rigscore',
        version,
        informationUri: 'https://github.com/Back-Road-Creative/rigscore',
        rules,
      },
    },
    results: sarifResults,
  };

  // Suppression transparency: record how many findings config/--ignore muted,
  // and which ids, as a run-level property (SARIF §3.14.36 property bag). The
  // dropped findings are deliberately NOT resurrected into `run.results` — a
  // count/note, not a SARIF `suppressions[]` semantic change — so a muted
  // finding is visible to SARIF consumers, not only in a .rigscorerc.json diff.
  const suppressed = result.suppressed;
  if (suppressed && suppressed.count > 0) {
    run.properties = {
      suppressedCount: suppressed.count,
      suppressedIds: suppressed.ids,
    };
  }

  return {
    $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json',
    version: '2.1.0',
    runs: [run],
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
    // Carry that project's own mute summary through, so `suppressedCount` /
    // `suppressedIds` are disclosed per run. Dropping it here is what hid a
    // monorepo's `suppress:` entries from every SARIF consumer.
    const single = formatSarif({ results: project.results, suppressed: project.suppressed });
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

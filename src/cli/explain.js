import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalCheckId } from '../config.js';
import { extractDocumentedRuleIds } from '../lib/verify-docs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const USAGE =
  'Usage: rigscore explain <findingId|checkId>\n' +
  '\n' +
  '  Print the docs for a finding or a check.\n' +
  '  <findingId>  <checkId>/<slug>, as shown in the report, e.g.\n' +
  '               governance-docs/no-governance-file\n' +
  '  <checkId>    prints the whole check page, e.g. governance-docs\n';

/**
 * `rigscore explain <findingId|checkId>` — print the relevant docs page.
 *
 * findingId convention: "<checkId>/<slug>". We first strip the slug to get
 * the checkId, then load docs/checks/<checkId>.md from the rigscore source
 * tree. A finding id is resolved against the page's "## Triggers" table (the
 * same ruleIds `npm run verify:docs` checks against the check's source), and
 * its row is printed. A heading named exactly "<slug>" wins if the page has
 * one. An id the page does not document gets a notice listing the ids it
 * does, then the entire doc so the user still gets useful context.
 *
 * If the checkId doesn't exist, we list the available docs to help the
 * user recover.
 */
export async function runExplainSubcommand(args) {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(USAGE);
    return;
  }
  if (args.length === 0) {
    process.stderr.write(
      'Error: rigscore explain <findingId>\n' +
      '  e.g. rigscore explain governance-docs/missing-claude-md\n',
    );
    process.exit(2);
  }

  const target = args[0];
  const [rawCheckId, ...slugParts] = target.split('/');
  // Canonicalize through the shipped rename table (the same helper weights/
  // suppression use) so `explain claude-md` resolves to governance-docs' doc
  // instead of erroring "no docs found for claude-md".
  const checkId = canonicalCheckId(rawCheckId);
  const slug = slugParts.join('/');

  const docsDir = path.join(REPO_ROOT, 'docs', 'checks');
  const docPath = path.join(docsDir, `${checkId}.md`);

  let doc;
  try {
    doc = fs.readFileSync(docPath, 'utf8');
  } catch {
    process.stderr.write(
      `rigscore explain: no docs found for check "${checkId}" ` +
      `(expected at docs/checks/${checkId}.md).\n`,
    );
    listAvailableChecks(docsDir);
    process.exit(2);
  }

  // A finding-specific id: a heading named exactly for the slug, else the
  // Triggers row that documents it, else the full doc with a notice.
  if (slug) {
    const section = findFindingSection(doc, slug);
    if (section) {
      process.stdout.write(section + '\n');
      return;
    }
    const row = findTriggerRow(doc, checkId, slug);
    if (row) {
      process.stdout.write(formatTriggerRow(checkId, row));
      return;
    }
    const known = extractDocumentedRuleIds(doc, checkId);
    process.stderr.write(
      `(No finding "${slug}" in docs/checks/${checkId}.md; showing the full check doc.` +
      (known.length > 0 ? `\n Documented ids:\n${known.map((k) => `   ${k}`).join('\n')}` : '') +
      ')\n\n',
    );
  }
  process.stdout.write(doc);
}

/**
 * Split a markdown table row into trimmed cells, or null if it is not a row.
 */
function tableCells(line) {
  const t = line.trim();
  if (!t.startsWith('|')) return null;
  return t.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

/**
 * Find the "## Triggers" row that documents `<checkId>/<slug>`. The id must be
 * a whole backticked token in the row, so `no` never matches `no-file`.
 * Returns { condition, severity, ruleId, remediation } or null.
 */
export function findTriggerRow(doc, checkId, slug) {
  const wanted = `${checkId}/${slug}`;
  let inTriggers = false;
  for (const line of doc.split('\n')) {
    if (/^##\s/.test(line)) inTriggers = /^##\s+Triggers\s*$/.test(line);
    if (!inTriggers) continue;
    const cells = tableCells(line);
    if (!cells || cells.length < 4) continue;
    const tokens = [...cells[2].matchAll(/`([^`\n]+)`/g)].map((m) => m[1].trim());
    if (!tokens.includes(wanted)) continue;
    return {
      condition: cells[0],
      severity: cells[1],
      ruleId: cells[2].replace(/`/g, ''),
      remediation: cells.slice(3).join(' | '),
    };
  }
  return null;
}

function formatTriggerRow(checkId, row) {
  return (
    `${row.ruleId}\n\n` +
    `  Severity:   ${row.severity}\n` +
    `  When:       ${row.condition}\n` +
    `  Fix:        ${row.remediation}\n\n` +
    `Full check doc: docs/checks/${checkId}.md  (rigscore explain ${checkId})\n`
  );
}

/**
 * Find a section whose heading is exactly the slug (after normalizing case and
 * punctuation) at H2 to H4. No substring matching: a short slug must not
 * resolve to an unrelated heading. Returns the section text (heading + body up to next same-or-higher
 * heading) or null if nothing matches.
 */
export function findFindingSection(doc, slug) {
  const normalizedSlug = slug.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const lines = doc.split('\n');
  let startIdx = -1;
  let startLevel = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{2,4})\s+(.+?)\s*$/);
    if (!m) continue;
    const level = m[1].length;
    const heading = m[2].toLowerCase().replace(/[^a-z0-9]+/g, '-');
    if (heading === normalizedSlug) {
      startIdx = i;
      startLevel = level;
      break;
    }
  }
  if (startIdx === -1) return null;

  // Extract until next heading at same or higher level
  const endIdx = lines.slice(startIdx + 1).findIndex((l) => {
    const m = l.match(/^(#{1,6})\s+/);
    return m && m[1].length <= startLevel;
  });
  const stop = endIdx === -1 ? lines.length : startIdx + 1 + endIdx;
  return lines.slice(startIdx, stop).join('\n');
}

function listAvailableChecks(docsDir) {
  try {
    const entries = fs.readdirSync(docsDir).filter((f) => f.endsWith('.md') && !f.startsWith('_'));
    if (entries.length === 0) return;
    process.stderr.write('\nAvailable checks:\n');
    for (const e of entries) {
      process.stderr.write(`  - ${e.replace(/\.md$/, '')}\n`);
    }
  } catch {
    // no-op
  }
}

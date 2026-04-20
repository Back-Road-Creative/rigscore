import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

/**
 * `rigscore explain <findingId|checkId>` — print the relevant docs page.
 *
 * findingId convention: "<checkId>/<slug>". We first strip the slug to get
 * the checkId, then load docs/checks/<checkId>.md from the rigscore source
 * tree. If a finding-specific section ("### <slug>") is present in the
 * doc, we print that section; otherwise we print the entire doc so the
 * user gets useful context even when the authoring is light.
 *
 * If the checkId doesn't exist, we list the available docs to help the
 * user recover.
 */
export async function runExplainSubcommand(args) {
  if (args.length === 0) {
    process.stderr.write(
      'Error: rigscore explain <findingId>\n' +
      '  e.g. rigscore explain claude-md/missing-claude-md\n',
    );
    process.exit(2);
  }

  const target = args[0];
  const [checkId, ...slugParts] = target.split('/');
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

  // If the user passed a finding-specific id, try to find a matching
  // section (H2 or H3 that includes the slug). Fall back to the full doc.
  if (slug) {
    const section = findFindingSection(doc, slug);
    if (section) {
      process.stdout.write(section + '\n');
      return;
    }
    process.stderr.write(
      `(No finding-specific section for "${slug}" in docs/checks/${checkId}.md; ` +
      `showing the full check doc.)\n\n`,
    );
  }
  process.stdout.write(doc);
}

/**
 * Find a section whose heading matches the slug. Matches any of:
 *   ## <slug>
 *   ### <slug>
 *   ## ... (slug-like variants: "Finding: <slug>", etc.)
 * Returns the section text (heading + body up to next same-or-higher
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
    if (heading.includes(normalizedSlug) || normalizedSlug.includes(heading)) {
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

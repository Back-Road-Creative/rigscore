import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const REQUIRED_SECTIONS = [
  'Purpose',
  'Triggers',
  'Weight rationale',
  'Fix semantics',
  'SARIF',
  'Example',
];

export const TEMPLATE_RELATIVE = 'docs/checks/_template.md';

function defaultRoot() {
  return path.resolve(__dirname, '..', '..');
}

async function readDirSafe(dir) {
  try {
    return await fs.promises.readdir(dir);
  } catch {
    return null;
  }
}

async function readFileSafe(file) {
  try {
    return await fs.promises.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

function listH2Sections(body) {
  const headings = [];
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^##\s+(.+?)\s*$/);
    if (match) headings.push({ title: match[1].trim(), line: i });
  }
  return headings;
}

function sectionBody(body, startLine) {
  const lines = body.split(/\r?\n/);
  const out = [];
  for (let i = startLine + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join('\n').trim();
}

function missingOrEmptySections(body) {
  const found = listH2Sections(body);
  const foundTitles = new Set(found.map((h) => h.title));
  const missing = [];
  for (const required of REQUIRED_SECTIONS) {
    if (!foundTitles.has(required)) {
      missing.push(required);
      continue;
    }
    const match = found.find((h) => h.title === required);
    const content = sectionBody(body, match.line);
    if (!content) missing.push(required);
  }
  return missing;
}

function h1Id(body) {
  const firstHeading = body.split(/\r?\n/).find((l) => /^#\s+/.test(l));
  if (!firstHeading) return null;
  return firstHeading.replace(/^#\s+/, '').trim();
}

function weightStated(body, weight) {
  if (weight === 0) return /advisory/i.test(body) || /weight\s*0\b/i.test(body);
  const num = String(weight);
  const patterns = [
    new RegExp(`weight\\s*${num}\\b`, 'i'),
    new RegExp(`\\b${num}\\s*points?\\b`, 'i'),
    new RegExp(`\\b${num}\\s*pt\\b`, 'i'),
  ];
  return patterns.some((p) => p.test(body));
}

/**
 * Verify that every check module has a matching, complete doc page.
 *
 * @param {object} opts
 * @param {string} opts.root         Repo root. Defaults to pkg-rigscore root.
 * @param {string} [opts.checksDir]  Override checks dir (default: <root>/src/checks).
 * @param {string} [opts.docsDir]    Override docs dir  (default: <root>/docs/checks).
 * @param {object} [opts.weights]    Weight map; default imported from constants.js.
 * @param {string[]} [opts.selfExemptIds] Check IDs whose docs may omit H1-id match
 *                                        (none by default).
 * @returns {Promise<{ok:boolean, offenders:Array, orphans:string[]}>}
 */
export async function verifyCheckDocs(opts = {}) {
  const root = path.resolve(opts.root || defaultRoot());
  const checksDir = opts.checksDir || path.join(root, 'src', 'checks');
  const docsDir = opts.docsDir || path.join(root, 'docs', 'checks');

  let weights = opts.weights;
  if (!weights) {
    // Node ESM rejects relative filesystem paths as bare specifiers; use file:// URL.
    const constantsUrl = pathToFileURL(path.join(root, 'src', 'constants.js')).href;
    const mod = await import(constantsUrl);
    weights = mod.WEIGHTS;
  }

  const checkFiles = (await readDirSafe(checksDir)) || [];
  const checkIds = checkFiles
    .filter((f) => f.endsWith('.js') && f !== 'index.js')
    .map((f) => path.basename(f, '.js'))
    .sort();

  const docFiles = (await readDirSafe(docsDir)) || [];
  const docIds = docFiles
    .filter((f) => f.endsWith('.md') && !f.startsWith('_'))
    .map((f) => path.basename(f, '.md'))
    .sort();

  const offenders = [];

  for (const id of checkIds) {
    const docPath = path.join(docsDir, `${id}.md`);
    const body = await readFileSafe(docPath);
    if (body === null) {
      offenders.push({ id, reason: 'missing', docPath });
      continue;
    }

    const headingId = h1Id(body);
    if (headingId && headingId !== id) {
      offenders.push({ id, reason: 'h1-mismatch', docPath, got: headingId });
    }

    const missingSections = missingOrEmptySections(body);
    if (missingSections.length > 0) {
      offenders.push({ id, reason: 'incomplete', docPath, missingSections });
      continue;
    }

    if (Object.prototype.hasOwnProperty.call(weights, id)) {
      const weight = weights[id];
      if (!weightStated(body, weight)) {
        offenders.push({ id, reason: 'weight-drift', docPath, expectedWeight: weight });
      }
    }
  }

  const checkIdSet = new Set(checkIds);
  const orphans = docIds.filter((id) => !checkIdSet.has(id));

  return {
    ok: offenders.length === 0 && orphans.length === 0,
    offenders,
    orphans,
    counts: {
      checks: checkIds.length,
      docs: docIds.length,
      offenders: offenders.length,
      orphans: orphans.length,
    },
  };
}

/**
 * Render a human-readable summary of a verifyCheckDocs() result.
 * One line per offender/orphan plus a stub hint.
 */
export function formatVerifyResult(result, { scriptName = 'verify-docs' } = {}) {
  const lines = [];
  for (const off of result.offenders) {
    if (off.reason === 'missing') {
      lines.push(`docs-gate: MISSING src/checks/${off.id}.js → docs/checks/${off.id}.md not found`);
      lines.push(`  stub: npm run ${scriptName} -- --stub ${off.id}`);
    } else if (off.reason === 'incomplete') {
      lines.push(
        `docs-gate: INCOMPLETE docs/checks/${off.id}.md missing sections: ${off.missingSections
          .map((s) => `## ${s}`)
          .join(', ')}`,
      );
    } else if (off.reason === 'weight-drift') {
      lines.push(
        `docs-gate: WEIGHT-DRIFT docs/checks/${off.id}.md does not state weight ${off.expectedWeight}`,
      );
    } else if (off.reason === 'h1-mismatch') {
      lines.push(
        `docs-gate: H1-MISMATCH docs/checks/${off.id}.md — H1 is "${off.got}", expected "${off.id}"`,
      );
    }
  }
  for (const orphan of result.orphans) {
    lines.push(`docs-gate: ORPHAN docs/checks/${orphan}.md has no matching src/checks/${orphan}.js`);
  }
  if (lines.length === 0) {
    lines.push(`docs-gate: OK (${result.counts.checks} checks, ${result.counts.docs} docs)`);
  } else {
    lines.push('');
    lines.push(
      `docs-gate: ${result.offenders.length} offenders, ${result.orphans.length} orphans across ${result.counts.checks} checks`,
    );
  }
  return lines.join('\n');
}

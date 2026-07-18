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

/** Blank out comments so a commented-out id is never harvested (src/checks/index.js has some). */
function stripComments(src) {
  let out = '';
  let quote = null;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') { out += src.slice(i, i + 2); i++; continue; }
      if (ch === quote) quote = null;
    } else if (ch === '/' && (src[i + 1] === '*' || src[i + 1] === '/')) {
      const [mark, skip] = src[i + 1] === '*' ? ['*/', 1] : ['\n', 0];
      const end = src.indexOf(mark, i + 2);
      if (end === -1) break;
      i = end + skip;
      out += ' ';
      continue;
    } else if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    out += ch;
  }
  return out;
}

/** Read one RHS expression from `i`, stopping at a top-level `,` `;` or closer. */
function readExpression(src, i) {
  let depth = 0;
  let quote = null;
  const start = i;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) { if (depth === 0) break; depth--; }
    else if ((ch === ',' || ch === ';') && depth === 0) break;
  }
  return src.slice(start, i);
}

/**
 * The finding ids a check module can emit. Anchors on the `findingId`/`findingIds`
 * token (property OR `const` binding) and harvests every literal from its right-hand
 * side — one rule covering every shape the checks use: literal, inline ternary
 * (credential-storage), nested ternary on a const (env-exposure), `x.id || 'fallback'`
 * (coherence), table entries (spec-goals), fixer `findingIds: [...]` arrays. Ids are
 * filtered to the check's own `<id>/` namespace, dropping paths like 'docs/checks/x.md'.
 * Anchoring beats scanning the whole file, which desynchronizes on apostrophes and
 * regex literals and goes blind (0 of skill-files' 16 ids). An interpolated template
 * reduces to the text before `${`, returned as a *prefix* for EXPANDERS to resolve.
 */
export function extractRuleIds(source, checkId) {
  const src = stripComments(source);
  const literals = new Set();
  const prefixes = new Set();
  const anchor = /(?:^|[\s,{(])findingIds?\s*[:=]/g;
  const ns = `${checkId}/`;
  let m;
  while ((m = anchor.exec(src)) !== null) {
    const expr = readExpression(src, m.index + m[0].length);
    const lit = /(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g;
    let s;
    while ((s = lit.exec(expr)) !== null) {
      const [, quote, value] = s;
      if (quote === '`' && value.includes('${')) {
        const prefix = value.slice(0, value.indexOf('${'));
        if (prefix.startsWith(ns)) prefixes.add(prefix);
      } else if (value.startsWith(ns)) literals.add(value);
    }
  }
  return { literals: [...literals].sort(), prefixes: [...prefixes].sort() };
}

/** Backticked `<check-id>/<slug>` tokens on a page (own namespace only). A row that
 * documents no id — e.g. a `skipped` finding that never reaches SARIF — yields none. */
export function extractDocumentedRuleIds(body, checkId) {
  const ids = new Set();
  const token = /`([^`\n]+)`/g;
  let m;
  while ((m = token.exec(body)) !== null) {
    const tok = m[1].trim();
    if (!tok.startsWith(`${checkId}/`)) continue;
    if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(tok.slice(checkId.length + 1))) ids.add(tok);
  }
  return [...ids].sort();
}

const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const grab = (text, re) => [...text.matchAll(re)].map((m) => m[1]);
const region = (src, start, end, i = src.indexOf(start), j = src.indexOf(end, i)) =>
  (i === -1 ? '' : src.slice(i, j === -1 ? src.length : j));

/**
 * Value sets for interpolated ids, read back out of the module that builds them.
 * Without these, `sandbox-posture/${rule.id}` reduces to the BARE prefix
 * `sandbox-posture/` and EVERY token on that page passes vacuously. Expanding matches
 * ids exactly, so `governance-docs/missing-tdd` is caught despite sharing a real prefix.
 */
export const EXPANDERS = {
  'governance-docs': (s) => grab(region(s, 'const QUALITY_CHECKS', '\n];'), /name:\s*'([^']+)'/g).map(slugify),
  'sandbox-posture': (s) =>
    grab(region(s, 'const CODEX_RULES', '\n];') + region(s, 'const DENY_RULES', '\n];')
      + region(s, 'const GEMINI_RULES', '\n];') + region(s, 'const OPENCODE_RULES', '\n];')
      + region(s, 'const CURSOR_RULES', '\n];'), /\bid:\s*'([^']+)'/g),
  'ci-agent-caps': (s) => [
    ...grab(s, /\badd\(\s*'([^']+)'/g),
    ...grab(region(s, 'const GAPS', '\n];'), /,\s*'([a-z][a-z0-9-]*)',/g),
  ],
  documentation: (s) => grab(region(s, 'function reasonLabel', '\n}'), /case\s+'([^']+)':/g),
  'skill-files': (s) => grab(region(s, 'const ESCALATION_RULES', '\n];'), /\bid:\s*'([^']+)'/g),
};

/**
 * Compare a page's documented ruleIds against what the module can emit. Only an
 * un-expandable prefix falls back to prefix-matching, and it is reported UNVERIFIED
 * rather than passed silently — "couldn't check" must never look like "checked, fine".
 * A bare `<check-id>/` prefix with no expander is a hard error: every id would pass.
 */
function ruleIdDrift(id, source, body, docPath) {
  const { literals, prefixes } = extractRuleIds(source, id);
  const documented = extractDocumentedRuleIds(body, id);
  const expander = EXPANDERS[id];
  const expanded = expander ? prefixes.flatMap((p) => expander(source).map((v) => p + v)) : [];
  const loose = expander ? [] : prefixes; // prefixes we could not enumerate
  const emitted = [...new Set([...literals, ...expanded])].sort();
  const out = [];

  for (const p of loose.filter((p) => p === `${id}/`)) {
    out.push({ id, ruleId: `${p}\${...}`, reason: 'ruleid-unexpandable', docPath });
  }
  for (const ruleId of documented.filter((d) => !emitted.includes(d))) {
    const via = loose.find((p) => p !== `${id}/` && ruleId.startsWith(p) && ruleId.length > p.length);
    if (via) out.push({ id, ruleId, reason: 'ruleid-unverified', docPath, prefix: via });
    else out.push({ id, ruleId, reason: 'ruleid-ghost', docPath, emitted });
  }
  for (const ruleId of emitted.filter((e) => !documented.includes(e))) {
    out.push({ id, ruleId, reason: 'ruleid-undocumented', docPath });
  }
  return out;
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
    // Falls back to an empty map if the target root has no src/constants.js —
    // this lets verify-docs run against arbitrary fixture or third-party repos
    // that don't ship rigscore's weight registry; weight-drift detection is
    // simply skipped in that case rather than crashing the whole verify pass.
    try {
      const constantsUrl = pathToFileURL(path.join(root, 'src', 'constants.js')).href;
      const mod = await import(constantsUrl);
      weights = mod.WEIGHTS || {};
    } catch {
      weights = {};
    }
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

  // FINDING_IDS.md is rigscore's public stability contract. Read it once, relative
  // to the docs dir so a --cwd/override still resolves it. A repo without one — a
  // plugin or third-party tree reached via the documentation check — simply skips
  // this axis, exactly as the weights fallback above skips weight-drift.
  const findingIdsBody = await readFileSafe(path.join(path.dirname(docsDir), 'FINDING_IDS.md'));

  const offenders = [];
  const ruleIdOffenders = [];
  const findingIdsOffenders = [];

  for (const id of checkIds) {
    const docPath = path.join(docsDir, `${id}.md`);
    const body = await readFileSafe(docPath);
    if (body === null) {
      offenders.push({ id, reason: 'missing', docPath });
      continue;
    }

    const source = await readFileSafe(path.join(checksDir, `${id}.js`));
    if (source !== null) {
      ruleIdOffenders.push(...ruleIdDrift(id, source, body, docPath));

      // Contract coverage: EVERY literal finding id a check emits must be named in
      // FINDING_IDS.md, the public stability contract (SARIF ruleIds, `--ignore <id>`,
      // baseline diffs). Per-NAMESPACE was too coarse — one documented id per check
      // satisfied it, so 39 emitted ids (3 critical, 15 warning) drifted off the page
      // with CI green. Only `literals` are gated, which is exactly why the old
      // dynamic-fragment objection dissolves: interpolated ids arrive as `prefixes`
      // and keep their `<fragment>` shorthand treatment via EXPANDERS, untouched.
      // A check whose ids are ALL dynamic still owes the page a section, so it keeps
      // the namespace-level assertion. Consumes extractRuleIds READ-ONLY; its `<id>/`
      // namespace filter is deliberate (the collision guard depends on it).
      if (findingIdsBody !== null) {
        const { literals, prefixes } = extractRuleIds(source, id);
        const documented = new Set(extractDocumentedRuleIds(findingIdsBody, id));
        for (const ruleId of literals.filter((lit) => !documented.has(lit))) {
          findingIdsOffenders.push({ id, ruleId, reason: 'finding-ids-uncovered' });
        }
        if (literals.length === 0 && prefixes.length > 0 && documented.size === 0) {
          findingIdsOffenders.push({ id, reason: 'finding-ids-uncovered' });
        }
      }
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
    ok:
      offenders.length === 0 &&
      orphans.length === 0 &&
      ruleIdOffenders.length === 0 &&
      findingIdsOffenders.length === 0,
    offenders,
    orphans,
    ruleIdOffenders,
    findingIdsOffenders,
    counts: {
      checks: checkIds.length,
      docs: docIds.length,
      offenders: offenders.length,
      orphans: orphans.length,
      ruleIdOffenders: ruleIdOffenders.length,
      findingIdsOffenders: findingIdsOffenders.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Prose-doc link + registry-count guard.
//
// The per-check gate above keeps docs/checks/*.md in sync with src/checks/*.js.
// The narrative docs (THREAT-MODEL.md, docs/known-limits.md) drift a different
// way: dead source links after a check rename, and hand-copied registry counts
// that go stale when src/clients.js grows. Both are DERIVED from the source of
// truth here so the drift class cannot silently recur — a rename breaks the
// link check, a new client breaks the count check.
// ---------------------------------------------------------------------------

/** Narrative docs (repo-root-relative) that get link-checked. */
export const EXTERNAL_DOC_RELPATHS = ['THREAT-MODEL.md', 'docs/known-limits.md'];

/**
 * Markdown link targets that point at a repo-local file (relative path),
 * fragment-stripped. Skips external URLs (http/https/any `scheme://`), mailto,
 * and pure in-page `#anchor` links — none of those are file-existence checkable.
 */
export function relativeLinkTargets(body) {
  const out = [];
  const re = /\[[^\]]*\]\(([^)]+)\)/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    let target = m[1].trim();
    if (!target || /^(#|mailto:)/i.test(target)) continue;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) continue; // http(s):// and any other scheme
    target = target.split('#')[0].trim(); // drop #anchor fragment
    if (target) out.push(target);
  }
  return out;
}

/**
 * Canonical registry counts, derived from a repo root's src/clients.js — the
 * single source of truth. Dynamic-imports the module (ESM rejects bare relative
 * specifiers, so a file:// URL is required). Throws if the module is absent,
 * which the caller treats as "third-party repo, skip the count guard".
 */
export async function deriveRegistryCounts(root) {
  const clientsUrl = pathToFileURL(path.join(root, 'src', 'clients.js')).href;
  const mod = await import(clientsUrl);
  const clients = mod.CLIENTS || [];
  return {
    clients: clients.length,
    mcpClients: clients.filter((c) => c.mcp && c.mcp.length).length,
    credentialClients: clients.filter((c) => c.credentials && c.credentials.length).length,
    credentialFiles: mod.credentialClients().length,
  };
}

/**
 * Pure count-sentence checks. `texts` maps a repo-relative doc path to its body
 * (absent keys are skipped). `counts` is the derived truth. A vanished anchor
 * sentence is itself an offender: a reword must never silently disable the guard.
 */
export function checkCountSentences(texts, counts) {
  const offenders = [];
  const tm = texts['THREAT-MODEL.md'];
  if (tm != null) {
    const m = tm.match(
      /registry of (\d+) known agent clients \((\d+) with MCP config paths, (\d+) holding (\d+) credential files\)/,
    );
    if (!m) {
      offenders.push({
        doc: 'THREAT-MODEL.md',
        reason: 'count-anchor-missing',
        detail:
          'the "registry of N known agent clients (…)" sentence the count guard keys on was not found — did its wording change?',
      });
    } else {
      const got = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
      const want = [counts.clients, counts.mcpClients, counts.credentialClients, counts.credentialFiles];
      if (want.some((w, i) => w !== got[i])) {
        offenders.push({
          doc: 'THREAT-MODEL.md',
          reason: 'count-drift',
          detail: `registry sentence says ${got.join('/')} (clients/mcp/cred-clients/cred-files); source derives ${want.join('/')}`,
        });
      }
    }
  }
  const cs = texts['docs/checks/credential-storage.md'];
  if (cs != null) {
    const m = cs.match(/currently (\d+) credential-file entries/);
    if (!m) {
      offenders.push({
        doc: 'docs/checks/credential-storage.md',
        reason: 'count-anchor-missing',
        detail: 'the "currently N credential-file entries" sentence the count guard keys on was not found',
      });
    } else if (Number(m[1]) !== counts.credentialFiles) {
      offenders.push({
        doc: 'docs/checks/credential-storage.md',
        reason: 'count-drift',
        detail: `says ${m[1]} credential-file entries; credentialClients() returns ${counts.credentialFiles}`,
      });
    }
  }
  return offenders;
}

/**
 * Verify the narrative docs: every repo-local markdown link resolves to a real
 * file, and every hand-copied registry count matches what src/clients.js derives.
 * `exists` and `importCounts` are injectable for tests. A doc or the registry
 * being absent (a third-party tree reached via --cwd) is a graceful skip, matching
 * the weights/FINDING_IDS fallbacks in verifyCheckDocs().
 */
export async function verifyExternalDocs(opts = {}) {
  const root = path.resolve(opts.root || defaultRoot());
  const exists = opts.exists || ((p) => fs.existsSync(p));
  const importCounts = opts.importCounts || deriveRegistryCounts;

  const linkOffenders = [];
  for (const relDoc of EXTERNAL_DOC_RELPATHS) {
    const abs = path.join(root, relDoc);
    const body = await readFileSafe(abs);
    if (body === null) continue; // doc absent — third-party repo, skip
    const docDir = path.dirname(abs);
    for (const target of relativeLinkTargets(body)) {
      if (!exists(path.resolve(docDir, target))) {
        linkOffenders.push({ doc: relDoc, target, reason: 'dead-link' });
      }
    }
  }

  let counts = null;
  try {
    counts = await importCounts(root);
  } catch {
    counts = null; // no src/clients.js — skip the count guard
  }
  let countOffenders = [];
  if (counts) {
    const texts = {};
    for (const rel of ['THREAT-MODEL.md', 'docs/checks/credential-storage.md']) {
      const b = await readFileSafe(path.join(root, rel));
      if (b !== null) texts[rel] = b;
    }
    countOffenders = checkCountSentences(texts, counts);
  }

  return {
    ok: linkOffenders.length === 0 && countOffenders.length === 0,
    linkOffenders,
    countOffenders,
  };
}

/** Render a human-readable summary of a verifyExternalDocs() result. */
export function formatExternalDocsResult(result) {
  const lines = [];
  for (const { doc, target } of result.linkOffenders || []) {
    lines.push(`docs-gate: DEAD-LINK ${doc} links to \`${target}\`, which does not exist. Fix or remove the link.`);
  }
  for (const { doc, reason, detail } of result.countOffenders || []) {
    const label = reason === 'count-drift' ? 'COUNT-DRIFT' : 'COUNT-ANCHOR-MISSING';
    lines.push(`docs-gate: ${label} ${doc} — ${detail}`);
  }
  return lines.join('\n');
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
  for (const { id, ruleId, reason, prefix, emitted } of result.ruleIdOffenders || []) {
    const doc = `docs/checks/${id}.md`;
    const src = `src/checks/${id}.js`;
    const expander = `Add an expander for ${id} in src/lib/verify-docs.js`;
    if (reason === 'ruleid-ghost') {
      lines.push(
        `docs-gate: RULEID-GHOST ${id} — ${doc} documents \`${ruleId}\`, which ${src} never emits. ` +
          'Rename it to a real id or delete the row.',
        `  ${id} emits: ${emitted.join(', ') || '(none)'}`,
      );
    } else if (reason === 'ruleid-undocumented') {
      lines.push(
        `docs-gate: RULEID-UNDOCUMENTED ${id} — ${src} emits \`${ruleId}\`, but ${doc} never lists it. ` +
          'Add a ## Triggers row for it.',
      );
    } else if (reason === 'ruleid-unverified') {
      lines.push(
        `docs-gate: RULEID-UNVERIFIED ${id} — \`${ruleId}\` only prefix-matches \`${prefix}\${...}\`, whose ` +
          `value set is not statically enumerable, so this id is NOT verified. ${expander} to check it exactly.`,
      );
    } else if (reason === 'ruleid-unexpandable') {
      lines.push(
        `docs-gate: RULEID-UNEXPANDABLE ${id} — emits \`${ruleId}\`, a bare prefix that would make EVERY ` +
          `documented id pass vacuously. ${expander}.`,
      );
    }
  }
  for (const { id, ruleId } of result.findingIdsOffenders || []) {
    lines.push(
      ruleId
        ? `docs-gate: FINDING-IDS-UNCOVERED ${id} — src/checks/${id}.js emits \`${ruleId}\`, but ` +
            `docs/FINDING_IDS.md never names it. Add it under the \`### ${id}\` section.`
        : `docs-gate: FINDING-IDS-UNCOVERED ${id} — src/checks/${id}.js emits finding ids but ` +
            `docs/FINDING_IDS.md documents none of them. Add a \`### ${id}\` section listing them.`,
    );
  }
  if (lines.length === 0) {
    lines.push(`docs-gate: OK (${result.counts.checks} checks, ${result.counts.docs} docs)`);
  } else {
    lines.push('');
    lines.push(
      `docs-gate: ${result.offenders.length} offenders, ${result.orphans.length} orphans, ` +
        `${(result.ruleIdOffenders || []).length} ruleId mismatches, ` +
        `${(result.findingIdsOffenders || []).length} contract gaps across ${result.counts.checks} checks`,
    );
  }
  return lines.join('\n');
}

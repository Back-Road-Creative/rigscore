import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEVERITY_MAP } from '../src/sarif.js';
import {
  extractRuleIds, extractDocumentedRuleIds, verifyCheckDocs, formatVerifyResult,
} from '../src/lib/verify-docs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHECKS_DIR = path.resolve(__dirname, '..', 'src', 'checks');
const ROOT = path.resolve(__dirname, '..');
const FINDING_IDS = fs.readFileSync(path.join(ROOT, 'docs', 'FINDING_IDS.md'), 'utf8');
const REGISTERED_CHECK_IDS = fs.readdirSync(CHECKS_DIR)
  .filter((f) => f.endsWith('.js') && f !== 'index.js')
  .map((f) => path.basename(f, '.js'))
  .sort();

/**
 * NOTE — this file and `extractRuleIds()` in src/lib/verify-docs.js look like
 * duplicate id-harvesters. They are not, and must not be converged:
 *   - `extractRuleIds` answers "which ids does this module emit, *within its own
 *     `<checkId>/` namespace*" (it namespace-filters). That is what the docs gate
 *     needs, and it structurally cannot see cross-module bare-id collisions.
 *   - This file answers two different questions: "which finding *sites* emit no id
 *     at all" and "do two modules emit the same id". Pointing the collision test at
 *     the namespace-filtered extractor would silently delete the collision guard.
 * Keep them separate.
 */

/**
 * Walk from `i` (the index just past an opener) to its matching closer,
 * skipping over strings and comments. Returns the index OF the closer.
 */
function matchClose(source, i, open, close) {
  let depth = 1;
  let inStr = null;
  let inBlockComment = false;
  let inLineComment = false;
  while (i < source.length) {
    const ch = source[i];
    if (inBlockComment) {
      if (ch === '/' && source[i - 1] === '*') inBlockComment = false;
      i++; continue;
    }
    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      i++; continue;
    }
    if (inStr) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === inStr) inStr = null;
      i++; continue;
    }
    if (ch === '/' && source[i + 1] === '*') { inBlockComment = true; i += 2; continue; }
    if (ch === '/' && source[i + 1] === '/') { inLineComment = true; i += 2; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { inStr = ch; i++; continue; }
    if (ch === open) depth++;
    else if (ch === close && --depth === 0) return i;
    i++;
  }
  return i;
}

/**
 * Object literals pushed onto a findings accumulator, as source substrings.
 *
 * The accumulator is NOT always literally named `findings`: site-security.js builds its
 * result in `allFindings` and returns it as `findings:`. Keying off the fixed substring
 * `'findings.push({'` was blind to those sites — and a blind extractor yields no blocks,
 * hence no offenders, hence a green guard that reports success because it saw nothing.
 * Match any accumulator whose name ends in `findings`/`Findings` instead.
 *
 * Deliberately NOT any `<ident>.push({`: most of those in src/checks/ (`stack`, `files`,
 * `out`, `configs`, …) are plain data structures, not findings, and would be pure false
 * positives. Helpers that are spread in (`findings.push(...checkFoo(f))`) accumulate into
 * their own local `findings` array, so their sites are already covered.
 */
function extractFindingsPushBlocks(source) {
  const blocks = [];
  const patt = /(?:^|[^A-Za-z0-9_$])[A-Za-z0-9_$]*[Ff]indings\.push\(\s*\{/g;
  let m;
  while ((m = patt.exec(source)) !== null) {
    const start = m.index + m[0].length; // index just past the '{'
    const end = matchClose(source, start, '{', '}');
    blocks.push(source.slice(start, end));
    patt.lastIndex = end + 1;
  }
  return blocks;
}

/**
 * Object literals declared as an INLINE array — `findings: [{ ... }]`, the shape
 * every check uses for its NOT_APPLICABLE early-return. These never pass through
 * `findings.push(...)`, so a push-only scan is structurally blind to them. That
 * blind spot is not cosmetic: an `info` finding maps to SARIF level `note` (it is
 * NOT dropped — only `pass`/`skipped` are), so an id-less one still reaches SARIF
 * carrying a ruleId that src/sarif.js silently slugifies from its *title*. Reword
 * the title, and every consumer's `--ignore <ruleId>` breaks.
 */
function extractInlineFindingsBlocks(source) {
  const blocks = [];
  const anchor = /(?:^|[\s,{(])findings\s*:\s*\[/g;
  let m;
  while ((m = anchor.exec(source)) !== null) {
    const arrStart = m.index + m[0].length;
    const arrEnd = matchClose(source, arrStart, '[', ']');
    let i = arrStart;
    let inStr = null;
    while (i < arrEnd) {
      const ch = source[i];
      if (inStr) {
        if (ch === '\\') { i += 2; continue; }
        if (ch === inStr) inStr = null;
        i++; continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') { inStr = ch; i++; continue; }
      if (ch === '{') {
        const objEnd = matchClose(source, i + 1, '{', '}');
        blocks.push(source.slice(i + 1, objEnd));
        i = objEnd + 1;
        continue;
      }
      i++;
    }
    anchor.lastIndex = arrEnd;
  }
  return blocks;
}

/**
 * Extract severity literal from an object-literal source fragment.
 * Returns the raw value ('critical' / 'warning' / ...) or null if the
 * severity is a non-literal expression (e.g. `severity: result.severity`).
 */
function extractSeverity(body) {
  const m = body.match(/severity:\s*(['"`])([^'"`]+)\1/);
  if (m) return m[2];
  // Handle ternaries with two string branches — return a sentinel so the
  // caller knows the severity is dynamic but still evaluated from literals.
  const tern = body.match(/severity:\s*[^,}]+\?\s*(['"`])([^'"`]+)\1\s*:\s*(['"`])([^'"`]+)\3/);
  if (tern) return `${tern[2]}|${tern[4]}`;
  return null;
}

function hasFindingId(body) {
  // Match both `findingId: '...'` and ES6 shorthand `findingId,` / `findingId\n`.
  // The property name must be a whole token (not `myFindingId`).
  return /(^|[\s,{])findingId(\s*:|\s*,|\s*\n|\s*\})/.test(body);
}

/**
 * A finding reaches SARIF iff its severity maps to a level other than `none` —
 * `formatSarif` drops `level === 'none'` and nothing else. Read the mapping from
 * src/sarif.js rather than hardcoding {pass, skipped} here, so a severity added to
 * SARIF later cannot drift past this gate. A severity that isn't a plain literal
 * (e.g. `severity: result.severity`) is treated as reaching SARIF — conservative.
 */
function reachesSarif(sev) {
  if (!sev) return true;
  return sev.split('|').some((s) => (SEVERITY_MAP[s] || 'none') !== 'none');
}

/**
 * Scan every check module for finding sites — `findings.push({...})` AND inline
 * `findings: [{...}]` array literals — that lack a findingId on a finding which
 * reaches SARIF.
 *
 * Plugins are not in scope — only built-in checks under src/checks/.
 */
function scanAllChecks() {
  const files = fs.readdirSync(CHECKS_DIR).filter(
    (f) => f.endsWith('.js') && f !== 'index.js',
  );
  const offenders = [];
  const stats = {};

  for (const file of files) {
    const src = fs.readFileSync(path.join(CHECKS_DIR, file), 'utf8');
    const blocks = [...extractFindingsPushBlocks(src), ...extractInlineFindingsBlocks(src)];
    let missing = 0;
    let skipped = 0;
    let ided = 0;
    for (const body of blocks) {
      if (!reachesSarif(extractSeverity(body))) { skipped++; continue; }
      if (hasFindingId(body)) { ided++; continue; }
      missing++;
      // Extract a short excerpt for the failure message.
      const excerpt = body.slice(0, 160).replace(/\s+/g, ' ').trim();
      offenders.push(`${file}: ${excerpt}`);
    }
    stats[file] = { total: blocks.length, ided, missing, skipped };
  }

  return { offenders, stats };
}

describe('E4: every SARIF-reaching finding emits an explicit findingId', () => {
  it('covers every built-in check module', () => {
    const { offenders } = scanAllChecks();
    expect(
      offenders,
      `finding sites without findingId (their SARIF ruleId would be silently derived from the title):\n${offenders.join('\n')}`,
    ).toHaveLength(0);
  });

  /**
   * ANCHOR 1 — the guard above compares a DERIVED set (finding sites the extractors
   * can see) against a rule (each must carry a findingId). A module the extractors
   * cannot see contributes zero sites, therefore zero offenders, therefore green —
   * the guard reports success precisely because it saw nothing. `scanAllChecks`
   * already computes the per-file block count and then throws it away; assert on it.
   *
   * The global `seen.size > 50` anchor in the no-collision test below is NOT a
   * substitute: it is computed from a different derivation (findingId regexes, not
   * parsed blocks) and it is global, so a single module going invisible to the block
   * extractors leaves it comfortably above 50 and green.
   */
  it('ANCHOR: the extractors see finding sites in EVERY check module', () => {
    const { stats } = scanAllChecks();
    const files = Object.keys(stats);
    expect(files.length).toBeGreaterThan(20);

    const blind = files.filter((f) => stats[f].total === 0);
    expect(
      blind,
      'the extractors found ZERO finding sites in these modules, so the coverage guard ' +
        'above is structurally blind to them and would stay green no matter what they ' +
        `emit:\n${blind.join('\n')}`,
    ).toEqual([]);
  });

  /**
   * ANCHOR 2 — a positive control. Anchor 1 proves the extractors see *something* in
   * each module; it cannot prove they would CATCH an id-less finding. Run them over a
   * synthetic module carrying every emission shape that ships in src/checks/ and assert
   * both that each shape is parsed and that the id-less ones are flagged. Without this,
   * an extractor that quietly stopped recognising a shape would still pass anchor 1 on
   * the strength of the shapes it still sees.
   *
   * The `allFindings.push({...})` line is not hypothetical: site-security.js accumulates
   * into `allFindings` and returns it as `findings:`. An id-less finding there reaches
   * SARIF with a ruleId that src/sarif.js slugifies from its TITLE — reword the title and
   * every consumer's `--ignore <ruleId>` silently breaks.
   */
  it('ANCHOR: the extractors actually catch an id-less finding (positive control)', () => {
    const synthetic = [
      "const findings = []; const allFindings = [];",
      "findings.push({ findingId: 'demo/has-id', severity: 'warning', title: 'Has an id' });",
      "allFindings.push({ severity: 'warning', title: 'Missing HSTS header' });",
      "return { score: 100, findings: [{ severity: 'info', title: 'Inline, no id' }] };",
    ].join('\n');

    const blocks = [
      ...extractFindingsPushBlocks(synthetic),
      ...extractInlineFindingsBlocks(synthetic),
    ];
    expect(blocks, 'an emission shape that ships in src/checks/ was not parsed').toHaveLength(3);

    const idless = blocks
      .filter((b) => reachesSarif(extractSeverity(b)) && !hasFindingId(b))
      .map((b) => (b.match(/title:\s*['"`]([^'"`]+)/) || [])[1]);
    expect(idless.sort()).toEqual(['Inline, no id', 'Missing HSTS header']);
  });

  it('no two modules emit the same findingId (no-collision)', () => {
    const files = fs.readdirSync(CHECKS_DIR).filter(
      (f) => f.endsWith('.js') && f !== 'index.js',
    );
    const seen = new Map(); // id → file

    for (const file of files) {
      const src = fs.readFileSync(path.join(CHECKS_DIR, file), 'utf8');
      const moduleIds = new Set();

      // Static string literal IDs
      const staticRe = /findingId:\s*['"]([^'"]+)['"]/g;
      let m;
      while ((m = staticRe.exec(src)) !== null) moduleIds.add(m[1]);

      // Static template literal IDs (no ${...} interpolation)
      const tplRe = /findingId:\s*`([^`$]+)`/g;
      while ((m = tplRe.exec(src)) !== null) moduleIds.add(m[1]);

      // Template literals that start with `<check-id>/` — record the prefix.
      // We only flag collisions on the fully-static prefix part, which is
      // enough to guarantee no <check-a>/foo collides with <check-b>/foo.
      const tplPrefixRe = /findingId:\s*`([^`]*?)\$\{/g;
      while ((m = tplPrefixRe.exec(src)) !== null) moduleIds.add(m[1] + '*');

      // Ternary IDs: findingId: cond ? '...' : '...'
      const ternRe = /findingId:\s*[^,}]+\?\s*['"]([^'"]+)['"]\s*:\s*['"]([^'"]+)['"]/g;
      while ((m = ternRe.exec(src)) !== null) {
        moduleIds.add(m[1]);
        moduleIds.add(m[2]);
      }

      for (const id of moduleIds) {
        if (seen.has(id) && seen.get(id) !== file) {
          // Cross-module duplicate — flag.
          // mcp-config and claude-settings intentionally both emit
          // `mcp-config/mcp-auto-approve-enabled` vs
          // `claude-settings/mcp-auto-approve-enabled` — these are
          // different IDs (different prefix) so they don't collide.
          throw new Error(
            `Duplicate findingId "${id}" in ${file} and ${seen.get(id)}`,
          );
        }
        seen.set(id, file);
      }
    }
    // Also sanity-check that at least one ID was found (guards against a
    // future refactor that silently drops all IDs).
    expect(seen.size).toBeGreaterThan(50);
  });
});

/**
 * docs/FINDING_IDS.md calls itself a stability contract — "which IDs the current
 * release actually guarantees". Consumers pin `--ignore <check>/<slug>`, SARIF→GHAS
 * and baseline diffs to it, yet nothing gated it, so it silently drifted to
 * documenting 21 of 27 checks. This block is that gate's TDD spec.
 *
 * It CONSUMES the exported extractRuleIds / extractDocumentedRuleIds — it never
 * reaches into their `<checkId>/` namespace filter (the collision guard above
 * depends on that filter; loosening it is a settled "won't do").
 *
 * Granularity is per-CHECK-NAMESPACE, not per-finding-id, and deliberately so: the
 * page documents dynamic-fragment ids via `<category>`/`<reason>`/`<patternId>`
 * shorthands and omits degenerate internal ids (mcp-config/no-config-found, …),
 * both of which a per-id gate would false-flag on ~15 already-documented checks.
 * A whole check absent from the contract is the drift that actually happened.
 */
describe('FINDING_IDS.md is a complete, gated stability contract', () => {
  const emitsIds = (id) => {
    const src = fs.readFileSync(path.join(CHECKS_DIR, `${id}.js`), 'utf8');
    const { literals, prefixes } = extractRuleIds(src, id);
    return literals.length > 0 || prefixes.length > 0;
  };
  const uncovered = () => REGISTERED_CHECK_IDS.filter(
    (id) => emitsIds(id) && extractDocumentedRuleIds(FINDING_IDS, id).length === 0,
  );

  it('documents a finding-id namespace for every check that emits ids', () => {
    expect(
      uncovered(),
      'these checks emit finding ids but FINDING_IDS.md documents NONE of them — a ' +
        'consumer pinning --ignore/SARIF/baselines to them is flying blind',
    ).toEqual([]);
  });

  it('verifyCheckDocs() gates verify:docs on that coverage (not vacuously)', async () => {
    const result = await verifyCheckDocs({ root: ROOT });
    // The gate must see exactly the contract spec above: proves it is wired, and
    // that a bare [] is real coverage, not a gate blind to the whole page.
    expect((result.findingIdsOffenders || []).map((o) => o.id).sort()).toEqual(uncovered());
    // A complete contract leaves this axis of the gate green.
    expect(result.findingIdsOffenders || []).toEqual([]);
  });

  it('formatVerifyResult prints an actionable line for an uncovered check', () => {
    const out = formatVerifyResult({
      offenders: [], orphans: [], ruleIdOffenders: [],
      findingIdsOffenders: [{ id: 'spec-goals', reason: 'finding-ids-uncovered' }],
      counts: { checks: 27, docs: 27 },
    });
    expect(out).toContain('FINDING-IDS-UNCOVERED spec-goals');
    expect(out).toContain('### spec-goals');
  });
});

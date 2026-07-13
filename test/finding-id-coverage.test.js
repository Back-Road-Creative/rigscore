import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEVERITY_MAP } from '../src/sarif.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHECKS_DIR = path.resolve(__dirname, '..', 'src', 'checks');

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
 * Object literals passed to `findings.push({...})`, as source substrings.
 */
function extractFindingsPushBlocks(source) {
  const blocks = [];
  const patt = 'findings.push({';
  let i = 0;
  while (i < source.length) {
    const idx = source.indexOf(patt, i);
    if (idx === -1) break;
    const start = idx + patt.length;
    const end = matchClose(source, start, '{', '}');
    blocks.push(source.slice(start, end));
    i = end + 1;
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

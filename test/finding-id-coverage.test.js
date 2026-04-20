import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHECKS_DIR = path.resolve(__dirname, '..', 'src', 'checks');

/**
 * Naive balanced-brace scan: extract every object literal passed to
 * `findings.push({...})` as a source substring. Good enough for pattern
 * checks on well-formatted source — rigscore's check modules use a
 * consistent `findings.push({\n  severity:` style.
 */
function extractFindingsPushBlocks(source) {
  const blocks = [];
  const patt = 'findings.push({';
  let i = 0;
  while (i < source.length) {
    const idx = source.indexOf(patt, i);
    if (idx === -1) break;
    i = idx + patt.length;
    let depth = 1;
    let j = i;
    let inStr = null;
    let inBlockComment = false;
    let inLineComment = false;
    while (j < source.length && depth > 0) {
      const ch = source[j];
      if (inBlockComment) {
        if (ch === '/' && source[j - 1] === '*') inBlockComment = false;
        j++; continue;
      }
      if (inLineComment) {
        if (ch === '\n') inLineComment = false;
        j++; continue;
      }
      if (inStr) {
        if (ch === '\\') { j += 2; continue; }
        if (ch === inStr) inStr = null;
        j++; continue;
      }
      if (ch === '/' && source[j + 1] === '*') { inBlockComment = true; j += 2; continue; }
      if (ch === '/' && source[j + 1] === '/') { inLineComment = true; j += 2; continue; }
      if (ch === "'" || ch === '"' || ch === '`') { inStr = ch; j++; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      j++;
    }
    blocks.push(source.slice(i, j - 1));
    i = j;
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
 * Scan every check module for findings.push sites that lack a findingId
 * on a non-pass / non-skipped finding.
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
    const blocks = extractFindingsPushBlocks(src);
    let missing = 0;
    let skipped = 0;
    let ided = 0;
    for (const body of blocks) {
      const sev = extractSeverity(body);
      const isPassOrSkipped =
        sev === 'pass' || sev === 'skipped' ||
        (sev && sev.includes('|') && sev.split('|').every((s) => s === 'pass' || s === 'skipped'));
      if (isPassOrSkipped) { skipped++; continue; }
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

describe('E4: every non-pass finding emits an explicit findingId', () => {
  it('covers every built-in check module', () => {
    const { offenders } = scanAllChecks();
    expect(offenders, `findings.push without findingId:\n${offenders.join('\n')}`).toHaveLength(0);
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

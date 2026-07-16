import { calculateCheckScore } from './scoring.js';
import { NOT_APPLICABLE_SCORE, WEIGHTS } from './constants.js';
import { slugify } from './utils.js';

/**
 * Recalculate a check's score after findings were removed from it — unless the
 * check is NOT-APPLICABLE, which stays N/A no matter what is removed.
 *
 * N/A is a property of the *project* ("this repo has no MCP config"), not of
 * the finding list. Several weight-bearing checks report N/A **and** attach a
 * cosmetic "nothing here" INFO. Recalculating such a check hits
 * `calculateCheckScore([]) === 100`, flipping it -1 → 100 and handing its full
 * weight to `calculateOverallScore`'s applicable-coverage set — coverage the
 * project never earned. That inverts the stated invariant in scoring.js:
 * "ignoring N/A checks entirely rewards under-configured projects for being
 * invisible to the scanner."
 */
function rescoreAfterRemoval(result) {
  if (result.score === NOT_APPLICABLE_SCORE) return;
  result.score = calculateCheckScore(result.findings);
}

// Re-export slugify so legacy paths can pull it from findings.js if needed.
export { slugify };

/**
 * Check-id / finding-id renames: old id → current id.
 *
 * docs/FINDING_IDS.md promises a deprecated id stays a working alias for at
 * least one major version, so a user's `.rigscorerc.json` `suppress:` (or a
 * baseline) does not silently dead-match on upgrade. This table is that
 * promise's implementation: `compileSuppressPattern` consults it so a pattern
 * naming an old id also mutes the renamed finding. Empty today — no rename has
 * shipped — but a future rename adds ONE entry here instead of quietly breaking
 * every downstream suppress config. Keys/values match case-insensitively.
 * @type {Record<string,string>}
 */
export const FINDING_ID_RENAMES = {
  // 'old-check-or-finding-id': 'current-check-or-finding-id',
};

/**
 * Deduplicate findings across check results.
 * When two checks produce findings with the same severity+title,
 * keep the one from the higher-weighted check.
 *
 * After splicing a finding out of a result's findings array, we
 * recalculate that result's score so stale pre-dedup scores don't
 * stick (matches the behavior of suppressFindings).
 */
export function deduplicateFindings(results) {
  // key → Map<resultIdx, { weight, findingIndices: number[] }>
  // Tracking all per-result findings (not just one) closes the variant-leak
  // bug where a losing check with N per-file variants only got 1 removed.
  const seen = new Map();
  const toRemove = [];

  for (let ri = 0; ri < results.length; ri++) {
    const r = results[ri];
    const weight = WEIGHTS[r.id] || 0;
    const findings = r.findings || [];

    for (let fi = findings.length - 1; fi >= 0; fi--) {
      const f = findings[fi];
      if (!f.title || f.severity === 'pass' || f.severity === 'info') continue;

      // Normalize: strip file paths and trailing details for comparison
      const normalized = f.title.replace(/\s+in\s+\S+$/, '').replace(/:\s+\S+$/, '').trim();
      const key = `${f.severity}:${normalized}`;

      if (!seen.has(key)) {
        seen.set(key, new Map());
      }
      const byResult = seen.get(key);

      // Same check — preserve both. Within-check findings that normalize to
      // the same key are per-file variants (e.g., one finding per skill file
      // hitting a pattern); collapsing them hides real triage signal.
      if (byResult.has(ri)) {
        byResult.get(ri).findingIndices.push(fi);
        continue;
      }

      // Cross-check — find the current best weight already recorded.
      let maxWeight = -Infinity;
      for (const info of byResult.values()) {
        if (info.weight > maxWeight) maxWeight = info.weight;
      }

      if (weight >= maxWeight) {
        // Current check wins (ties go to current, matching the prior
        // `weight >= prev.weight` behavior). Sweep every losing result's
        // findings — including all per-file variants — into toRemove.
        for (const [prevRi, info] of [...byResult]) {
          if (info.weight <= weight) {
            for (const prevFi of info.findingIndices) {
              toRemove.push({ resultIdx: prevRi, findingIdx: prevFi });
            }
            byResult.delete(prevRi);
          }
        }
        byResult.set(ri, { weight, findingIndices: [fi] });
      } else {
        toRemove.push({ resultIdx: ri, findingIdx: fi });
      }
    }
  }

  // Group by resultIdx, sort findingIdx descending, then splice safely.
  // Sorting descending prevents earlier removals from shifting indices of
  // later removals within the same result.
  const grouped = new Map();
  for (const { resultIdx, findingIdx } of toRemove) {
    if (!grouped.has(resultIdx)) grouped.set(resultIdx, []);
    grouped.get(resultIdx).push(findingIdx);
  }
  for (const [ri, indices] of grouped) {
    indices.sort((a, b) => b - a);
    for (const fi of indices) {
      results[ri].findings.splice(fi, 1);
    }
    // Recalculate this result's score so stale pre-dedup scores don't stick
    // (matches the behavior of suppressFindings) — but never promote an N/A
    // check into coverage. Defensive here: dedup skips info/pass findings and
    // no current check returns N/A alongside a warning/critical, so there is
    // no known live trigger. The guard keeps the two removal paths consistent.
    rescoreAfterRemoval(results[ri]);
  }
}

/**
 * Assign findingId to all findings that don't already have one.
 * Convention: {checkId}/{slugified-title}
 */
export function assignFindingIds(results) {
  for (const r of results) {
    for (const f of r.findings) {
      if (!f.findingId) {
        f.findingId = `${r.id}/${slugify(f.title || 'unknown')}`;
      }
    }
  }
}

/**
 * Convert a glob pattern to a case-insensitive RegExp.
 * Supports `*` (any sequence except "/") and `**` (any sequence including "/").
 * Escapes regex metacharacters.
 */
export function globToRegExp(glob) {
  const re = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '__GLOBSTAR__')
    .replace(/\*/g, '[^/]*')
    .replace(/__GLOBSTAR__/g, '.*');
  return new RegExp(`^${re}$`, 'i');
}

/**
 * Compile a user-supplied suppress pattern into a predicate.
 *
 * Three supported forms:
 *   - `re:/<pattern>/[flags]`  → regex against findingId or title
 *   - `<string>/<wildcard>`    → glob against findingId (contains `*`)
 *   - `<string>`               → exact findingId match, bare check-id
 *                                namespace match (`<bare>/…`), OR
 *                                case-insensitive substring match against
 *                                title (legacy)
 *
 * `renames` (default FINDING_ID_RENAMES) lets a pattern naming a renamed id
 * still mute the current finding — the alias promise in docs/FINDING_IDS.md.
 */
export function compileSuppressPattern(raw, renames = FINDING_ID_RENAMES) {
  const str = String(raw);

  // Regex form: re:/pattern/flags
  if (str.startsWith('re:/')) {
    const last = str.lastIndexOf('/');
    if (last > 3) {
      const body = str.slice(4, last);
      const flags = str.slice(last + 1) || '';
      try {
        const re = new RegExp(body, flags.includes('i') ? flags : flags + 'i');
        return (finding) => re.test(finding.findingId || '') || re.test(finding.title || '');
      } catch {
        // Malformed regex — fall through to substring match for safety
      }
    }
  }

  // Glob form: any `*` character present
  if (str.includes('*')) {
    const re = globToRegExp(str);
    return (finding) => re.test(finding.findingId || '');
  }

  // Legacy form: exact findingId, bare check-id namespace, or title substring.
  // `id.startsWith(lowered + '/')` mutes a whole check (documented in
  // docs/FINDING_IDS.md) — the trailing '/' anchors on the exact check
  // segment, so a bare token can never leak into a longer check id (e.g.
  // `docker` cannot match `docker-security/…`).
  const lowered = str.toLowerCase();
  // A pattern naming a renamed id must still mute the current finding: match the
  // token AND its rename target (see FINDING_ID_RENAMES).
  const aliases = [lowered];
  const renamed = renames && renames[lowered];
  if (renamed) aliases.push(String(renamed).toLowerCase());
  return (finding) => {
    const id = (finding.findingId || '').toLowerCase();
    const title = (finding.title || '').toLowerCase();
    return aliases.some((a) => id === a || id.startsWith(a + '/') || title.includes(a));
  };
}

/**
 * Suppress findings matching any of the given patterns.
 *
 * Supports three pattern forms (see compileSuppressPattern above):
 *  - Regex form     — prefix "re:" + a /body/flags literal.
 *  - Glob form      — any string containing "*".
 *  - Substring form — plain string matched as exact findingId or
 *                     case-insensitive title substring.
 *
 * Matching is case-insensitive (regex defaults to /i). Recalculates each
 * affected check's score after removal — EXCEPT a NOT-APPLICABLE check, which
 * stays N/A (see rescoreAfterRemoval). Muting a finding can clean up a check's
 * score; it can never make an inapplicable check count as coverage.
 *
 * Returns a `{ count, ids, unmatched }` summary of what was muted so callers can
 * surface it (human report / SARIF / JSON) — suppression stays a
 * delete-from-scoring, but a muted finding is now visible in rigscore's own
 * output, not only in a `.rigscorerc.json` diff. `count` is every finding
 * removed; `ids` is the deduped list of their finding ids (title fallback for
 * id-less findings); `unmatched` is the input patterns that matched NOTHING — a
 * typo, or a config left stale after a rename — so the caller can warn instead
 * of letting a dead suppress no-op silently.
 */
export function suppressFindings(results, patterns, renames = FINDING_ID_RENAMES) {
  const summary = { count: 0, ids: [], unmatched: [] };
  if (!patterns || patterns.length === 0) return summary;

  const predicates = patterns.map((p) => compileSuppressPattern(p, renames));
  const matched = new Array(patterns.length).fill(false);
  const seenIds = new Set();

  for (const r of results) {
    const before = r.findings.length;
    const kept = [];
    for (const f of r.findings) {
      let hit = false;
      for (let i = 0; i < predicates.length; i++) {
        if (predicates[i](f)) { hit = true; matched[i] = true; }
      }
      if (hit) {
        summary.count++;
        const id = f.findingId || f.title;
        if (id && !seenIds.has(id)) {
          seenIds.add(id);
          summary.ids.push(id);
        }
      } else {
        kept.push(f);
      }
    }
    r.findings = kept;
    if (r.findings.length !== before) {
      rescoreAfterRemoval(r);
    }
  }

  summary.unmatched = patterns.filter((_, i) => !matched[i]).map(String);
  return summary;
}

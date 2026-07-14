import fs from 'node:fs';
import YAML from 'yaml';

/**
 * config-merge — the Phase-2 keystone: safely MERGE hardening keys INTO an
 * existing LLM-env config without destroying the user's content. Unlike a pack
 * install (scaffolds NEW files, skips any dest that exists) this edits a config
 * that ALREADY exists, in place. Doctrine (consistent with fixer.js "never
 * modifies governance content"):
 *   - Additive, never destructive. Absent paths are added; a key already holding
 *     a DIFFERENT value is left untouched and reported as a conflict. (A future
 *     opt-in flag may allow overwrite; the default never destroys.)
 *   - Idempotent. Merging the same hardening twice makes no change the 2nd pass.
 *   - Array policy: union-by-value. Hardening items absent from the user's array
 *     are appended (existing first, then new); user entries are never dropped or
 *     reordered. One policy, every call.
 *   - Pure core. mergeConfig() never touches disk; writeMerged() is the only writer.
 *
 * Formats: JSON (native; re-serialized at a stable 2-space indent + trailing
 * newline to match the repo's config style) and YAML (via the `yaml` package's
 * Document API so comments and key order survive the round-trip). TOML is
 * DEFERRED by construction — not faked: rigscore ships no round-trip TOML parser
 * (prod deps are only chalk + yaml; sandbox-posture.js has a targeted key-READER,
 * not a serializer). Codex is the only TOML client; its fixers are a documented
 * follow-up needing a targeted line-editor. A `format:'toml'` call fails explicitly.
 */

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const stable = (v) =>
  isPlainObject(v)
    ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`
    : JSON.stringify(v);
const deepEqual = (a, b) => stable(a) === stable(b);

/**
 * Walk `hardening` against `existing` (plain objects), collecting the mutations
 * needed and the conflicts to leave alone. Recurses into matching object subtrees;
 * unions matching arrays; treats any other key as add-if-absent / conflict-if-different.
 */
function plan(existing, hardening, base, sets, appends, conflicts) {
  for (const key of Object.keys(hardening)) {
    const incoming = hardening[key];
    const p = [...base, key];
    const pathStr = p.join('.');
    if (!Object.prototype.hasOwnProperty.call(existing, key)) {
      sets.push({ path: pathStr, keys: p, value: incoming });
      continue;
    }
    const cur = existing[key];
    if (isPlainObject(cur) && isPlainObject(incoming)) {
      plan(cur, incoming, p, sets, appends, conflicts);
    } else if (Array.isArray(cur) && Array.isArray(incoming)) {
      const missing = incoming.filter((i) => !cur.some((e) => deepEqual(e, i)));
      if (missing.length) appends.push({ path: pathStr, keys: p, items: missing });
    } else if (!deepEqual(cur, incoming)) {
      conflicts.push({ path: pathStr, existing: cur, incoming });
    }
  }
}

const failure = (error) => ({ ok: false, text: null, changed: false, additions: [], conflicts: [], error });

function parseExisting(text, format) {
  const empty = text == null || String(text).trim() === '';
  if (format === 'json') {
    if (empty) return { obj: {} };
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      return { error: `invalid JSON: ${err.message}` };
    }
    if (parsed == null) return { obj: {} };
    if (!isPlainObject(parsed)) return { error: 'top-level config is not an object; cannot merge' };
    return { obj: parsed };
  }
  if (format === 'yaml') {
    const doc = YAML.parseDocument(empty ? '' : text);
    if (doc.errors.length) return { error: `invalid YAML: ${doc.errors[0].message}` };
    const obj = doc.toJS() ?? {};
    if (!isPlainObject(obj)) return { error: 'top-level config is not a mapping; cannot merge' };
    return { obj, doc };
  }
  return { error: `format "${format}" is not supported (TOML is deferred — see module doc)` };
}

/** Apply sets/appends to a cloned plain object and serialize as stable JSON. */
function renderJson(existing, sets, appends) {
  const obj = structuredClone(existing);
  for (const { keys, value } of sets) {
    let o = obj;
    for (let i = 0; i < keys.length - 1; i++) {
      if (!isPlainObject(o[keys[i]])) o[keys[i]] = {};
      o = o[keys[i]];
    }
    o[keys[keys.length - 1]] = value;
  }
  for (const { keys, items } of appends) {
    let o = obj;
    for (let i = 0; i < keys.length - 1; i++) o = o[keys[i]];
    o[keys[keys.length - 1]] = [...o[keys[keys.length - 1]], ...items];
  }
  return `${JSON.stringify(obj, null, 2)}\n`;
}

/** Apply sets/appends to the yaml Document (comment/order preserving) and serialize. */
function renderYaml(doc, sets, appends) {
  for (const { keys, value } of sets) doc.setIn(keys, doc.createNode(value));
  for (const { keys, items } of appends) {
    const seq = doc.getIn(keys);
    for (const item of items) seq.add(doc.createNode(item));
  }
  return doc.toString();
}

/**
 * Deep-merge `hardening` (a plain object) into `existingText` and re-serialize.
 * `opts.format` is 'json' (default) or 'yaml'. Returns { ok, text, changed,
 * additions:[{path,kind:'add'|'append',...}], conflicts:[keys left at the user's
 * value], error }. Never throws; malformed input yields ok:false / text:null.
 */
export function mergeConfig(existingText, hardening, opts = {}) {
  const format = opts.format || 'json';
  if (!isPlainObject(hardening)) return failure('hardening must be a plain object');
  const parsed = parseExisting(existingText, format);
  if (parsed.error) return failure(parsed.error);

  const sets = [];
  const appends = [];
  const conflicts = [];
  plan(parsed.obj, hardening, [], sets, appends, conflicts);

  const changed = sets.length + appends.length > 0;
  let text;
  try {
    text = format === 'yaml' ? renderYaml(parsed.doc, sets, appends) : renderJson(parsed.obj, sets, appends);
  } catch (err) {
    return failure(`serialization failed: ${err.message}`);
  }
  const additions = [
    ...sets.map((s) => ({ path: s.path, kind: 'add', value: s.value })),
    ...appends.map((a) => ({ path: a.path, kind: 'append', items: a.items })),
  ];
  return { ok: true, text, changed, additions, conflicts, error: null };
}

/** Infer the merge format from a file extension; JSON is the default. */
export function formatForPath(filePath) {
  return /\.ya?ml$/i.test(filePath) ? 'yaml' : /\.toml$/i.test(filePath) ? 'toml' : 'json';
}

/**
 * Explicit, opt-in write: persist only when the merge succeeds AND changed
 * something (an unchanged/failed merge leaves the file byte-for-byte alone).
 * Reads the file if present, else merges into empty. Returns mergeConfig's result.
 */
export function writeMerged(filePath, hardening, opts = {}) {
  const format = opts.format || formatForPath(filePath);
  let existingText = '';
  try {
    existingText = fs.readFileSync(filePath, 'utf8');
  } catch {
    existingText = '';
  }
  const result = mergeConfig(existingText, hardening, { format });
  if (result.ok && result.changed) fs.writeFileSync(filePath, result.text, 'utf8');
  return result;
}

/** Human-readable dry-run summary of what a merge would (or did) change. */
export function summarizeMerge(result) {
  if (!result.ok) return `merge failed: ${result.error}`;
  const lines = [];
  for (const a of result.additions) {
    lines.push(a.kind === 'append' ? `+ append ${a.path}: ${JSON.stringify(a.items)}` : `+ add ${a.path}`);
  }
  for (const c of result.conflicts) {
    lines.push(`~ conflict ${c.path}: kept ${JSON.stringify(c.existing)} (skipped ${JSON.stringify(c.incoming)})`);
  }
  if (lines.length === 0) lines.push('no changes (already hardened)');
  return lines.join('\n');
}

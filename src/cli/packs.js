import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { mergeConfig, formatForPath } from '../lib/config-merge.js';
import { toPosix } from '../utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Packs live here. A pack is any directory holding a pack.json — there is no registry. */
export const TEMPLATES_DIR = path.resolve(__dirname, '..', '..', 'templates');

const HOOKS = '.git/hooks';
const HOOK_DIR_RE = /^(\.git\/hooks|\.githooks)\//;
const isText = (v) => typeof v === 'string' && v.trim().length > 0;
// A dest outside the target repo is a bug or an attack. Reject both, before any write.
const escapes = (d) => path.isAbsolute(d) || d.split(/[\\/]/).includes('..');
// A hook without +x is inert, yet still scores green on presence. Hook dests get it
// automatically; any other file can ask via "exec": true.
const isExec = (f) => f.exec === true || HOOK_DIR_RE.test(toPosix(f.dest));
const fail = (name, msg) => { throw new Error(`pack "${name}": ${msg}`); };

// Auto-discovered like src/checks: readdir. Dropping in templates/<name>/pack.json IS the
// registration step — no list to edit.
export function listPacks(templatesDir = TEMPLATES_DIR) {
  try {
    return fs.readdirSync(templatesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(templatesDir, e.name, 'pack.json')))
      .map((e) => e.name).sort();
  } catch { return []; }
}

// Validate loudly: a pack that half-installs is worse than one that refuses to.
export function loadPack(name, templatesDir = TEMPLATES_DIR) {
  const dir = path.join(templatesDir, name);
  let m;
  try {
    m = JSON.parse(fs.readFileSync(path.join(dir, 'pack.json'), 'utf-8'));
  } catch (err) {
    fail(name, `unreadable pack.json (${err.message})`);
  }
  if (m === null || typeof m !== 'object' || Array.isArray(m)) fail(name, 'pack.json must be an object');
  if (m.name !== name) fail(name, `"name" must equal the directory name (got "${m.name}")`);
  if (!isText(m.description)) fail(name, 'missing "description"');
  if (!Array.isArray(m.checks) || !m.checks.every(isText)) fail(name, '"checks" must be an array of check ids');
  if (!Array.isArray(m.files) || m.files.length === 0) fail(name, '"files" must be a non-empty array');
  for (const f of m.files) {
    if (f === null || typeof f !== 'object') fail(name, 'each files[] entry must be an object');
    if (!isText(f.src)) fail(name, 'each files[] entry needs a non-empty "src"');
    if (!isText(f.dest)) fail(name, 'each files[] entry needs a non-empty "dest"');
    if (f.exec !== undefined && typeof f.exec !== 'boolean') fail(name, `files[].exec must be boolean ("${f.dest}")`);
    if (escapes(f.dest)) fail(name, `dest escapes the target directory: "${f.dest}"`);
    if (!fs.existsSync(path.join(dir, f.src))) fail(name, `files[].src not found: "${f.src}"`);
  }
  const badVars = m.vars !== undefined && (m.vars === null || typeof m.vars !== 'object' || Array.isArray(m.vars));
  if (badVars) fail(name, '"vars" must be an object of PLACEHOLDER → description');
  for (const [k, d] of Object.entries(m.vars || {})) if (!isText(d)) fail(name, `vars.${k} needs a description`);
  // Optional PLACEHOLDER → default-value map applied at install so the shipped config works out of
  // the box (an empty string is a legal default — "substitute nothing"). Missing defaults still warn.
  const badDefaults = m.defaults !== undefined && (m.defaults === null || typeof m.defaults !== 'object' || Array.isArray(m.defaults));
  if (badDefaults) fail(name, '"defaults" must be an object of PLACEHOLDER → default value');
  for (const [k, v] of Object.entries(m.defaults || {})) if (typeof v !== 'string') fail(name, `defaults.${k} must be a string`);
  return { ...m, dir };
}

// core.hooksPath elsewhere → git ignores .git/hooks entirely: the hook never runs while a
// presence check still passes. Say so at install time.
export function hooksPathWarning(root, dests) {
  const hooks = dests.map(toPosix).filter((d) => HOOK_DIR_RE.test(d));
  if (hooks.length === 0) return null;
  let set = '';
  try {
    const r = spawnSync('git', ['config', '--get', 'core.hooksPath'], { cwd: root, encoding: 'utf-8' });
    set = toPosix((r.stdout || '').trim()).replace(/\/$/, '');
  } catch { return null; }
  const stray = hooks.filter((d) => !d.startsWith(`${set || HOOKS}/`));
  if (stray.length === 0) return null;
  return set
    ? `git core.hooksPath is "${set}", so git ignores ${HOOKS} entirely — ${stray.join(', ')} will NEVER run. Install into ${set}/ or unset core.hooksPath.`
    : `git runs hooks from ${HOOKS} only — ${stray.join(', ')} will NEVER run until: git config core.hooksPath ${path.dirname(stray[0])}`;
}

// Never clobber without `force`; escape-check every dest before the first write.
// `merge` hardens an EXISTING json/yaml dest in place via the additive config-merge
// engine (adds missing keys, never overwrites a user's value). merge and force are
// mutually exclusive — merge wins, because it can never destroy content.
export function installPack(name, cwd, { force = false, merge = false, templatesDir = TEMPLATES_DIR } = {}) {
  const clobber = merge ? false : force;
  const pack = loadPack(name, templatesDir);
  const root = path.resolve(cwd);
  // Declared defaults seed the substitution map; the runtime PROJECT_NAME always wins over any
  // default of the same name. A placeholder absent here still lands in `unresolved` and warns.
  const defaults = pack.defaults || {};
  // Computed install-time placeholders. A pack that hardcodes a date ships an
  // already-stale artifact after that day; {{EXPIRES_90D}} resolves to today +
  // 90d AT INSTALL, so the guards manifest's own expiry gate starts fresh
  // instead of failing CI on day one. Kept out of `defaults` so it is never
  // reported as an applied default needing operator review.
  const in90d = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const vars = { ...defaults, EXPIRES_90D: in90d, PROJECT_NAME: path.basename(root) };
  const applied = new Set();
  const planned = pack.files.map((f) => {
    const target = path.resolve(root, f.dest);
    if (!target.startsWith(root + path.sep)) fail(name, `dest escapes the target directory: "${f.dest}"`);
    return { ...f, target };
  });
  const results = [];
  const unresolved = new Set();
  // Substitute a pack file's {{VARS}}, tracking applied defaults / unresolved placeholders.
  const substitute = (src) => fs.readFileSync(path.join(pack.dir, src), 'utf-8').replace(/\{\{([A-Z0-9_]+)\}\}/g, (match, key) => {
    if (key in vars) {
      if (key in defaults && key !== 'PROJECT_NAME') applied.add(key); // a declared default was used
      return vars[key];
    }
    unresolved.add(key); // never write a placeholder out blank — report it instead
    return match;
  });
  for (const f of planned) {
    const exists = fs.existsSync(f.target);
    const format = formatForPath(f.target);
    // Harden in place: MERGE the pack's keys into an existing mergeable dest. A pack body
    // that won't parse as its format, or an existing dest the engine refuses (corrupt /
    // not an object), falls back to a skip — never a clobber, never a corrupt write.
    if (exists && merge && (format === 'json' || format === 'yaml')) {
      let hardening;
      try {
        const raw = substitute(f.src);
        hardening = format === 'yaml' ? YAML.parse(raw) : JSON.parse(raw);
      } catch {
        results.push({ dest: f.dest, status: 'skipped' });
        continue;
      }
      const merged = mergeConfig(fs.readFileSync(f.target, 'utf-8'), hardening, { format });
      if (!merged.ok) {
        results.push({ dest: f.dest, status: 'skipped' });
        continue;
      }
      if (merged.changed) fs.writeFileSync(f.target, merged.text, 'utf-8');
      results.push({ dest: f.dest, status: merged.changed ? 'merged' : 'merged (no change)', conflicts: merged.conflicts });
      continue;
    }
    if (exists && !clobber) {
      results.push({ dest: f.dest, status: 'skipped' });
      continue;
    }
    const body = substitute(f.src);
    fs.mkdirSync(path.dirname(f.target), { recursive: true });
    fs.writeFileSync(f.target, body, 'utf-8');
    if (isExec(f)) fs.chmodSync(f.target, 0o755);
    results.push({ dest: f.dest, status: 'written' });
  }
  const warn = hooksPathWarning(root, planned.map((f) => f.dest));
  const appliedDefaults = [...applied].map((k) => ({ key: k, value: defaults[k] }));
  return { pack, results, unresolved: [...unresolved], appliedDefaults, warnings: warn ? [warn] : [] };
}

/** Report exactly what was written and which checks it targets — verify, don't trust. */
export function formatInstallReport({ pack, results, unresolved, appliedDefaults = [], warnings = [] }, cwd) {
  const execs = new Set(pack.files.filter(isExec).map((f) => f.dest));
  const label = (r) => {
    if (r.status === 'written') return `  written${execs.has(r.dest) ? ' (+x)' : ''}  ${r.dest}`;
    if (r.status === 'merged' || r.status === 'merged (no change)') return `  ${r.status}  ${r.dest}`;
    return `  skipped (exists)  ${r.dest}`;
  };
  const out = results.map(label);
  // Additive merge never overwrites a value the user already set — name each kept key so
  // the operator sees exactly what the pack did NOT change.
  for (const r of results) {
    for (const c of r.conflicts || []) out.push(`    kept your existing ${c.path} (pack wanted ${JSON.stringify(c.incoming)})`);
  }
  if (results.some((r) => r.status === 'skipped')) out.push('  Re-run with --force to overwrite, or --merge to add missing keys in place.');
  // Defaults resolved to a working baseline — no longer "unresolved", but the operator should review
  // and narrow them (e.g. widen a deny-all allow-list only to the hosts the project truly needs).
  for (const d of appliedDefaults) out.push(`  applied default {{${d.key}}} = ${d.value} — review before relying on it.`);
  for (const k of unresolved) out.push(`  warning: no value for {{${k}}} — edit it by hand.`);
  for (const w of warnings) out.push(`  WARNING: ${w}`);
  out.push(`  Targets checks: ${pack.checks.join(', ') || '(none)'}`);
  return `${pack.name} → ${path.resolve(cwd)}\n${out.join('\n')}\n`;
}

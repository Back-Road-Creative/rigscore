import fs from 'node:fs';
import path from 'node:path';
import { getRegisteredFixes } from './checks/index.js';
import { listPacks, loadPack, installPack, formatInstallReport, TEMPLATES_DIR } from './cli/packs.js';
import { SEVERITY, GOVERNANCE_FILES } from './constants.js';
import { readFileSafe, collectGovernanceDirFiles, committedConfigScanPaths } from './utils.js';

/**
 * Safe auto-remediation for rigscore findings.
 *
 * Fixes are self-registered by check modules (via named `fixes` export arrays)
 * and collected during loadChecks(). This module reads them from checks/index.js
 * via getRegisteredFixes().
 *
 * Matching precedence (2026-04-20, Moat & Ship Agent A):
 *   1. If the fixer declares `findingIds: string[]`, match any finding whose
 *      `findingId` appears in that list. This is the preferred form — immune
 *      to title rewording.
 *   2. Otherwise, fall back to the legacy `fixer.match(finding)` predicate.
 *      Legacy matchers typically use title substring checks; rewording a
 *      check's finding title silently orphans the fix, so a deprecation warn
 *      is emitted the first time a legacy matcher is used in a process.
 *
 * There are two remediation sources, and callers must keep them distinct in
 * their output — they are two different consents, not one. A file-level auto-fix
 * (findApplicableFixes / applyFixes, above) repairs a red check in a file that
 * already exists; a pack install (findApplicablePacks / installPacks, below)
 * scaffolds a whole starter baseline of files the repo never had. `--yes` means
 * "don't prompt me" and unlocks only the first; scaffolding requires the caller's
 * explicit `--install-packs` opt-in.
 *
 * Never modifies governance content: an auto-fix is append-only, and a pack
 * install writes NEW files only — installPack is never called with `force`, so
 * an existing file is reported `skipped (exists)` and left byte-for-byte alone.
 */

const warnedLegacyMatchers = new Set();

// ---------------------------------------------------------------------------
// Core-module fixers (RS-26). These live here rather than in their check
// modules because the check files are owned by other concerns; the matching is
// by findingId (immune to title rewording), and every apply() is mechanical and
// non-destructive — it strips invisible bytes, flips an executable bit, or fills
// a missing key into a file that ALREADY exists.
//
// Hard contract (test/fixer-pack-gate.test.js): `--fix` NEVER creates a file the
// repo did not already have. Installing a governance baseline is a separate,
// explicit consent — `--install-packs`. Every fixer below is therefore
// edit-in-place only: an absent target is a no-op skip, never a scaffold.
// ---------------------------------------------------------------------------

// Invisible / control code points that carry steganographic payloads (NOT
// homoglyphs, which are visible letters and lossy to strip): zero-width
// (U+200B-200D, U+2060, U+FEFF), bidi override (U+202A-202E, U+2066-2069) and
// tag chars (U+E0001-E007F). Built from ranges so this source holds no literal
// invisible byte. Mirrors unicode-steganography ZERO_WIDTH/BIDI/TAG_CHARS regexes.
const HIDDEN_UNICODE_RANGES = [
  [0x200B, 0x200D], [0x2060, 0x2060], [0xFEFF, 0xFEFF],
  [0x202A, 0x202E], [0x2066, 0x2069], [0xE0001, 0xE007F],
];
const HIDDEN_UNICODE_RE = new RegExp(
  '[' + HIDDEN_UNICODE_RANGES.map(([a, b]) => (a === b
    ? `\\u{${a.toString(16)}}`
    : `\\u{${a.toString(16)}}-\\u{${b.toString(16)}}`)).join('') + ']', 'gu');

// Starter deny list filled into an EXISTING settings.json that declares none.
const CLAUDE_SETTINGS_DENY_SCAFFOLD = [
  'Bash(rm -rf*)',
  'Bash(curl*)',
  'Bash(wget*)',
  'Read(.env)',
  'Read(**/.env)',
  'Read(**/secrets/**)',
];

/** Extract the env-var key from a credential-storage finding (`env.<KEY> …`). */
function envKeyFromFinding(finding) {
  const m = /\benv\.([A-Za-z_][A-Za-z0-9_.-]*)/.exec(String(finding?.detail || ''));
  return m ? m[1] : null;
}

const LOCAL_FIXERS = {
  // Strip zero-width / bidi-override / tag Unicode from every governance and
  // committed-config file (the same surface unicode-steganography scans). The
  // finding carries no file path, so this re-scans the surface and only rewrites
  // files that actually change — idempotent.
  'unicode-steganography-strip': {
    id: 'unicode-steganography-strip',
    findingIds: [
      'unicode-steganography/bidi-override',
      'unicode-steganography/zero-width',
      'unicode-steganography/tag-chars',
    ],
    description: 'Strip zero-width / bidi-override / tag Unicode from governance and config files',
    async apply(cwd) {
      const targets = [
        ...GOVERNANCE_FILES.map((r) => path.join(cwd, r)),
        ...committedConfigScanPaths().map((r) => path.join(cwd, r)),
        ...(await collectGovernanceDirFiles(cwd)).map((g) => g.full),
      ];
      let fixed = false;
      for (const full of targets) {
        const content = await readFileSafe(full);
        if (content === null) continue;
        const cleaned = content.replace(HIDDEN_UNICODE_RE, '');
        if (cleaned !== content) {
          await fs.promises.writeFile(full, cleaned);
          fixed = true;
        }
      }
      return fixed;
    },
  },

  // Flip the executable bit on a git hook git refuses to run because it is not +x.
  'git-hook-executable': {
    id: 'git-hook-executable',
    findingIds: ['git-hooks/hook-not-executable'],
    description: 'chmod +x on a non-executable git hook',
    async apply(cwd) {
      if (process.platform === 'win32') return false;
      let fixed = false;
      for (const hook of ['pre-commit', 'pre-push']) {
        const full = path.join(cwd, '.git', 'hooks', hook);
        try {
          const stat = await fs.promises.stat(full);
          if (!stat.isFile() || stat.size === 0) continue;
          if ((stat.mode & 0o111) === 0) {
            await fs.promises.chmod(full, 0o755);
            fixed = true;
          }
        } catch { /* hook absent — skip */ }
      }
      return fixed;
    },
  },

  // Fill a starter permissions.deny list into a settings.json the repo ALREADY
  // has and that declares no deny list. No settings file → no-op (creating one
  // is a pack install, behind --install-packs). An existing deny list is the
  // operator's governance and is never rewritten.
  'claude-settings-deny-scaffold': {
    id: 'claude-settings-deny-scaffold',
    findingIds: ['infrastructure-security/no-deny-list'],
    description: 'Add a starter permissions.deny list to an existing .claude/settings.json',
    async apply(cwd) {
      const target = path.join(cwd, '.claude', 'settings.json');
      let raw;
      try { raw = await fs.promises.readFile(target, 'utf-8'); } catch { return false; }
      let settings;
      try { settings = JSON.parse(raw); } catch { return false; }
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return false;
      const existing = settings.permissions?.deny;
      if (Array.isArray(existing) && existing.length > 0) return false;
      settings.permissions = { ...(settings.permissions || {}), deny: [...CLAUDE_SETTINGS_DENY_SCAFFOLD] };
      await fs.promises.writeFile(target, JSON.stringify(settings, null, 2) + '\n');
      return true;
    },
  },

  // Append a `${VAR}` placeholder for a plaintext client-config credential to an
  // `.env.example` the repo ALREADY has, so the operator can move the secret out.
  // No `.env.example` → no-op (creating one is a new file). Append-only; never
  // rewrites the live (home) config, which would destroy the real secret.
  'credential-storage-env-var-scaffold': {
    id: 'credential-storage-env-var-scaffold',
    findingIds: ['credential-storage/plaintext-credential-in-client-config'],
    description: 'Append a ${VAR} placeholder to an existing .env.example for a plaintext credential',
    async apply(cwd, _homedir, finding) {
      const key = envKeyFromFinding(finding);
      if (!key) return false;
      const varName = key.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');
      if (!varName) return false;
      const target = path.join(cwd, '.env.example');
      let content;
      try { content = await fs.promises.readFile(target, 'utf-8'); } catch { return false; }
      const declared = content.split('\n').some((l) => l.split('=')[0].trim() === varName);
      if (declared) return false;
      const newline = content && !content.endsWith('\n') ? '\n' : '';
      await fs.promises.writeFile(target, content + newline + `${varName}=\n`);
      return true;
    },
  },
};

/**
 * Resolve all available fixers: self-registered from check modules, plus the
 * core-module fixers defined above (RS-26). Registered fixers take precedence on
 * an id collision (there are none today).
 */
function resolveFixers() {
  return { ...LOCAL_FIXERS, ...getRegisteredFixes() };
}

/**
 * Return true when the given fixer matches the given finding. Consults
 * `fixer.findingIds` (preferred) first; falls back to `fixer.match()` with a
 * one-shot deprecation warning per fixer id per process.
 */
function fixerMatches(id, fixer, finding) {
  // Preferred path: explicit findingId equality. Immune to title rewording.
  if (Array.isArray(fixer.findingIds) && fixer.findingIds.length > 0) {
    if (finding && finding.findingId && fixer.findingIds.includes(finding.findingId)) {
      return true;
    }
  }
  // Fallback: legacy title-substring matcher. Emits a one-shot deprecation
  // warning the first time it is consulted for a given fixer in this process.
  if (typeof fixer.match === 'function') {
    const matched = fixer.match(finding);
    if (matched) {
      if (!warnedLegacyMatchers.has(id)) {
        warnedLegacyMatchers.add(id);
        process.stderr.write(
          `rigscore: fixer "${id}" matched via legacy title-substring predicate. ` +
          `Prefer findingId equality — set findingId on the finding and list it ` +
          `in fixer.findingIds to avoid silent fix orphaning if the title changes.\n`,
        );
      }
      return true;
    }
  }
  return false;
}

/**
 * Analyze scan results and return a list of applicable fixes.
 * Each fix: { id, description, finding }
 */
export function findApplicableFixes(results) {
  const allFixers = resolveFixers();
  const fixes = [];
  for (const checkResult of results) {
    for (const finding of checkResult.findings) {
      for (const [id, fixer] of Object.entries(allFixers)) {
        if (fixerMatches(id, fixer, finding)) {
          fixes.push({ id, description: fixer.description, finding, checkId: checkResult.id });
        }
      }
    }
  }
  return fixes;
}

/**
 * Apply fixes. Returns { applied: string[], skipped: string[] }.
 */
export async function applyFixes(fixes, cwd, homedir) {
  const allFixers = resolveFixers();
  const applied = [];
  const skipped = [];

  for (const fix of fixes) {
    const fixer = allFixers[fix.id];
    if (!fixer) {
      skipped.push(fix.description);
      continue;
    }
    try {
      // Pass the matched finding so finding-driven fixers (e.g. the coherence
      // MCP-server declaration) can read fields off it. File-discovery fixers
      // that ignore the third arg are unaffected.
      const success = await fixer.apply(cwd, homedir, fix.finding);
      if (success) {
        applied.push(fix.description);
      } else {
        skipped.push(fix.description + ' (already applied or not applicable)');
      }
    } catch (err) {
      skipped.push(fix.description + ` (error: ${err.message})`);
    }
  }

  return { applied, skipped };
}

/** A finding is RED — worth remediating — only at critical or warning. */
const RED = new Set([SEVERITY.CRITICAL, SEVERITY.WARNING]);

/**
 * Analyze scan results and return the packs that remediate a red finding.
 *
 * A pack claims the check ids it turns green in `pack.json.checks`; a check
 * with at least one critical/warning finding is red. The intersection is the
 * offer. Pure — writes nothing, which is exactly what `--fix`'s dry run needs.
 *
 * Each entry: { name, description, checks, targets } where `targets` are the
 * red check ids this pack claims (a subset of `checks`).
 */
export function findApplicablePacks(results, templatesDir = TEMPLATES_DIR) {
  const redCheckIds = new Set(
    (results || [])
      .filter((r) => (r.findings || []).some((f) => RED.has(f && f.severity)))
      .map((r) => r.id),
  );
  if (redCheckIds.size === 0) return [];

  const packs = [];
  for (const name of listPacks(templatesDir)) {
    let pack;
    try {
      pack = loadPack(name, templatesDir);
    } catch {
      continue; // A malformed manifest must not break --fix; `init` reports it loudly.
    }
    const targets = pack.checks.filter((id) => redCheckIds.has(id));
    if (targets.length > 0) {
      packs.push({ name, description: pack.description, checks: pack.checks, targets });
    }
  }
  return packs;
}

/**
 * Install the given packs into `cwd`. Only ever called behind `--yes
 * --install-packs` (or `init --<pack>`) — never as a side effect of `--yes`.
 *
 * Passes `merge` (never `force`): a missing dest is written, an EXISTING
 * json/yaml config is hardened in place by the additive config-merge engine
 * — the pack's absent keys are added, a value the operator already set is kept
 * and reported as a conflict, and a corrupt / non-mergeable dest falls back to
 * a skip. Same non-destructive semantics as `init --merge`; never rewrites a
 * value the operator wrote. Returns { installed: string[], skipped: string[] }
 * — the installed entries are formatted per-pack reports naming every file as
 * `written`, `merged`, or `skipped (exists)`.
 */
export function installPacks(packs, cwd, templatesDir = TEMPLATES_DIR) {
  const installed = [];
  const skipped = [];
  for (const p of packs) {
    try {
      // merge (not force): add missing files, harden existing configs additively, never clobber
      const report = installPack(p.name, cwd, { templatesDir, merge: true });
      installed.push(formatInstallReport(report, cwd).trimEnd());
    } catch (err) {
      skipped.push(`${p.name} (error: ${err.message})`);
    }
  }
  return { installed, skipped };
}

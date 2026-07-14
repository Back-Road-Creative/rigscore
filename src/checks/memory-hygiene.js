import fs from 'node:fs';
import path from 'node:path';
import { calculateCheckScore } from '../scoring.js';
import { NOT_APPLICABLE_SCORE, GOVERNANCE_FILES } from '../constants.js';
import { readFileSafe, statSafe, walkDirSafe } from '../utils.js';

// Thresholds and the reasoning behind them: docs/checks/memory-hygiene.md.
// 40 KB ≈ 10k tokens ≈ 5% of a 200k-token window. Override per-repo with
// `memoryHygiene.budgetBytes` in .rigscorerc.json (DEFAULTS in src/config.js).
const BUDGET_BYTES = 40_000;
const MIN_BODY_CHARS = 20; // non-whitespace body chars; below this it's a stub

// Duplicate-rule detection is deliberately conservative: a false "these are the
// same rule" is worse than a miss. Only near-exact normalized equality counts,
// and a line must carry this many normalized chars before it can match at all —
// boilerplate ("never.", "run the tests") can't collide by accident.
const MIN_RULE_CHARS = 40;
const MAX_DUPLICATE_FINDINGS = 10;
const MAX_GOVERNANCE_BYTES = 1_048_576;

// The index file, and the entries it can carry. Only a markdown link to a `.md`
// target counts as an index entry. A `[[wikilink]]` deliberately does NOT: agent
// memory prose forward-references a memory that has no file yet, and calling that
// a dead entry is a false positive on a convention the ecosystem allows — a miss
// is cheaper. Non-`.md` targets and external URLs are references, not topic files.
const INDEX_BASENAME = 'MEMORY.md';
const MD_LINK_RE = /\[[^\]]*\]\(([^)\s]+)\)/g;
const URI_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const MAX_INDEX_FINDINGS = 10;

// Governance lives outside the root set too: a monorepo states package-local
// rules in `packages/<pkg>/CLAUDE.md`, and a user states machine-wide ones in
// `~/.claude/CLAUDE.md`. Both are loaded alongside memory, so both can be a
// rule's other home. Vendored and fixture trees are skipped — a dependency's
// or a test sample's CLAUDE.md is not this project's governance, and matching
// against one would be a false "two homes" on a rule the project never wrote.
const GOVERNANCE_BASENAMES = new Set(GOVERNANCE_FILES.map((f) => path.basename(f)));
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.venv', 'venv', '__pycache__',
  'dist', 'build', 'coverage', 'vendor', 'fixtures',
]);
const MAX_GOVERNANCE_FILES = 100;

const readdirSafe = async (dir) => {
  try { return await fs.promises.readdir(dir); } catch { return []; }
};

/**
 * The auto-loaded bundle: every `.md` under a memory dir, plus a project-level
 * `MEMORY.md` index. Home (`~/.claude/memory`, `~/.claude/projects/<slug>/memory`) is
 * scanned only under --include-home-skills — the opt-in gate instruction-effectiveness
 * and skill-files use.
 */
async function discoverMemory(cwd, homedir, includeHomeSkills) {
  const roots = [path.join(cwd, '.claude', 'memory')];
  if (includeHomeSkills && homedir && homedir !== cwd) {
    roots.push(path.join(homedir, '.claude', 'memory'));
    const projects = path.join(homedir, '.claude', 'projects');
    for (const slug of await readdirSafe(projects)) {
      roots.push(path.join(projects, slug, 'memory'));
    }
  }

  const files = new Map();
  const add = async (full) => {
    if (files.has(full)) return;
    const stat = await statSafe(full);
    if (!stat || !stat.isFile()) return;
    const content = stat.size === 0 ? '' : (await readFileSafe(full)) ?? '';
    files.set(full, { full, rel: path.relative(cwd, full) || full, content, bytes: stat.size });
  };
  for (const root of roots) {
    for (const e of await readdirSafe(root)) {
      if (e.endsWith('.md')) await add(path.join(root, e));
    }
  }
  await add(path.join(cwd, 'MEMORY.md'));
  await add(path.join(cwd, '.claude', 'MEMORY.md'));
  return { files: [...files.values()], roots };
}

/**
 * The topic files a `MEMORY.md` index points at: markdown links to `.md` targets,
 * outside fenced code (a fenced example is a sample, not an entry). External URLs
 * are dropped, and an `#anchor` is trimmed before the path is resolved.
 */
function indexEntries(content) {
  const targets = [];
  let inFence = false;
  for (const raw of content.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(raw.trim())) { inFence = !inFence; continue; }
    if (inFence) continue;
    for (const [, href] of raw.matchAll(MD_LINK_RE)) {
      const target = href.trim().replace(/#.*$/, '');
      if (!target || URI_SCHEME_RE.test(target)) continue;
      if (target.toLowerCase().endsWith('.md')) targets.push(target);
    }
  }
  return targets;
}

/** True when `full` resolves at or beneath `parent` — no `../` escape, no other volume. */
function within(parent, full) {
  const rel = path.relative(parent, full);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Normalize one line to a comparable rule: drop the list marker, markdown
 * emphasis/backticks, and all punctuation; lowercase; collapse whitespace.
 * `- **Staging never on `/tmp`** — tmpfs.` → `staging never on tmp tmpfs`.
 */
function normalizeRule(line) {
  return line
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
    .replace(/[`*_~]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Every rule-bearing unit of a markdown file, normalized: each eligible line,
 * plus each *wrapped block* — a bullet or paragraph continued on the following
 * line — joined back into one. The join is what lets a rule hard-wrapped in one
 * file match the same rule written on one line in the other; it stays exact
 * equality after normalization, never a similarity score. A block ends at a
 * blank line, heading, fence, table row, or the next list marker, so two
 * separate bullets are never glued into one rule.
 *
 * Headings, fenced code, table rows, and link-only lines are skipped — they
 * duplicate for structural reasons, not because a rule has two homes. Returns a
 * Map of normalized text → first raw line, so a repeat within one file counts once.
 */
function ruleLines(content) {
  const rules = new Map();
  const remember = (raw) => {
    const norm = normalizeRule(raw);
    if (norm.length < MIN_RULE_CHARS) return;
    if (!rules.has(norm)) rules.set(norm, raw);
  };

  let inFence = false;
  let block = [];
  const flush = () => {
    if (block.length > 1) remember(block.join(' '));
    block = [];
  };

  for (const raw of content.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (/^(```|~~~)/.test(trimmed)) { flush(); inFence = !inFence; continue; }
    if (inFence) continue;
    if (trimmed === '' || /^#{1,6}\s/.test(trimmed) || trimmed.startsWith('|')) { flush(); continue; }
    if (/^(?:[-*+]|\d+[.)])\s+/.test(trimmed)) flush(); // a new list item starts a new block
    const body = trimmed.replace(/^(?:[-*+]|\d+[.)])\s+/, '');
    if (/^!?\[[^\]]*\]\([^)]*\)$/.test(body) || /^https?:\/\/\S+$/.test(body)) { flush(); continue; }
    remember(trimmed);
    block.push(trimmed);
  }
  flush();
  return rules;
}

/**
 * Every governance file whose rules could be a memory file's other home:
 * the root set, every nested governance file in the project tree (monorepo
 * package rules), and — only under --include-home-skills, the same gate the
 * memory scan uses — the user's home governance. Returns `{ paths, truncated,
 * depthTruncated }`, where `paths` is full path → display label.
 *
 * `truncated`/`depthTruncated` are `walkDirSafe`'s signals that the nested walk gave
 * up early — at MAX_GOVERNANCE_FILES or at the directory-depth cap — so `paths` is an
 * INCOMPLETE picture of where the project states its rules. Note the file cap counts
 * *matched* governance files, not files walked — `walkDirSafe` gates on the
 * post-`shouldInclude` list.
 *
 * `config.limits.maxWalkDepth` is honored — the same knob sibling deep-secrets reads.
 * The depth-cap disclosure below tells the operator to raise it; the walk took no
 * config at all, so that advice was false and the knob inert. `|| 50` is `walkDirSafe`'s
 * own default, so an unset knob walks exactly as deep as it always has.
 */
async function governancePaths(cwd, homedir, includeHomeSkills, config) {
  const paths = new Map();
  for (const rel of GOVERNANCE_FILES) paths.set(path.join(cwd, rel), rel);

  const { files, truncated, depthTruncated } = await walkDirSafe(cwd, {
    skipDirs: SKIP_DIRS,
    maxFiles: MAX_GOVERNANCE_FILES,
    maxDepth: config?.limits?.maxWalkDepth || 50,
    shouldInclude: (full) => GOVERNANCE_BASENAMES.has(path.basename(full)),
  });
  for (const full of files) {
    if (!paths.has(full)) paths.set(full, path.relative(cwd, full) || full);
  }

  if (includeHomeSkills && homedir && homedir !== cwd) {
    paths.set(path.join(homedir, '.claude', 'CLAUDE.md'), '~/.claude/CLAUDE.md');
    paths.set(path.join(homedir, 'CLAUDE.md'), '~/CLAUDE.md');
  }
  return { paths, truncated, depthTruncated };
}

/** `{ byRule, truncated, depthTruncated }` — normalized rule → set of governance files
 *  stating it, plus whether the walk that found them gave up early — at the file cap or
 *  the depth cap (see `governancePaths`). */
async function collectGovernanceRules(cwd, homedir, includeHomeSkills, config) {
  const byRule = new Map();
  const { paths, truncated, depthTruncated } = await governancePaths(cwd, homedir, includeHomeSkills, config);
  for (const [full, label] of paths) {
    const stat = await statSafe(full);
    if (!stat || !stat.isFile() || stat.size > MAX_GOVERNANCE_BYTES) continue;
    const content = (await readFileSafe(full)) ?? '';
    for (const norm of ruleLines(content).keys()) {
      if (!byRule.has(norm)) byRule.set(norm, new Set());
      byRule.get(norm).add(label);
    }
  }
  return { byRule, truncated, depthTruncated };
}

/** 'empty' (no content), 'stub' (frontmatter/heading, no body), or null. */
function staleKind(content) {
  if (content.trim() === '') return 'empty';
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').replace(/^#{1,6}\s.*$/gm, '');
  return body.replace(/\s/g, '').length < MIN_BODY_CHARS ? 'stub' : null;
}

export default {
  id: 'memory-hygiene',
  enforcementGrade: 'mechanical',
  name: 'Agent memory hygiene',
  category: 'governance',

  async run(context) {
    const { cwd, homedir, config, includeHomeSkills } = context;
    const findings = [];
    const configured = config?.memoryHygiene?.budgetBytes;
    const budgetBytes = Number.isInteger(configured) && configured > 0 ? configured : BUDGET_BYTES;
    const { files: memFiles, roots } = await discoverMemory(cwd, homedir, includeHomeSkills);
    const totalBytes = memFiles.reduce((sum, f) => sum + f.bytes, 0);
    const data = {
      memoryFiles: memFiles.length, totalBytes, budgetBytes,
      emptyFiles: 0, stubFiles: 0, duplicateRules: 0, unresolvableIndexEntries: 0,
      homeScanned: Boolean(includeHomeSkills),
    };

    // No memory surface at all — most repos. N/A, not zero.
    if (memFiles.length === 0) {
      const skipped = { severity: 'skipped', title: 'No agent memory files found' };
      return { score: NOT_APPLICABLE_SCORE, findings: [skipped], data };
    }

    // 1. Budget — memory is re-injected every turn, so the overage is billed per request.
    const kb = (n) => `${(n / 1000).toFixed(1)} KB`;
    if (totalBytes > budgetBytes) {
      findings.push({
        findingId: 'memory-hygiene/bundle-over-budget',
        severity: 'warning',
        title: `Memory bundle is ${kb(totalBytes)} — over the ${kb(budgetBytes)} budget`,
        detail: `${memFiles.length} memory files total ${totalBytes.toLocaleString()} bytes against a ${budgetBytes.toLocaleString()}-byte budget. Auto-loaded memory is re-injected on every turn, so the overage is billed on every request.`,
        evidence: `${memFiles.length} files, ${totalBytes.toLocaleString()} bytes`,
        remediation: 'Consolidate overlapping files, delete resolved incidents, move rarely-needed detail into on-demand docs.',
      });
    }

    // 2. Stale content — an empty or stub file is dead weight, still loaded every session.
    for (const file of memFiles) {
      const kind = staleKind(file.content);
      if (!kind) continue;
      const empty = kind === 'empty';
      data[empty ? 'emptyFiles' : 'stubFiles']++;
      findings.push({
        findingId: 'memory-hygiene/stale-memory-file',
        severity: empty ? 'warning' : 'info',
        title: `${empty ? 'Empty' : 'Stub'} memory file: ${file.rel}`,
        detail: `${file.rel} is ${empty ? 'empty' : 'a bare stub — frontmatter and/or a heading, no body'}. It teaches the agent nothing but is still loaded every session.`,
        evidence: `${file.rel} (${file.bytes} bytes)`,
        remediation: `Write it out, or delete ${file.rel} and its index entry.`,
      });
    }

    // 3. Single home per rule — a rule stated in both a governance file and a
    // memory file has two homes, so editing one silently fails to take effect.
    // Governance is the root set + nested project files + (opt-in) home.
    const { byRule: govRules, truncated: govTruncated, depthTruncated: govDepthTruncated } = await collectGovernanceRules(cwd, homedir, includeHomeSkills, config);
    if (govRules.size > 0) {
      for (const file of memFiles) {
        for (const [norm, raw] of ruleLines(file.content)) {
          const govFiles = govRules.get(norm);
          if (!govFiles) continue;
          data.duplicateRules++;
          if (data.duplicateRules > MAX_DUPLICATE_FINDINGS) continue;
          const homes = [...govFiles].join(', ');
          const snippet = raw.length > 80 ? `${raw.slice(0, 80)}…` : raw;
          findings.push({
            findingId: 'memory-hygiene/duplicate-rule',
            severity: 'info',
            title: `Rule has two homes: ${file.rel} restates ${homes}`,
            detail: `"${snippet}" is stated in ${homes} and again in ${file.rel}. One rule, two homes: an edit to one copy silently fails to take effect, and both are loaded every session.`,
            evidence: `${file.rel} ↔ ${homes}`,
            remediation: `Keep the rule in ${homes} and let ${file.rel} carry only what governance can't — the incident, the evidence, the why.`,
          });
        }
      }
    }

    // A capped governance walk read only SOME of the places a rule can live, so a rule
    // with a second home past the cap is unreportable. Disclose it: without this, the
    // check scored a clean 100 and printed "memory is within budget and free of stale
    // files" over exactly that.
    //
    // INFO, deliberately NOT the WARNING the other truncation disclosures use. This walk
    // feeds exactly one finding — `duplicate-rule`, itself INFO — so an unread governance
    // file can conceal nothing worse than an INFO, and the disclosure is priced in the
    // same currency as the thing it stands in for. WARNING would over-price it twice
    // over: it costs 15 against a hidden 2, and (the real damage) it would switch OFF the
    // INFO_ONLY_FLOOR, which `calculateCheckScore` applies only while warningCount === 0
    // — so a big monorepo would be docked harder for being big than a repo is for
    // actually having the duplicated rules. The deduction is not what removes the lie;
    // the suppressed PASS below is, because any finding at all makes `findings.length`
    // non-zero. Truncation cannot make this check N/A: that gate is `memFiles.length`,
    // decided by `discoverMemory` before this walk ever runs.
    if (govTruncated || govDepthTruncated) {
      findings.push({
        findingId: 'memory-hygiene/governance-file-cap-reached',
        severity: 'info',
        title: 'Governance scan stopped early (cap reached)',
        detail: `The nested-governance walk stopped early (${MAX_GOVERNANCE_FILES}-file limit and/or directory-depth limit), so governance files past the cap were never read. A memory rule whose other home sits in one of them cannot be reported — this result is not a clean bill of health for duplicate rules.`,
        evidence: `governance walk truncated; the tree holds more than was read`,
        remediation: `Move vendored or generated trees out of the scan, or reduce nesting / raise \`limits.maxWalkDepth\`, so the whole governance surface fits under the caps.`,
      });
    }

    // 4. Every index entry resolves to a memory file the scan can see. Topic files are
    // discovered by DIRECTORY, so an entry pointing outside every memory root — or at
    // nothing at all — is never reconciled against anything: the memory it names is
    // silently never loaded. The index's own directory counts as in-scope, so a root
    // `MEMORY.md` may index the topic files sitting beside it.
    for (const file of memFiles) {
      if (path.basename(file.full) !== INDEX_BASENAME) continue;
      const indexDir = path.dirname(file.full);
      const scopes = [indexDir, ...roots];
      for (const target of indexEntries(file.content)) {
        const full = path.resolve(indexDir, target);
        const stat = await statSafe(full);
        const missing = !stat || !stat.isFile();
        if (!missing && scopes.some((scope) => within(scope, full))) continue;
        data.unresolvableIndexEntries++;
        if (data.unresolvableIndexEntries > MAX_INDEX_FINDINGS) continue;
        findings.push({
          findingId: 'memory-hygiene/unresolvable-index-entry',
          severity: missing ? 'warning' : 'info',
          title: missing
            ? `Dead index entry: ${file.rel} links ${target}, which does not exist`
            : `Index entry outside the memory directory: ${file.rel} links ${target}`,
          detail: missing
            ? `${file.rel} indexes ${target}, but no file resolves there. The index promises a memory that can never load — a silent capability loss, not an error anyone sees.`
            : `${file.rel} indexes ${target}, which resolves outside every scanned memory directory. Topic files are loaded by directory, so this one is never bundled with memory and never counted against the budget.`,
          evidence: `${file.rel} → ${target}`,
          remediation: missing
            ? `Write ${target}, or drop its entry from ${file.rel}.`
            : `Move the file into the memory directory the index lives in, or drop its entry from ${file.rel}.`,
        });
      }
    }

    if (findings.length === 0) {
      findings.push({ severity: 'pass', title: 'Agent memory is within budget and free of stale files' });
    }
    return { score: calculateCheckScore(findings), findings, data };
  },
};
